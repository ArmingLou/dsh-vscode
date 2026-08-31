// test/proxy.test.ts — 面板嵌入代理（DshProxy）的单元测试（本地假 dsh 服务器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { DshProxy } from '../src/service/proxy';

const DSH_HTML = '<!doctype html><html><head><script>window.__DSH_BOOT__ = {}</script></head><body></body></html>';

interface FakeDsh {
  server: http.Server;
  port: number;
  token: string;
  /** 收到的请求记录（url + 关键头），供断言转发行为 */
  requests: { url: string; headers: http.IncomingHttpHeaders }[];
  /** 撤销全部已签发会话（模拟服务重启/令牌失效） */
  revokeSessions(): void;
  close(): Promise<void>;
}

/**
 * 模拟新版 dsh：GET /?token=X → 303 + Set-Cookie（dsh-auth-*）；之后所有请求
 * （首页与 API）都必须携带已签发的会话 Cookie，否则 401；API 额外校验 Host 为
 * 127.0.0.1:port 且无 Origin/sec-fetch-site 跨站特征（isTrustedApiRequest 语义）。
 */
function serveFakeDsh(): Promise<FakeDsh> {
  return new Promise((resolve) => {
    const token = 'TOKEN123';
    const sessions = new Set<string>();
    const requests: FakeDsh['requests'] = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url ?? '', headers: req.headers });
      const url = new URL(req.url ?? '/', 'http://dsh.invalid');
      if (url.pathname === '/') {
        // 令牌交换：有效令牌 → 303 + 签发会话 Cookie
        if (url.searchParams.get('token') === token) {
          const value = `SESSION-${sessions.size + 1}`;
          sessions.add(value);
          res.writeHead(303, {
            location: '/',
            'set-cookie': `dsh-auth-test=${value}; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict`,
          });
          res.end();
          return;
        }
        // 首页：需会话 Cookie
        if (sessions.has(sessionValue(req.headers.cookie))) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(DSH_HTML);
          return;
        }
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('dsh web authentication required');
        return;
      }
      // API 路由：需会话 Cookie + Host 围栏通过（origin/sec-fetch-site 已被代理剥离）
      if (sessions.has(sessionValue(req.headers.cookie))) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(401);
      res.end('unauthorized');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        token,
        requests,
        revokeSessions: () => sessions.clear(),
        close: () => new Promise((r) => {
          server.closeAllConnections?.(); // 兜底：释放 keep-alive/升级残留连接，避免 close 等待
          server.close(() => r());
        }),
      });
    });
  });
}

function sessionValue(cookie: string | undefined): string {
  if (!cookie) return '';
  const m = /dsh-auth-test=([^;]+)/.exec(cookie);
  return m ? m[1] : '';
}

/** WebSocket 握手 accept 值（RFC 6455） */
function wsAccept(key: string): string {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

/**
 * 最小 WS 回显服务端（挂在 fake dsh 的 upgrade 上）：校验会话 Cookie + Host + 无 Origin，
 * 接受升级后回显客户端文本帧（只处理 len<126 的掩码帧），正确响应 close 帧（opcode 8）。
 */
function attachWsEcho(server: http.Server, dsh: FakeDsh): void {
  server.on('upgrade', (req, socket, head) => {
    dsh.requests.push({ url: req.url ?? '', headers: req.headers });
    // 鉴权：与 dsh 语义一致（会话 Cookie + Host 围栏 + 剥离 Origin）
    if (!sessionValue(req.headers.cookie) || req.headers.host !== `127.0.0.1:${dsh.port}` || req.headers.origin !== undefined) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 11\r\n\r\nunauthorized');
      return;
    }
    const key = String(req.headers['sec-websocket-key'] ?? '');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    if (head.length > 0) socket.write(head);
    echoFrames(socket);
  });
}

/** 最小 WS 帧回显：文本帧回显、close 帧回应并关闭；只处理单个帧（FIN=1, masked, len<126） */
function echoFrames(socket: Duplex): void {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const len = buffer[1] & 0x7f;
      if (len >= 126) return; // 测试只发小消息
      const masked = (buffer[1] & 0x80) !== 0;
      const maskLen = masked ? 4 : 0;
      if (buffer.length < 2 + maskLen + len) return;
      const mask = masked ? buffer.subarray(2, 6) : null;
      const payload = buffer.subarray(2 + maskLen, 2 + maskLen + len).map((b, i) => (mask ? b ^ mask[i % 4] : b));
      buffer = buffer.subarray(2 + maskLen + len);
      if (opcode === 0x8) {
        // close 帧：回应 close 并关闭（服务端帧无掩码）
        socket.write(Buffer.from([0x88, len, ...payload]));
        socket.end();
        return;
      }
      // 回显：服务端帧无掩码
      socket.write(Buffer.from([0x81, len, ...payload]));
    }
  });
}

test('启动后：无 Cookie 客户端经代理可访问首页（200 + DSH 标记）', async () => {
  const dsh = await serveFakeDsh();
  const proxy = new DshProxy({ target: { host: '127.0.0.1', port: dsh.port }, token: dsh.token });
  try {
    await proxy.start();
    const res = await fetch(proxy.url, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('__DSH_BOOT__'));
  } finally {
    await proxy.stop();
    await dsh.close();
  }
});

test('转发：注入会话 Cookie、Host 改写为 dsh、剥离 Origin/sec-fetch-site', async () => {
  const dsh = await serveFakeDsh();
  const proxy = new DshProxy({ target: { host: '127.0.0.1', port: dsh.port }, token: dsh.token });
  try {
    await proxy.start();
    // 带跨站特征的请求（模拟 webview 场景）
    const res = await fetch(proxy.url + 'api/rpc', {
      method: 'POST',
      headers: { 'origin': 'http://127.0.0.1:' + new URL(proxy.url).port, 'sec-fetch-site': 'cross-site' },
      body: '{"x":1}',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const forwarded = dsh.requests.find((r) => r.url === '/api/rpc');
    assert.ok(forwarded, '请求应转发到 dsh');
    assert.equal(forwarded.headers['host'], `127.0.0.1:${dsh.port}`, 'Host 应改写为 dsh 地址');
    assert.ok(forwarded.headers['cookie']?.includes('dsh-auth-test='), '应注入会话 Cookie');
    assert.equal(forwarded.headers['origin'], undefined, '应剥离 Origin（否则被 Host/Origin 围栏拒绝）');
    assert.equal(forwarded.headers['sec-fetch-site'], undefined, '应剥离 sec-fetch-site');
  } finally {
    await proxy.stop();
    await dsh.close();
  }
});

test('会话失效（401）：自动重新交换并重试成功', async () => {
  const dsh = await serveFakeDsh();
  const logs: string[] = [];
  const proxy = new DshProxy({ target: { host: '127.0.0.1', port: dsh.port }, token: dsh.token, log: (l) => logs.push(l) });
  try {
    await proxy.start();
    // 首次访问正常
    assert.equal((await fetch(proxy.url)).status, 200);
    // 服务端撤销全部会话（模拟 dsh 重启/令牌轮换）→ 代理应重新交换后重试
    dsh.revokeSessions();
    const res = await fetch(proxy.url);
    assert.equal(res.status, 200, '401 后应自动重新交换会话并重试成功');
    assert.ok((await res.text()).includes('__DSH_BOOT__'));
    assert.ok(logs.some((l) => l.includes('重新交换')));
  } finally {
    await proxy.stop();
    await dsh.close();
  }
});

test('响应剥离 Set-Cookie：webview 不接收、不误解', async () => {
  const dsh = await serveFakeDsh();
  const proxy = new DshProxy({ target: { host: '127.0.0.1', port: dsh.port }, token: dsh.token });
  try {
    await proxy.start();
    const res = await fetch(proxy.url + 'api/rpc', { method: 'POST', body: '{}' });
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await proxy.stop();
    await dsh.close();
  }
});

test('令牌错误：交换失败，start() 抛错（调用方回退直连）', async () => {
  const dsh = await serveFakeDsh();
  const proxy = new DshProxy({ target: { host: '127.0.0.1', port: dsh.port }, token: 'WRONG-TOKEN' });
  try {
    await assert.rejects(() => proxy.start(), /token exchange failed/);
    assert.equal(proxy.listeningPort, 0);
  } finally {
    await proxy.stop();
    await dsh.close();
  }
});

test('stop() 后端口关闭', async () => {
  const dsh = await serveFakeDsh();
  const proxy = new DshProxy({ target: { host: '127.0.0.1', port: dsh.port }, token: dsh.token });
  await proxy.start();
  const url = proxy.url;
  assert.equal((await fetch(url)).status, 200);
  await proxy.stop();
  await assert.rejects(() => fetch(url), /fetch failed|ECONNREFUSED/);
  await dsh.close();
});

test('WebSocket 升级转发：无 Cookie 客户端经代理握手成功并收发帧（DSH 实时通道场景）', async () => {
  const dsh = await serveFakeDsh();
  attachWsEcho(dsh.server, dsh);
  const proxy = new DshProxy({ target: { host: '127.0.0.1', port: dsh.port }, token: dsh.token });
  try {
    await proxy.start();
    const wsUrl = `ws://127.0.0.1:${new URL(proxy.url).port}/api/remote.mux`;
    const ws = new WebSocket(wsUrl);
    const opened = await new Promise<boolean>((resolve, reject) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => reject(new Error('ws open failed'));
    });
    assert.equal(opened, true, '经代理的 WS 握手应成功');
    const echoed = new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(String(e.data));
    });
    ws.send('ping-stream');
    assert.equal(await echoed, 'ping-stream', '帧应经代理双向透传');
    // 等待 close 握手完成（代理需正确透传 close 帧），再收尾
    ws.close();
    await new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
      setTimeout(resolve, 3000); // 兜底：3 秒内未完成也继续
    });
    // 断言上游收到的 upgrade 请求：注入 Cookie、Host 改写、剥离 Origin
    const upgradeReq = dsh.requests.find((r) => r.url === '/api/remote.mux');
    assert.ok(upgradeReq, 'upgrade 应转发到 dsh');
    assert.ok(upgradeReq.headers['cookie']?.includes('dsh-auth-test='), '应注入会话 Cookie');
    assert.equal(upgradeReq.headers['host'], `127.0.0.1:${dsh.port}`, 'Host 应改写为 dsh 地址');
    assert.equal(upgradeReq.headers['origin'], undefined, '应剥离 Origin（否则 WS 升级被围栏拒绝）');
  } finally {
    await proxy.stop();
    await dsh.close();
  }
});
