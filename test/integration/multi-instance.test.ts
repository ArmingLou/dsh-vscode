// test/integration/multi-instance.test.ts — 真实 dsh 多实例（多端口）并发兼容性集成测试
// 无 dsh 命令的环境自动跳过；验证多个实例并存时各自的令牌交换/首页/WebSocket 实时通道互不冲突。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** 启动一个 dsh web 实例，返回端口与令牌（解析 stdout 的 URL 行） */
function startDsh(port: number): Promise<{ proc: ChildProcess; token: string; logs: string[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('dsh', ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs: string[] = [];
    let out = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`dsh ${port} 启动超时\n${logs.join('\n')}`));
    }, 20000);
    proc.stdout?.on('data', (c: Buffer) => {
      const text = c.toString();
      out += text;
      logs.push(`[stdout] ${text.trimEnd()}`);
      const m = /dsh web:\s*https?:\/\/\S+\?token=(\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, token: m[1], logs });
      }
    });
    proc.stderr?.on('data', (c: Buffer) => logs.push(`[stderr] ${c.toString().trimEnd()}`));
  });
}

function wsAccept(key: string): string {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

/** 对某实例做完整健康验证：令牌交换 → 首页 → WS 升级握手 */
async function verifyInstance(port: number, token: string): Promise<void> {
  // 1) 令牌交换
  const exchange = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' });
  assert.equal(exchange.status, 303, `实例 ${port} 令牌交换应 303`);
  const setCookies = exchange.headers.getSetCookie();
  const cookie = setCookies.find((c) => c.startsWith('dsh-auth-'))?.split(';')[0];
  assert.ok(cookie, `实例 ${port} 应签发会话 Cookie`);

  // 2) 首页
  const index = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } });
  assert.equal(index.status, 200, `实例 ${port} 带 Cookie 首页应 200`);
  assert.ok((await index.text()).includes('__DSH_BOOT__'), `实例 ${port} 首页应含 DSH 标记`);

  // 3) WebSocket 实时通道握手（真实 dsh 的 /api/remote.mux）
  const upgraded = await new Promise<boolean>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/remote.mux', method: 'GET',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', cookie },
    });
    req.on('upgrade', (res, socket) => {
      const accept = res.headers['sec-websocket-accept'];
      socket.destroy();
      resolve(accept === wsAccept('dGhlIHNhbXBsZSBub25jZQ=='));
    });
    req.on('response', (res) => {
      res.resume();
      reject(new Error(`实例 ${port} WS 升级被拒: ${res.statusCode}`));
    });
    req.on('error', (e) => reject(e));
    req.end();
  });
  assert.equal(upgraded, true, `实例 ${port} WS 升级应成功`);
}

const hasDsh = spawnSync('dsh', ['--version'], { timeout: 5000 }).status === 0;

test('dsh 多实例（多端口）并发：各自完整健康（交换/首页/WS），互不冲突', { skip: !hasDsh && 'dsh 命令不可用，跳过', timeout: 120000 }, async () => {
  const p1 = await freePort();
  const p2 = await freePort();
  const a = await startDsh(p1);
  const b = await startDsh(p2);
  try {
    await verifyInstance(p1, a.token);
    await verifyInstance(p2, b.token);
    // 双实例并存期间再次验证，确认无相互干扰
    await verifyInstance(p1, a.token);
    await verifyInstance(p2, b.token);
    // 检查日志：无锁/冲突/报错
    for (const [name, inst] of [['A', a], ['B', b]] as const) {
      const errors = inst.logs.filter((l) => /error|lock|busy|conflict|failed/i.test(l) && !/open the default browser/i.test(l));
      assert.equal(errors.length, 0, `${name} 实例日志不应有错误:\n${errors.join('\n')}\n---\n${inst.logs.join('\n')}`);
    }
  } finally {
    a.proc.kill('SIGKILL');
    b.proc.kill('SIGKILL');
  }
});
