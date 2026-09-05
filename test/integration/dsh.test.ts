// test/integration/dsh.test.ts — 真实 dsh web 集成测试
// 无 dsh 命令的环境自动跳过；测试用随机空闲端口，避免打扰 3080。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { probeService } from '../../src/service/detect';
import { createProcessRunner } from '../../src/service/process';
import { ServiceManager } from '../../src/service/manager';

/** 取一个当前空闲的随机端口 */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** dsh 命令是否可用 */
const hasDsh = spawnSync('dsh', ['--version'], { timeout: 5000 }).status === 0;

test('真实 dsh web：启动/复用/停止/意外退出全流程', { skip: !hasDsh && 'dsh 命令不可用，跳过' }, async () => {
  const port = await freePort();
  const runner = createProcessRunner();
  const manager = new ServiceManager(
    { host: '127.0.0.1', port, extraArgs: [], autoStart: true, timeoutMs: 3000, pollMs: 300 },
    { probeService, processRunner: runner, log: () => {}, startTimeoutMs: 20000 },
  );
  try {
    // 1) 自动启动（新版 dsh 动态令牌：地址携带 ?token=，探测需带令牌）
    const s1 = await manager.ensureRunning();
    assert.equal(s1.state, 'ready');
    assert.equal(s1.owned, true);
    const u1 = new URL(s1.url!);
    assert.equal(u1.origin, `http://127.0.0.1:${port}`);
    const token1 = u1.searchParams.get('token') ?? '';
    assert.ok(token1 !== '', '新版 dsh 应解析出访问令牌');
    assert.equal(await probeService('127.0.0.1', port, 3000, token1), 'dsh');
    assert.equal(await probeService('127.0.0.1', port, 3000), 'dsh-unauthenticated', '无令牌探测新版 dsh → 疑似 dsh 未认证（401 + 认证提示）');

    // 1a) 会话 Cookie 探测（跨窗口复用路径）：无令牌但带有效会话 Cookie → dsh
    const exch = await fetch(`http://127.0.0.1:${port}/?token=${token1}`, { redirect: 'manual' });
    const sessionCookie = exch.headers.getSetCookie().find((c) => c.startsWith('dsh-auth-'))?.split(';')[0];
    assert.ok(sessionCookie, '令牌交换应签发会话 Cookie');
    assert.equal(await probeService('127.0.0.1', port, 3000, undefined, sessionCookie), 'dsh', '带会话 Cookie 探测应命中 dsh');
    // 失效 Cookie（伪造值）：仍是未认证 401 → dsh-unauthenticated
    assert.equal(await probeService('127.0.0.1', port, 3000, undefined, 'dsh-auth-fake=stale'), 'dsh-unauthenticated');

    // 1b) 面板嵌入代理：无 Cookie 客户端（模拟 VS Code webview）经代理也能拿到 DSH 页面
    assert.ok(s1.embedUrl, '新版 dsh 应提供面板嵌入代理地址');
    const embedRes = await fetch(s1.embedUrl!, { redirect: 'manual' });
    assert.equal(embedRes.status, 200, '代理应让无 Cookie 客户端直接拿到首页（而非 303/401）');
    assert.ok((await embedRes.text()).includes('__DSH_BOOT__'), '代理返回的应是 DSH 页面');
    // 直连 dsh 的带令牌 URL 对无 Cookie 客户端是 401/303（证明代理确实做了会话注入）
    const directRes = await fetch(s1.url!, { redirect: 'manual' });
    assert.equal(directRes.status, 303, '直连带令牌 URL 应仍是令牌交换 303（代理才持有会话）');

    // 1c) 实时通道（WebSocket /api/remote.mux）：无 Cookie 客户端经代理握手应成功
    // （DSH 前端「连接中…→连接异常」的根因：代理此前不转发 upgrade，socket 被直接关闭）
    const wsOpened = await new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(s1.embedUrl!).port}/api/remote.mux`);
      ws.onopen = () => {
        ws.close();
        resolve(true);
      };
      ws.onerror = () => reject(new Error('ws handshake failed through proxy'));
    });
    assert.equal(wsOpened, true, '经代理的 WS 握手应成功');

    // 2) 幂等复用（不重复启动）：第二次 ensureRunning 后 lastChild 仍指向同一子进程
    const firstChild = runner.lastChild;
    const s2 = await manager.ensureRunning();
    assert.equal(s2.state, 'ready');
    assert.equal(runner.lastChild, firstChild);

    // 3) 停止：服务消失
    await manager.stop();
    assert.equal(await probeService('127.0.0.1', port, 3000), 'down');

    // 4) 再次启动（自愈）：每次启动令牌不同，代理随之重建
    const s3 = await manager.ensureRunning();
    assert.equal(s3.state, 'ready');
    const u3 = new URL(s3.url!);
    const token3 = u3.searchParams.get('token') ?? '';
    assert.ok(token3 !== '' && token3 !== token1, '重启后应重新解析出新令牌');
    assert.equal(await probeService('127.0.0.1', port, 3000, token3), 'dsh');
    assert.ok(s3.embedUrl && s3.embedUrl !== s1.embedUrl, '重启后代理地址应更新');
    assert.equal((await fetch(s3.embedUrl!)).status, 200, '新代理应可用');

    // 5) 意外退出检测：直接杀进程 → 状态回 idle
    runner.lastChild?.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(manager.getSnapshot().state, 'idle');
    assert.equal(await probeService('127.0.0.1', port, 3000), 'down');
  } finally {
    await manager.stop(); // 清理：确保不残留 dsh 进程
    manager.dispose();
  }
});
