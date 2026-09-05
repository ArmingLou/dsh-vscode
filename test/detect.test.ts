// test/detect.test.ts — 端口探测的单元测试（用本地假 HTTP 服务器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { probeService, findFreePort } from '../src/service/detect';

/** 启动本地 HTTP 服务器并返回 { server, port } */
async function serve(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

const DSH_HTML = '<!doctype html><html><head><script>window.__DSH_BOOT__ = {}</script></head><body></body></html>';
const OTHER_HTML = '<!doctype html><html><head><title>Nginx</title></head><body>hi</body></html>';

test('首页含 __DSH_BOOT__ 标记 → dsh', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(DSH_HTML);
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000), 'dsh');
  } finally {
    server.close();
  }
});

test('有响应但不是 DSH → foreign', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(OTHER_HTML);
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000), 'foreign');
  } finally {
    server.close();
  }
});

test('端口无监听 → down', async () => {
  // 先占一个端口再释放，确保该端口此刻无人监听
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  assert.equal(await probeService('127.0.0.1', port, 1000), 'down');
});

test('响应超时 → down', async () => {
  // 只接受连接、永不响应，验证 AbortController 超时生效
  const srv = net.createServer(() => {
    /* 挂起连接，不发任何数据 */
  });
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as AddressInfo).port;
  try {
    assert.equal(await probeService('127.0.0.1', port, 200), 'down');
  } finally {
    srv.close();
  }
});

test('带令牌探测：303 令牌交换（Location:/ + dsh-auth Cookie）→ dsh', async () => {
  const { server, port } = await serve((req, res) => {
    // 模拟新版 dsh：有效令牌 → 303 重定向到干净首页并下发浏览器会话 Cookie
    if (req.url?.startsWith('/?token=')) {
      res.writeHead(303, {
        'location': '/',
        'set-cookie': 'dsh-auth-xxx=yyy; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict',
      });
      res.end();
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000, 'TOKEN123'), 'dsh');
  } finally {
    server.close();
  }
});

test('无令牌探测收到 401（dsh 认证提示）→ dsh-unauthenticated（疑似 dsh 未认证）', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000), 'dsh-unauthenticated');
  } finally {
    server.close();
  }
});

test('令牌为空串（externalToken 设置默认值）→ 按无令牌识别：401 + dsh 认证提示 → dsh-unauthenticated', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  try {
    // 回归：空串曾使 token === undefined 判据失效 → 误判 foreign（静默换端口、不弹三选一）
    assert.equal(await probeService('127.0.0.1', port, 1000, ''), 'dsh-unauthenticated');
    assert.equal(await probeService('127.0.0.1', port, 1000, '   '), 'dsh-unauthenticated');
  } finally {
    server.close();
  }
});

test('令牌为空串 → 按无令牌识别：首页含 __DSH_BOOT__ → dsh（不被当作带令牌请求）', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(DSH_HTML);
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000, ''), 'dsh');
  } finally {
    server.close();
  }
});

test('401 但响应体不含 dsh 认证提示（其他服务的鉴权错误）→ foreign', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('401 Authorization Required');
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000), 'foreign');
  } finally {
    server.close();
  }
});

test('带会话 Cookie 探测：200 + __DSH_BOOT__ → dsh（Cookie 头已送达）', async () => {
  const { server, port } = await serve((req, res) => {
    if (req.headers.cookie === 'dsh-auth-test=SESSION1') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(DSH_HTML);
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000, undefined, 'dsh-auth-test=SESSION1'), 'dsh');
    // Cookie 错误/失效：仍是未认证 401 → dsh-unauthenticated（上层据此清除存储并回退）
    assert.equal(await probeService('127.0.0.1', port, 1000, undefined, 'dsh-auth-test=WRONG'), 'dsh-unauthenticated');
  } finally {
    server.close();
  }
});

test('带令牌但令牌错误（401）→ foreign', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000, 'WRONG'), 'foreign');
  } finally {
    server.close();
  }
});

test('带令牌但 303 非令牌交换（Location 非 /）→ foreign', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(303, { location: '/login' });
    res.end();
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000, 'TOKEN123'), 'foreign');
  } finally {
    server.close();
  }
});

test('诊断日志（log 注入）：foreign/dsh-unauthenticated 记录状态码与响应体片段，down 记录错误信息', async () => {
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };
  // 非 OK 非 401：记录状态码与响应体片段
  const notFound = await serve((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found page');
  });
  try {
    assert.equal(await probeService('127.0.0.1', notFound.port, 1000, undefined, undefined, log), 'foreign');
  } finally {
    notFound.server.close();
  }
  // 无令牌 401 + dsh 认证提示：记录 dsh-unauthenticated 与片段
  const unauth = await serve((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  try {
    assert.equal(await probeService('127.0.0.1', unauth.port, 1000, undefined, undefined, log), 'dsh-unauthenticated');
  } finally {
    unauth.server.close();
  }
  // 无监听端口：down 记录具体错误信息（定位 fetch 缺失/代理劫持等环境差异）
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  const deadPort = (srv.address() as AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  assert.equal(await probeService('127.0.0.1', deadPort, 1000, undefined, undefined, log), 'down');
  // 汇总断言：三类诊断各就各位
  assert.ok(logs.some((l) => l.includes('404') && l.includes('not found page')), 'foreign 应记录状态码与响应体片段');
  assert.ok(logs.some((l) => l.includes('dsh-unauthenticated') && l.includes('authentication required')), '未认证应记录分类与响应体片段');
  assert.ok(logs.some((l) => l.includes('down（')), 'down 应记录错误信息');
  assert.ok(logs.every((l) => l.startsWith('[probe] ')), '诊断日志统一 [probe] 前缀');
});

test('诊断日志（log 缺省）：行为与原版一致（不读非 401 响应体、不产生日志）', async () => {
  const { server, port } = await serve((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('boom');
  });
  try {
    assert.equal(await probeService('127.0.0.1', port, 1000), 'foreign');
  } finally {
    server.close();
  }
});

test('findFreePort：从 startPort+1 起找到第一个空闲端口', async () => {
  const calls: number[] = [];
  const probe = async (_host: string, port: number): Promise<'dsh' | 'foreign' | 'down'> => {
    calls.push(port);
    // 模拟 3081/3082 被占用，3083 空闲
    return port === 3083 ? 'down' : 'foreign';
  };
  const found = await findFreePort('127.0.0.1', 3080, 50, probe);
  assert.equal(found, 3083);
  assert.deepEqual(calls, [3081, 3082, 3083]); // 依序探测，找到即停
});

test('findFreePort：全部候选被占用返回 null', async () => {
  const probe = async (): Promise<'dsh' | 'foreign' | 'down'> => 'foreign';
  assert.equal(await findFreePort('127.0.0.1', 3080, 3, probe), null);
});

test('findFreePort：候选超出 65535 提前停止并返回 null', async () => {
  let calls = 0;
  const probe = async (): Promise<'dsh' | 'foreign' | 'down'> => {
    calls += 1;
    return 'foreign';
  };
  assert.equal(await findFreePort('127.0.0.1', 65535, 10, probe), null);
  assert.equal(calls, 0); // 65536 超出合法范围，一次都不探测
});
