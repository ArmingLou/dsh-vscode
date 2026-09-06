// test/manager.test.ts — 服务管理器状态机的单元测试（假探测 + 假子进程）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ServiceManager,
  isNoOpenStderr,
  extractAuthToken,
  type ManagerDeps,
  type PortConflictDecision,
  type SharedStopAskInfo,
  type UsersRecord,
  type UsersStore,
} from '../src/service/manager';
import type { ProbeResult } from '../src/service/detect';
import type { ChildProcessLike, ProcessRunner } from '../src/service/process';

/** 假子进程（同 process.test.ts 的 FakeChild） */
class FakeChild implements ChildProcessLike {
  pid = 1234;
  killed: string[] = [];
  exitCbs: ((code: number | null) => void)[] = [];
  errorCbs: ((err: Error) => void)[] = [];
  stdoutDataCb: ((chunk: Buffer) => void) | null = null;
  stdout = { on: (_e: 'data', _cb: (chunk: Buffer) => void): void => {
    if (_e === 'data') this.stdoutDataCb = _cb;
  } };
  stderrDataCb: ((chunk: Buffer) => void) | null = null;
  stderr = { on: (_e: 'data', _cb: (chunk: Buffer) => void): void => {
    if (_e === 'data') this.stderrDataCb = _cb;
  } };
  on(event: 'exit' | 'error', cb: (...args: never[]) => void): void {
    if (event === 'exit') this.exitCbs.push(cb as (code: number | null) => void);
    else this.errorCbs.push(cb as (err: Error) => void);
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
  emitExit(code: number | null = null): void {
    for (const cb of [...this.exitCbs]) cb(code);
  }
  emitStdout(text: string): void {
    this.stdoutDataCb?.(Buffer.from(text));
  }
  emitStderr(text: string): void {
    this.stderrDataCb?.(Buffer.from(text));
  }
}

interface Harness {
  manager: ServiceManager;
  probeQueue: ProbeResult[];   // 探测结果队列，取完后循环最后一个
  child: FakeChild | null;
  spawnCount: number;
  spawnOpenInBrowser: boolean[]; // 每次 startDsh 传入的 openInBrowser（用于断言 --no-open 兜底）
  probeCount: number;           // 探测调用次数，用于断言定时器已清理
  probeTokens: (string | null)[]; // 每次探测收到的访问令牌（null=未带令牌）
  probeCookies: (string | null)[]; // 每次探测收到的会话 Cookie（null=未带 Cookie）
  states: string[];             // 记录状态变化序列
  proxyStarts: number;          // 假代理 start() 次数（断言代理生命周期）
  proxyStops: number;           // 假代理 stop() 次数
  proxyCreations: { target: { host: string; port: number }; token: string; initialCookie?: string }[]; // 每次创建的 target/token/cookie
  cookieJar: Map<string, string>; // 内存会话 Cookie 存储（键 host:port；模拟 globalState）
  persistTokenCalls: string[];    // onPersistExternalToken 收到的令牌记录（'token' 决策验证有效后）
  ownerJar: Map<string, number>;  // 内存跨窗口 owner pid 记录（键 host:port；模拟 globalState 的 dsh.ownerPid@…）
  externalKillCalls: number[];    // 强停记录：每次 externalProcess.stop(pid) 收到的 pid
  externalAlive: Map<number, boolean>; // externalProcess.isAlive 的存活覆写（缺省 true=存活）
  usersJar: Map<string, number[]>; // 内存使用者注册表（键 host:port → 使用中窗口 pid 列表；模拟 globalState 的 dsh.users@…）
}

function makeHarness(opts?: Partial<Parameters<ServiceManager['reconfigure']>[0]>, depsOpts?: Partial<ManagerDeps>): Harness {
  const h: Harness = {
    manager: null as unknown as ServiceManager,
    probeQueue: [],
    child: null,
    spawnCount: 0,
    spawnOpenInBrowser: [],
    probeCount: 0,
    probeTokens: [],
    probeCookies: [],
    states: [],
    proxyStarts: 0,
    proxyStops: 0,
    proxyCreations: [],
    cookieJar: new Map(),
    persistTokenCalls: [],
    ownerJar: new Map(),
    externalKillCalls: [],
    externalAlive: new Map(),
    usersJar: new Map(),
  };
  const probeService = async (_host: string, _port: number, _timeoutMs?: number, token?: string, cookie?: string): Promise<ProbeResult> => {
    h.probeCount += 1;
    h.probeTokens.push(token ?? null);
    h.probeCookies.push(cookie ?? null);
    return h.probeQueue.length > 1 ? h.probeQueue.shift()! : h.probeQueue[0];
  };
  const processRunner: ProcessRunner = {
    startDsh: (o) => {
      h.spawnCount += 1;
      h.spawnOpenInBrowser.push(o?.openInBrowser ?? false);
      h.child = new FakeChild();
      return h.child;
    },
    stopChild: async (c) => {
      c.kill('SIGTERM');
      c.kill('SIGKILL');
    },
    lastChild: null,
    // 模拟真实 runner 记录启动命令（manager 据此写「启动命令」日志）
    lastStart: { command: 'node', args: ['bin.js', 'web', '--host', '127.0.0.1', '--port', '3080'] },
  };
  // 默认注入假代理：记录创建参数与生命周期（不占真实端口，保持测试隔离）
  const fakeProxyFactory = (opts: { target: { host: string; port: number }; token: string; initialCookie?: string }) => {
    h.proxyCreations.push({ target: { ...opts.target }, token: opts.token, initialCookie: opts.initialCookie });
    return {
      url: `http://127.0.0.1:${59000 + h.proxyCreations.length}/`,
      // 模拟真实代理：令牌交换后持有会话 Cookie（供上层持久化）；预置 Cookie 模式直接透传
      sessionCookie: opts.initialCookie ?? (opts.token ? `session-${opts.token}` : null),
      start: async () => {
        h.proxyStarts += 1;
      },
      stop: async () => {
        h.proxyStops += 1;
      },
      setToken: async () => {},
    };
  };
  h.manager = new ServiceManager(
    {
      host: '127.0.0.1', port: 3080, extraArgs: [], autoStart: true,
      timeoutMs: 100, pollMs: 5, ...opts,
    },
    {
      probeService,
      processRunner,
      log: () => {},
      startTimeoutMs: 50,
      proxyFactory: fakeProxyFactory,
      // 内存会话 Cookie 存储（模拟 globalState；跨复用路径断言用）
      cookieStore: {
        load: (host, port) => h.cookieJar.get(`${host}:${port}`) ?? null,
        save: (host, port, cookie) => { h.cookieJar.set(`${host}:${port}`, cookie); },
        clear: (host, port) => { h.cookieJar.delete(`${host}:${port}`); },
      },
      // 内存跨窗口 owner pid 记录（模拟 globalState 的 dsh.ownerPid@host:port）
      ownerStore: {
        load: (host, port) => h.ownerJar.get(`${host}:${port}`) ?? null,
        save: (host, port, pid) => { h.ownerJar.set(`${host}:${port}`, pid); },
        clear: (host, port) => { h.ownerJar.delete(`${host}:${port}`); },
      },
      // 假外部进程控制：记录强停调用；isAlive 默认按 externalAlive 覆写（缺省判定存活）
      externalProcess: {
        isAlive: (pid) => h.externalAlive.get(pid) ?? true,
        stop: async (pid) => { h.externalKillCalls.push(pid); },
      },
      // 内存使用者注册表（模拟 globalState 的 dsh.users@host:port；键值直接存 pid 列表）
      usersStore: {
        load: (host, port) => {
          const list = h.usersJar.get(`${host}:${port}`);
          return list === undefined ? null : { extPids: [...list] };
        },
        save: (host, port, record) => { h.usersJar.set(`${host}:${port}`, [...record.extPids]); },
        clear: (host, port) => { h.usersJar.delete(`${host}:${port}`); },
      },
      // 记录 'token' 决策验证有效后的持久化回调（默认无副作用；需要决策的用例在 depsOpts 注入 askPortConflict）
      onPersistExternalToken: (token) => { h.persistTokenCalls.push(token); },
      // 持久日志镜像默认静音：manager 的 persistLog 会把退出路径关键分支同步落
      // consoleLog（生产为 console.log → exthost 日志）；测试默认丢弃避免污染输出，
      // 需要断言日志的用例覆写收集。
      consoleLog: () => {},
      // 关闭退出复查窗口（≤0=跳过）：既有用例保持 v0.3.11 前时序；复查逻辑由专测覆盖
      exitRecheckDelayMs: 0,
      ...depsOpts,
    },
  );
  h.manager.onChange((s) => h.states.push(s.state));
  return h;
}

test('探测到 dsh：直接复用（owned=false），不启动子进程', async () => {
  const h = makeHarness();
  h.probeQueue = ['dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false);
  assert.equal(s.url, 'http://127.0.0.1:3080/');
  assert.equal(h.spawnCount, 0);
  assert.deepEqual(h.states, ['detecting', 'ready']);
  h.manager.dispose();
});

test('探测到外来服务：failed + err.portOccupied', async () => {
  const h = makeHarness();
  h.probeQueue = ['foreign'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.portOccupied');
  assert.equal(h.spawnCount, 0);
  h.manager.dispose();
});

test('端口被占用：自动临时替换端口、弹窗通知、用新端口启动就绪', async () => {
  const logs: string[] = [];
  const fallbackCalls: [number, number][] = [];
  const h = makeHarness(undefined, {
    log: (line) => logs.push(line),
    onPortFallback: (a, b) => fallbackCalls.push([a, b]),
  });
  // 初始探测 foreign → 候选 3081 探测 down → spawn 后等待循环探测 dsh
  h.probeQueue = ['foreign', 'down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.error, null);
  assert.equal(s.url, 'http://127.0.0.1:3081/'); // 运行时替换为临时端口
  assert.deepEqual(fallbackCalls, [[3080, 3081]]); // 弹窗通知（requested, fallback）
  assert.ok(logs.some((l) => l.includes('临时改用端口 3081')));
  assert.ok(logs.some((l) => l.includes('启动命令'))); // 记录实际启动命令
  h.manager.dispose();
});

test('端口被占用且候选端口全部被占用：failed + err.portOccupied，不弹窗', async () => {
  const fallbackCalls: [number, number][] = [];
  const h = makeHarness(undefined, { onPortFallback: (a, b) => fallbackCalls.push([a, b]) });
  h.probeQueue = ['foreign']; // 全部候选（50 个）探测循环返回 foreign
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.portOccupied');
  assert.equal(h.spawnCount, 0);
  assert.equal(fallbackCalls.length, 0);
  h.manager.dispose();
});

test('端口被占用且 autoStart=false：直接报占用，不替换端口', async () => {
  const fallbackCalls: [number, number][] = [];
  const h = makeHarness({ autoStart: false }, { onPortFallback: (a, b) => fallbackCalls.push([a, b]) });
  h.probeQueue = ['foreign'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.portOccupied');
  assert.equal(h.spawnCount, 0);
  assert.equal(fallbackCalls.length, 0);
  h.manager.dispose();
});

test('服务未运行且 autoStart=false：failed + err.notRunning', async () => {
  const h = makeHarness({ autoStart: false });
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.notRunning');
  assert.equal(h.spawnCount, 0);
  h.manager.dispose();
});

test('自动启动成功：down,down,dsh → ready(owned=true)，状态序列正确', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.equal(h.spawnCount, 1);
  assert.deepEqual(h.states, ['detecting', 'starting', 'waiting', 'ready']);
  h.manager.dispose();
});

test('启动超时：failed + err.startTimeout', async () => {
  const h = makeHarness();
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.startTimeout');
  assert.equal(s.errorVars?.seconds, 0); // startTimeoutMs=50 → round(50/1000)=0（真实环境为 15 秒）
  h.manager.dispose();
});

test('等待中子进程退出且换端口无望（候选全被占）：failed + err.startCrashed', async () => {
  const h = makeHarness();
  // 初始探测 down → spawn；崩溃后自愈探测 down；findFreePort 候选探测 foreign（全被占）→ 报启动崩溃
  h.probeQueue = ['down', 'down', 'foreign'];
  const p = h.manager.ensureRunning();
  // 第一次探测后子进程已 spawn，模拟崩溃
  await new Promise((r) => setTimeout(r, 1));
  h.child?.emitExit(1);
  const s = await p;
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.startCrashed');
  h.manager.dispose();
});

test('等待中子进程退出且端口被抢占（非 dsh）：自动换端口重启 → ready', async () => {
  const logs: string[] = [];
  const fallbackCalls: [number, number][] = [];
  const h = makeHarness(undefined, {
    log: (line) => logs.push(line),
    onPortFallback: (a, b) => fallbackCalls.push([a, b]),
  });
  // 初始探测 down → spawn#1；首轮轮询 down；崩溃后自愈探测 down；findFreePort 候选 3081 down → 换端口；
  // 递归 doStart 探测 3081 down → spawn#2；等待循环探测 dsh → ready
  h.probeQueue = ['down', 'down', 'down', 'down', 'down', 'dsh'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  h.child?.emitExit(1); // 模拟启动期间端口被抢占（如 WSL/Windows localhost 共享冲突）
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.error, null);
  assert.equal(s.url, 'http://127.0.0.1:3081/'); // 运行时替换为临时端口
  assert.deepEqual(fallbackCalls, [[3080, 3081]]); // 弹窗通知
  assert.equal(h.spawnCount, 2); // 换端口后重新启动一次
  assert.ok(logs.some((l) => l.includes('启动期间被抢占') && l.includes('3081')));
  h.manager.dispose();
});

test('等待中子进程退出但端口已有 dsh（残留实例自愈）：复用 → ready(owned=false)', async () => {
  const h = makeHarness();
  // 第一次探测 down → spawn；等待循环首轮轮询 down；子进程崩溃后的自愈探测命中 dsh
  h.probeQueue = ['down', 'down', 'dsh'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  h.child?.emitExit(1); // 模拟新实例因 EADDRINUSE 崩溃退出
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false); // 复用外部（残留）服务，插件不拥有它
  assert.equal(s.error, null);
  h.manager.dispose();
});

test('ready 后子进程意外退出：回到 idle（面板据此显示已断开）', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  h.child?.emitExit(1);
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.equal(h.manager.getSnapshot().url, null);
  h.manager.dispose();
});

test('spawn 报 ENOENT：failed + err.dshNotFound（不空等超时）', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  // 模拟 dsh 命令不存在
  const err = Object.assign(new Error('spawn dsh ENOENT'), { code: 'ENOENT' });
  for (const cb of h.child!.errorCbs) cb(err);
  const s = await p;
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.dshNotFound');
  h.manager.dispose();
});

test('error 事件报 EINVAL：failed + err.spawnEinval 且带 cwd（不空等超时）', async () => {
  const h = makeHarness({ cwd: '\\\\wsl.localhost\\Ubuntu\\home' });
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  // 模拟 Windows 上非法 spawn 参数（EINVAL 同步异常经 error 事件异步到达）
  const err = Object.assign(new Error('spawn dsh.cmd EINVAL'), { code: 'EINVAL' });
  for (const cb of h.child!.errorCbs) cb(err);
  const s = await p;
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.spawnEinval');
  assert.equal(s.errorVars?.cwd, '\\\\wsl.localhost\\Ubuntu\\home');
  h.manager.dispose();
});

test('startDsh 同步抛 EINVAL：failed + err.spawnEinval（doStart catch 分支）', async () => {
  const logs: string[] = [];
  const h = makeHarness({ cwd: '\\\\wsl.localhost\\Ubuntu\\home' }, {
    processRunner: {
      startDsh: () => {
        throw Object.assign(new Error('spawn dsh.cmd EINVAL'), { code: 'EINVAL' });
      },
      stopChild: async () => {},
      lastChild: null,
    },
    log: (line) => logs.push(line),
  });
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.spawnEinval');
  assert.equal(s.errorVars?.cwd, '\\\\wsl.localhost\\Ubuntu\\home');
  // 日志应记录 code 与 cwd，且不再误报「未找到命令」
  assert.ok(logs.some((l) => l.includes('code=EINVAL') && l.includes('cwd=\\\\wsl.localhost\\Ubuntu\\home')));
  h.manager.dispose();
});

test('startDsh 抛 NODE_NOT_FOUND（Windows 找不到 node.exe）：failed + err.nodeNotFound', async () => {
  const h = makeHarness(undefined, {
    processRunner: {
      startDsh: () => {
        throw Object.assign(new Error('node.exe not found in PATH (dsh shim at C:\\npm\\dsh.cmd)'), { code: 'NODE_NOT_FOUND' });
      },
      stopChild: async () => {},
      lastChild: null,
    },
  });
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.nodeNotFound'); // 与「未找到 dsh」区分，提示安装/加 PATH Node.js
  h.manager.dispose();
});

test('stop() 只停插件自启的子进程', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  await h.manager.stop();
  assert.deepEqual(h.child!.killed, ['SIGTERM', 'SIGKILL']);
  assert.equal(h.manager.getSnapshot().state, 'idle');
  h.manager.dispose();
});

test('复用外部服务时 stop() 不杀任何进程', async () => {
  const h = makeHarness();
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  await h.manager.stop();
  assert.equal(h.spawnCount, 0);
  assert.equal(h.manager.getSnapshot().state, 'idle');
  h.manager.dispose();
});

test('ensureRunning 并发幂等：只 spawn 一次', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  const [a, b] = await Promise.all([h.manager.ensureRunning(), h.manager.ensureRunning()]);
  assert.equal(a.state, 'ready');
  assert.equal(b.state, 'ready');
  assert.equal(h.spawnCount, 1);
  h.manager.dispose();
});

test('reconfigure 换端口：自启服务先停再按新端口启动', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  const oldChild = h.child!; // 捕获旧子进程引用（reconfigure 重启后 h.child 会指向新子进程）
  h.probeQueue = ['down', 'dsh'];
  const s = await h.manager.reconfigure({
    host: '127.0.0.1', port: 4000, extraArgs: [], autoStart: true, timeoutMs: 100, pollMs: 5,
  });
  assert.equal(s.state, 'ready');
  assert.ok(oldChild.killed.length > 0); // 旧服务确实被停止（SIGTERM+SIGKILL）
  assert.equal(h.manager.getTarget().port, 4000);
  h.manager.dispose();
});

test('启动等待阶段 stop()：立即停掉子进程、流程以 idle 结束（不误报崩溃）', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1)); // 子进程已 spawn，进入 waiting
  await h.manager.stop();
  h.child?.emitExit(1); // 模拟真实 kill 触发的 exit 事件竞态
  const s = await p;
  assert.equal(s.state, 'idle'); // stopRequested 判定先于 childExited，不误报 startCrashed
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.ok(h.child!.killed.length > 0); // 子进程被停掉，无孤儿
  h.manager.dispose();
});

test('复用外部服务失联：健康探测发现后回到 idle（面板显示已断开）', async () => {
  const h = makeHarness({}, { healthIntervalMs: 30 });
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  h.probeQueue = ['down']; // 外部服务失联
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(h.manager.getSnapshot().state, 'idle');
  h.manager.dispose();
});

test('Windows spawn 带 cwd 同步抛 EINVAL 时自动去掉 cwd 重试一次并成功', async () => {
  const logs: string[] = [];
  const receivedCwds: (string | undefined)[] = []; // 记录每次 startDsh 收到的 cwd
  const h = makeHarness({ cwd: 'D:\\work\\项目' }, {
    processRunner: {
      startDsh: (opts) => {
        h.spawnCount += 1;
        receivedCwds.push(opts.cwd);
        if (opts.cwd !== undefined) {
          // 第一次（带 cwd）同步抛 EINVAL，模拟 Windows 上 .cmd 带 cwd 的已知问题
          throw Object.assign(new Error('spawn dsh.cmd EINVAL'), { code: 'EINVAL' });
        }
        // 第二次（去掉 cwd）成功返回子进程
        h.child = new FakeChild();
        return h.child;
      },
      stopChild: async (c) => {
        c.kill('SIGTERM');
        c.kill('SIGKILL');
      },
      lastChild: null,
    },
    log: (line) => logs.push(line),
  });
  h.probeQueue = ['down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.equal(h.spawnCount, 2); // 第一次抛、第二次成功
  assert.deepEqual(receivedCwds, ['D:\\work\\项目', undefined]); // 第二次 cwd 为 undefined
  assert.ok(logs.some((l) => l.includes('回退'))); // 日志应含「回退」相关字样
  h.manager.dispose();
});

test('去掉 cwd 重试仍抛 EINVAL 时置 err.spawnEinval', async () => {
  const logs: string[] = [];
  const receivedCwds: (string | undefined)[] = [];
  const h = makeHarness({ cwd: '\\\\wsl.localhost\\Ubuntu\\home' }, {
    processRunner: {
      startDsh: (opts) => {
        receivedCwds.push(opts.cwd);
        // 无论是否带 cwd 都抛 EINVAL → 降级重试后仍然失败，最终 err.spawnEinval
        throw Object.assign(new Error('spawn dsh.cmd EINVAL'), { code: 'EINVAL' });
      },
      stopChild: async () => {},
      lastChild: null,
    },
    log: (line) => logs.push(line),
  });
  h.probeQueue = ['down'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.spawnEinval');
  assert.equal(s.errorVars?.cwd, '\\\\wsl.localhost\\Ubuntu\\home');
  assert.deepEqual(receivedCwds, ['\\\\wsl.localhost\\Ubuntu\\home', undefined]); // 重试时 cwd 为 undefined
  h.manager.dispose();
});

test('复用外部服务 stop()：清理健康定时器并回到 idle', async () => {
  const h = makeHarness({}, { healthIntervalMs: 30 });
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  await h.manager.stop();
  assert.equal(h.manager.getSnapshot().state, 'idle');
  // 停止后不应再有探测发生：若定时器泄漏，30ms 间隔会在 90ms 内触发约 3 次探测
  const probesBefore = h.probeCount;
  h.probeQueue = ['foreign'];
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(h.probeCount, probesBefore); // 无新增探测 = 定时器已清理
  h.manager.dispose();
});
test('旧版 dsh 不支持 --no-open：识别 stderr 后去掉该参数原端口重启（不级联换端口）', async () => {
  const h = makeHarness({ openInBrowser: false, pollMs: 1 });
  // 探测队列：先给足 'down' 让首次启动进入 waiting（不提前命中 dsh），崩溃后二次启动再命中 'dsh'
  h.probeQueue = ['down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'dsh'];
  const done = h.manager.ensureRunning();

  // 轮询等待首次 spawn（最长 500ms），确保已进入 waiting 且子进程处理器已挂载
  const deadline = Date.now() + 500;
  while (h.spawnCount < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(h.spawnCount, 1, '首次应启动子进程');
  assert.equal(h.spawnOpenInBrowser[0], false, '首次传 openInBrowser=false → 追加 --no-open');
  // stderr 先到（commander 报错），随后子进程退出 —— 模拟真实崩溃顺序
  h.child?.emitStderr("error: unknown option '--no-open'");
  h.child?.emitExit(1);

  const s = await done;
  assert.equal(s.state, 'ready', '应自动去掉 --no-open 后原端口重启并就绪');
  assert.equal(h.spawnCount, 2, '应恰好重试一次（第二次不再带 --no-open）');
  assert.equal(h.spawnOpenInBrowser[1], true, '重试时 openInBrowser=true → 不追加 --no-open');
  h.manager.dispose();
});
test('isNoOpenStderr：仅当 stderr 含 "unknown option" 且 "-no-open" 时判定为 --no-open 不支持（纯函数）', () => {
  assert.equal(isNoOpenStderr("error: unknown option '--no-open'"), true, '旧版 dsh 崩溃文本应命中');
  assert.equal(isNoOpenStderr("Error: listen EADDRINUSE: address already in use"), false, '真实端口占用不误判');
  assert.equal(isNoOpenStderr("dsh: 服务启动失败"), false, '无关报错不误判');
  assert.equal(isNoOpenStderr(""), false);
  assert.equal(isNoOpenStderr("--other --option --no-open is fine"), false, '需同时含 unknown option 才是崩溃标记');
});

test('extractAuthToken：解析 "dsh web: ...?token=..." 启动行（纯函数）', () => {
  assert.equal(extractAuthToken('dsh web: http://127.0.0.1:3080/?token=ABC123\n'), 'ABC123');
  // LAN 附加地址含第二个令牌：只取循环回环地址的令牌
  assert.equal(
    extractAuthToken('dsh web: http://127.0.0.1:3080/?token=ABC123 (LAN: http://192.168.1.2:3080/?token=LAN456)\n'),
    'ABC123',
  );
  assert.equal(extractAuthToken('dsh web: http://127.0.0.1:3080/\n'), null, '旧版 dsh 无令牌');
  assert.equal(extractAuthToken('dsh web: http://127.0.0.1:3080/?token=\n'), null, '空令牌视为未解析');
  assert.equal(extractAuthToken('[stdout] 其它日志\n'), null);
  assert.equal(extractAuthToken(''), null);
});

test('新版 dsh：解析启动行访问令牌 → ready 且 URL 携带 ?token，就绪/健康探测都带令牌', async () => {
  const token = 'G8lxUIZsB9TpX_pZI_2jJG2P1H-yxHqHTChB8qJZOlE';
  const probeTokens: (string | null)[] = [];
  // 模拟新版 dsh：未带令牌探测一律「未就绪」（实际是 401 → foreign），带正确令牌才就绪
  const h = makeHarness(undefined, {
    healthIntervalMs: 30,
    probeService: async (_host, _port, _timeout, t) => {
      probeTokens.push(t ?? null);
      return t === token ? 'dsh' : 'down';
    },
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5)); // 等待 spawn 完成、等待循环已开始
  h.child?.emitStdout(`dsh web: http://127.0.0.1:3080/?token=${token}\n`);
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.equal(s.url, `http://127.0.0.1:3080/?token=${token}`);
  assert.ok(probeTokens.includes(token), '就绪探测应携带解析出的令牌');
  // 面板嵌入代理：以解析出的令牌创建并启动，embedUrl 指向代理
  assert.equal(h.proxyStarts, 1, '应创建并启动一次面板嵌入代理');
  assert.deepEqual(h.proxyCreations[0].token, token, '代理应使用解析出的令牌做交换');
  assert.equal(h.proxyCreations[0].target.port, 3080);
  assert.ok(s.embedUrl?.startsWith('http://127.0.0.1:'), 'ready 应携带面板嵌入地址');
  // 健康探测同样携带令牌：ready 后等一个健康周期，探测参数应始终是令牌而非 null
  const before = probeTokens.length;
  await new Promise((r) => setTimeout(r, 70));
  const healthProbes = probeTokens.slice(before);
  assert.ok(healthProbes.length > 0, '应有健康探测发生');
  assert.ok(healthProbes.every((t) => t === token), '健康探测必须携带令牌（否则 401 被误判为服务失联）');
  h.manager.dispose();
});

test('旧版 dsh（无令牌行）：不创建代理，embedUrl 为 null', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.url, 'http://127.0.0.1:3080/');
  assert.equal(s.embedUrl, null);
  assert.equal(h.proxyStarts, 0, '无令牌时不启动代理');
  h.manager.dispose();
});

test('stop() 后：代理随服务停止，embedUrl 清空', async () => {
  const h = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t) => (t === 'TOK123' ? 'dsh' : 'down'),
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5));
  h.child?.emitStdout('dsh web: http://127.0.0.1:3080/?token=TOK123\n');
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.ok(s.embedUrl);
  await h.manager.stop();
  assert.equal(h.proxyStops, 1, '代理应随服务停止');
  assert.equal(h.manager.getSnapshot().embedUrl, null);
  h.manager.dispose();
});

test('重启后代理重建：新令牌 → 重新创建代理（旧令牌不作数）', async () => {
  const h = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t) => (t === 'TOKEN1' || t === 'TOKEN2' ? 'dsh' : 'down'),
  });
  const p1 = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5));
  h.child?.emitStdout('dsh web: http://127.0.0.1:3080/?token=TOKEN1\n');
  const s1 = await p1;
  assert.equal(s1.state, 'ready');
  assert.equal(h.proxyStarts, 1);

  const p2 = h.manager.restart();
  await new Promise((r) => setTimeout(r, 10));
  h.child?.emitStdout('dsh web: http://127.0.0.1:3080/?token=TOKEN2\n');
  const s2 = await p2;
  assert.equal(s2.state, 'ready');
  assert.equal(h.proxyStarts, 2, '重启后应重建代理');
  assert.equal(h.proxyCreations.length, 2);
  assert.equal(h.proxyCreations[1].token, 'TOKEN2', '新代理应使用新令牌');
  assert.notEqual(h.proxyCreations[0].token, h.proxyCreations[1].token);
  h.manager.dispose();
});

test('externalToken 复用外部实例：探测携带外部令牌 → ready + url 带令牌 + 代理用外部令牌，不新启动', async () => {
  const probeTokens: (string | null)[] = [];
  const h = makeHarness({ externalToken: 'EXT-TOKEN' }, {
    probeService: async (_host, _port, _timeout, t) => {
      probeTokens.push(t ?? null);
      return t === 'EXT-TOKEN' ? 'dsh' : 'down';
    },
  });
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false, '外部实例应被复用而非由插件启动');
  assert.equal(s.url, 'http://127.0.0.1:3080/?token=EXT-TOKEN');
  assert.equal(h.spawnCount, 0, '不应启动子进程');
  assert.ok(probeTokens.includes('EXT-TOKEN'), '首次探测应携带外部令牌');
  assert.ok(s.embedUrl, '外部实例同样需要面板嵌入代理');
  assert.equal(h.proxyCreations[0]?.token, 'EXT-TOKEN', '代理应使用外部令牌做交换');
  h.manager.dispose();
});

test('externalToken 无效（探测 foreign）：回退自动换端口启动插件自有实例（不带外部令牌）', async () => {
  const h = makeHarness({ externalToken: 'WRONG' });
  // 初始探测（带外部令牌）→ foreign → 换 3081 → spawn → 等待循环（无令牌）→ dsh
  h.probeQueue = ['foreign', 'down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true, '外部令牌无效时应启动插件自有实例');
  assert.equal(h.spawnCount, 1);
  assert.equal(s.url, 'http://127.0.0.1:3081/', '自有实例无令牌（旧版语义）→ 裸地址');
  h.manager.dispose();
});

test('externalToken 空串（设置默认值，未配置）→ 归一化为无令牌：401 疑似 dsh → 弹三选一而非静默换端口', async () => {
  // 回归：真实环境 dsh.externalToken 默认 ''，曾使探测携带 token='' → 401 无令牌识别
  // 判据失效 → 疑似 dsh 被误判 foreign → 静默换端口且不弹三选一。
  const probeTokens: (string | null)[] = [];
  let asked = 0;
  let call = 0;
  const h = makeHarness({ externalToken: '' }, {
    probeService: async (_host, _port, _timeout, t) => {
      probeTokens.push(t ?? null);
      call += 1;
      // 第 1 次初始探测 → 疑似 dsh 未认证；第 2 次为 findFreePort 候选（down=空闲）；
      // 之后为等待循环（无令牌旧版语义 dsh → ready）
      return call === 1 ? 'dsh-unauthenticated' : call === 2 ? 'down' : 'dsh';
    },
    askPortConflict: async () => {
      asked += 1;
      return { kind: 'other-port' }; // 明确选择「使用其他端口」才允许换端口
    },
  });
  const s = await h.manager.ensureRunning();
  // harness 的 probeService 会把未带令牌的探测记录为 null（token ?? null），
  // 故此处断言 null 而非 undefined（若归一化被破坏、空串泄漏为 ''，仍会失败，回归检测力不变）
  assert.equal(probeTokens[0], null, '空串 externalToken 必须归一化为无令牌探测（不得泄漏为空串）');
  assert.equal(asked, 1, '空串不得破坏 dsh-unauthenticated 识别：应弹一次三选一');
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true, '选择使用其他端口后才启动自有实例');
  assert.equal(h.spawnCount, 1);
  assert.equal(s.url, 'http://127.0.0.1:3081/');
  h.manager.dispose();
});

test('启动行跨 chunk 到达：令牌仍能解析（有界缓冲累计）', async () => {
  const token = 'SPLIT123';
  const h = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t) => (t === token ? 'dsh' : 'down'),
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5));
  h.child?.emitStdout('dsh web: http://127.0.0.1:3080/?tok'); // 半行：令牌未完整
  await new Promise((r) => setTimeout(r, 10));
  h.child?.emitStdout(`en=${token}\n`); // 补全：应解析出令牌
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.url, `http://127.0.0.1:3080/?token=${token}`);
  h.manager.dispose();
});

test('重启后旧令牌失效：新进程需重新解析令牌（探测不带旧令牌）', async () => {
  const probeTokens: (string | null)[] = [];
  const h = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t) => {
      probeTokens.push(t ?? null);
      return t === 'TOKEN1' || t === 'TOKEN2' ? 'dsh' : 'down';
    },
  });
  const p1 = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5));
  h.child?.emitStdout('dsh web: http://127.0.0.1:3080/?token=TOKEN1\n');
  const s1 = await p1;
  assert.equal(s1.state, 'ready');
  assert.equal(s1.url, 'http://127.0.0.1:3080/?token=TOKEN1');

  const oldChild = h.child!;
  const p2 = h.manager.restart(); // 停旧进程 → 旧令牌应清空 → 新进程需重新解析
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(h.child, oldChild, '应已重新 spawn');
  assert.ok(probeTokens.includes(null), '重启后存在不带令牌的探测（旧令牌已失效）');
  h.child?.emitStdout('dsh web: http://127.0.0.1:3080/?token=TOKEN2\n');
  const s2 = await p2;
  assert.equal(s2.state, 'ready');
  assert.equal(s2.url, 'http://127.0.0.1:3080/?token=TOKEN2'); // 新令牌生效
  assert.ok(probeTokens.includes('TOKEN2'), '就绪探测应携带新令牌');
  h.manager.dispose();
});

test('自有实例令牌交换成功：会话 Cookie 自动持久化（跨窗口复用的凭据来源）', async () => {
  const token = 'OWN-TOKEN';
  const h = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t) => (t === token ? 'dsh' : 'down'),
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5));
  h.child?.emitStdout(`dsh web: http://127.0.0.1:3080/?token=${token}\n`);
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(h.cookieJar.get('127.0.0.1:3080'), `session-${token}`, '交换出的会话 Cookie 应持久化到存储');
  await h.manager.stop(); // 收尾停掉子进程：dispose 才会移除父进程 exit 钩子（避免监听器累积告警）
  h.manager.dispose();
});

test('dsh-unauthenticated：持久化 Cookie 命中 → 复用（owned=false），代理以 Cookie 启动，无需决策', async () => {
  const h = makeHarness({}, { healthIntervalMs: 30 });
  h.cookieJar.set('127.0.0.1:3080', 'dsh-auth-keep=1');
  // 首探（无令牌）→ dsh-unauthenticated；Cookie 探测 → dsh（命中后健康探测持续返回 dsh）
  h.probeQueue = ['dsh-unauthenticated', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false, '复用外来实例，插件不拥有它');
  assert.equal(s.url, 'http://127.0.0.1:3080/', '无令牌复用：地址为裸地址（浏览器直开不可用，面板经代理）');
  assert.equal(h.spawnCount, 0, '不应启动子进程');
  assert.equal(h.proxyCreations[0].initialCookie, 'dsh-auth-keep=1', '代理应以持久化 Cookie 预置启动');
  assert.equal(h.proxyCreations[0].token, '', '无令牌复用：代理不走令牌交换');
  // 健康探测携带会话 Cookie（否则 401 被误判为失联）
  const before = h.probeCount;
  await new Promise((r) => setTimeout(r, 70));
  const healthCookies = h.probeCookies.slice(before);
  assert.ok(healthCookies.length > 0, '应有健康探测发生');
  assert.ok(healthCookies.every((c) => c === 'dsh-auth-keep=1'), '健康探测必须携带会话 Cookie');
  // stop() 只脱钩不清持久化凭据（实例仍在运行，下次启动验证后仍可复用）
  await h.manager.stop();
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.equal(h.cookieJar.get('127.0.0.1:3080'), 'dsh-auth-keep=1', '停止复用不应清除持久化凭据');
  h.manager.dispose();
});

test('dsh-unauthenticated：Cookie 失效 → 清除存储、三选一选择「使用其他端口」、回退启动自有实例并持久化新会话', async () => {
  const token = 'NEW-TOKEN';
  const probeCalls: { port: number; token: string | null; cookie: string | null }[] = [];
  const askCalls: { host: string; port: number; tokenAttemptFailed: boolean }[] = [];
  const h = makeHarness({}, {
    probeService: async (_host, port, _timeout, t, cookie) => {
      probeCalls.push({ port, token: t ?? null, cookie: cookie ?? null });
      if (port === 3080) return 'dsh-unauthenticated'; // 3080 上的外来 dsh：无令牌 401，旧 Cookie 也失效
      return t === token ? 'dsh' : 'down'; // 自有实例（3081）：解析出令牌后才就绪
    },
    askPortConflict: async (info) => {
      askCalls.push({ host: info.host, port: info.port, tokenAttemptFailed: info.tokenAttemptFailed });
      return { kind: 'other-port' };
    },
  });
  h.cookieJar.set('127.0.0.1:3080', 'dsh-auth-stale=1');
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5)); // 等待 spawn 完成、等待循环已开始
  h.child?.emitStdout(`dsh web: http://127.0.0.1:3081/?token=${token}\n`);
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true, '选择换端口后应启动插件自有实例');
  assert.equal(s.url, `http://127.0.0.1:3081/?token=${token}`, '运行时替换为临时端口');
  assert.equal(h.spawnCount, 1);
  assert.equal(h.cookieJar.has('127.0.0.1:3080'), false, '失效的持久化 Cookie 应清除');
  assert.equal(h.cookieJar.get('127.0.0.1:3081'), `session-${token}`, '自有实例交换出的会话应持久化');
  assert.deepEqual(askCalls, [{ host: '127.0.0.1', port: 3080, tokenAttemptFailed: false }], 'Cookie 落空应弹一次三选一');
  assert.ok(probeCalls.some((c) => c.port === 3080 && c.cookie === 'dsh-auth-stale=1'), '应先用存储的旧 Cookie 探测');
  await h.manager.stop(); // 收尾停掉子进程：dispose 才会移除父进程 exit 钩子（避免监听器累积告警）
  h.manager.dispose();
});

test('dsh-unauthenticated：未注入决策回调（旧装配）→ 维持旧行为直接换端口回退', async () => {
  const h = makeHarness();
  // 首探 → dsh-unauthenticated（无 Cookie 可试）→ 候选 3081 down → spawn 后等待循环 dsh
  h.probeQueue = ['dsh-unauthenticated', 'down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.equal(s.url, 'http://127.0.0.1:3081/');
  await h.manager.stop(); // 收尾停掉子进程：dispose 才会移除父进程 exit 钩子（避免监听器累积告警）
  h.manager.dispose();
});

test('dsh-unauthenticated + autoStart=false：不弹三选一，直接报 err.portOccupied（不换端口）', async () => {
  const askCalls: unknown[] = [];
  const h = makeHarness({ autoStart: false }, {
    askPortConflict: async (info) => {
      askCalls.push(info);
      return { kind: 'other-port' };
    },
  });
  h.probeQueue = ['dsh-unauthenticated'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'err.portOccupied');
  assert.equal(h.spawnCount, 0);
  assert.equal(askCalls.length, 0, 'autoStart=false 保持原语义：不弹三选一');
  h.manager.dispose();
});

test('Cookie 复用实例会话失效：健康探测发现后清除持久化 Cookie 并回 idle', async () => {
  const h = makeHarness({}, { healthIntervalMs: 30 });
  h.cookieJar.set('127.0.0.1:3080', 'dsh-auth-stale=1');
  h.probeQueue = ['dsh-unauthenticated', 'dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  h.probeQueue = ['dsh-unauthenticated']; // Cookie 失效（带 Cookie 探测仍 401）
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(h.manager.getSnapshot().state, 'idle', '健康探测未命中应回到 idle');
  assert.equal(h.cookieJar.has('127.0.0.1:3080'), false, '失效 Cookie 应从存储清除');
  h.manager.dispose();
});

test('两个 ServiceManager 共享 Cookie 存储（模拟窗口 A/B）：A 自启就绪即发布 Cookie → B 无令牌探测即复用', async () => {
  const token = 'WIN-A-TOKEN';
  const cookieJar = new Map<string, string>(); // 模拟跨窗口共享的用户级 globalState
  const store = {
    load: (host: string, port: number) => cookieJar.get(`${host}:${port}`) ?? null,
    save: (host: string, port: number, cookie: string) => { cookieJar.set(`${host}:${port}`, cookie); },
    clear: (host: string, port: number) => { cookieJar.delete(`${host}:${port}`); },
  };
  // 窗口 A：自启新版 dsh（动态令牌）——就绪路径应立即完成令牌交换并持久化会话 Cookie
  const a = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t) => (t === token ? 'dsh' : 'down'),
    cookieStore: store,
  });
  const pa = a.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5)); // 等待 spawn 完成、等待循环已开始
  a.child?.emitStdout(`dsh web: http://127.0.0.1:3080/?token=${token}\n`);
  const sa = await pa;
  assert.equal(sa.state, 'ready');
  assert.equal(sa.owned, true);
  assert.equal(cookieJar.get('127.0.0.1:3080'), `session-${token}`, 'A 就绪时应已持久化会话 Cookie（不依赖面板/代理后续创建时机）');

  // 窗口 B：无令牌探测 3080 → 401（疑似 dsh 未认证）→ 以 A 发布的 Cookie 无感复用
  const b = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t, cookie) =>
      cookie === `session-${token}` ? 'dsh' : 'dsh-unauthenticated',
    cookieStore: store,
  });
  const sb = await b.manager.ensureRunning();
  assert.equal(sb.state, 'ready');
  assert.equal(sb.owned, false, 'B 应复用 A 的实例（owned=false，不杀他人进程）');
  assert.equal(sb.url, 'http://127.0.0.1:3080/', '复用后仍为原端口裸地址（面板经代理访问）');
  assert.equal(b.manager.getTarget().port, 3080, '不应换端口');
  assert.equal(b.spawnCount, 0, '不应另起 dsh 实例');
  assert.equal(b.proxyCreations[0]?.initialCookie, `session-${token}`, 'B 的代理应以持久化 Cookie 预置启动');

  await a.manager.stop(); // 收尾停掉 A 的子进程：dispose 才会移除父进程 exit 钩子
  a.manager.dispose();
  b.manager.dispose();
});

test('多窗口同时冷启动竞态：子进程 EADDRINUSE 崩溃 → 自愈探测疑似 dsh → 以共享 Cookie 复用（不换端口、不再 spawn）', async () => {
  const fallbackCalls: [number, number][] = [];
  let crashed = false; // 模拟「另一窗口的 dsh 是否已绑定 3080」
  const h = makeHarness(undefined, {
    onPortFallback: (req, fb) => fallbackCalls.push([req, fb]),
    probeService: async (_host, port, _timeout, _token, cookie) => {
      if (port === 3080) {
        if (cookie === 'dsh-auth-wina=1') return 'dsh'; // 窗口 A 发布的会话 Cookie 命中
        // 崩溃前 A 的 dsh 尚未监听（本窗口探测 down 即另起实例）；崩溃后 3080 已是 A 的 dsh（401）
        return crashed ? 'dsh-unauthenticated' : 'down';
      }
      return 'down'; // 其余候选端口空闲——复用成功时不应被探测到
    },
  });
  h.cookieJar.set('127.0.0.1:3080', 'dsh-auth-wina=1'); // 预置：窗口 A 已就绪并发布 Cookie
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1)); // 等待 spawn 完成、进入 waiting
  crashed = true; // 本窗口子进程因 3080 被 A 的 dsh 先绑定而 EADDRINUSE 崩溃
  h.child?.emitExit(1);
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false, '应以 Cookie 复用另一窗口的实例');
  assert.equal(s.url, 'http://127.0.0.1:3080/');
  assert.equal(h.manager.getTarget().port, 3080, '不应换端口');
  assert.equal(h.spawnCount, 1, '崩溃后不应再 spawn（复用而非换端口重启）');
  assert.equal(fallbackCalls.length, 0, '不应弹换端口通知');
  assert.equal(h.proxyCreations[0]?.initialCookie, 'dsh-auth-wina=1', '代理应以持久化 Cookie 预置启动');
  h.manager.dispose();
});

test('崩溃自愈竞态：对方 Cookie 发布晚一步 → 宽限重试窗口内命中 → 复用（不换端口）', async () => {
  let loadCalls = 0;
  let crashed = false;
  const h = makeHarness(undefined, {
    cookieGraceDelayMs: 1, // 单测缩短宽限间隔
    cookieStore: {
      // 前 2 次读取落空：模拟「绑定端口 → 发布 Cookie」的短暂窗口与跨窗口存储同步延迟
      load: async () => {
        loadCalls += 1;
        return loadCalls >= 3 ? 'dsh-auth-late=1' : null;
      },
      save: async () => {},
      clear: async () => {},
    },
    probeService: async (_host, port, _timeout, _token, cookie) => {
      if (port === 3080) {
        if (cookie === 'dsh-auth-late=1') return 'dsh';
        return crashed ? 'dsh-unauthenticated' : 'down';
      }
      return 'down';
    },
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  crashed = true;
  h.child?.emitExit(1);
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false);
  assert.equal(h.manager.getTarget().port, 3080, '宽限命中后不应换端口');
  assert.equal(h.spawnCount, 1, '不应再 spawn');
  assert.equal(loadCalls, 3, '宽限窗口内应重试读取共享 Cookie');
  h.manager.dispose();
});

test('崩溃自愈后 Cookie 始终缺失：宽限重试耗尽 → 三选一选择「使用其他端口」→ 照旧换端口重启', async () => {
  const fallbackCalls: [number, number][] = [];
  const askCalls: { host: string; port: number; tokenAttemptFailed: boolean }[] = [];
  let crashed = false;
  let probe3081 = 0;
  const h = makeHarness(undefined, {
    cookieGraceDelayMs: 1,
    onPortFallback: (req, fb) => fallbackCalls.push([req, fb]),
    askPortConflict: async (info) => {
      askCalls.push({ host: info.host, port: info.port, tokenAttemptFailed: info.tokenAttemptFailed });
      return { kind: 'other-port' };
    },
    probeService: async (_host, port, _timeout, _token, _cookie) => {
      if (port === 3080) return crashed ? 'dsh-unauthenticated' : 'down';
      // 3081：候选探测（findFreePort）down → 换端口重启的初始探测 down → 等待循环 dsh
      probe3081 += 1;
      return probe3081 >= 3 ? 'dsh' : 'down';
    },
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  crashed = true;
  h.child?.emitExit(1);
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true, '选择换端口后照旧自启');
  assert.equal(s.url, 'http://127.0.0.1:3081/');
  assert.equal(h.spawnCount, 2, '崩溃 + 换端口重启各 spawn 一次');
  assert.deepEqual(fallbackCalls, [[3080, 3081]], '应弹换端口通知');
  assert.deepEqual(askCalls, [{ host: '127.0.0.1', port: 3080, tokenAttemptFailed: false }], '宽限耗尽应弹一次三选一');
  await h.manager.stop(); // 收尾停掉子进程：dispose 才会移除父进程 exit 钩子
  h.manager.dispose();
});

test('三选一「输入令牌重试」：令牌有效 → 复用（owned=false）、URL 带令牌、写入设置回调、不换端口不 spawn', async () => {
  const askCalls: { host: string; port: number; tokenAttemptFailed: boolean }[] = [];
  const h = makeHarness(undefined, {
    askPortConflict: async (info) => {
      askCalls.push({ host: info.host, port: info.port, tokenAttemptFailed: info.tokenAttemptFailed });
      return { kind: 'token', token: 'USER-TOKEN' };
    },
    probeService: async (_host, _port, _timeout, t) => (t === 'USER-TOKEN' ? 'dsh' : 'dsh-unauthenticated'),
  });
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false, '以用户提供的令牌复用外来实例');
  assert.equal(s.url, 'http://127.0.0.1:3080/?token=USER-TOKEN');
  assert.equal(h.manager.getTarget().port, 3080, '不应换端口');
  assert.equal(h.spawnCount, 0, '不应启动子进程');
  assert.equal(askCalls.length, 1, '只问一次');
  assert.deepEqual(h.persistTokenCalls, ['USER-TOKEN'], '验证有效后应回调持久化 dsh.externalToken');
  assert.equal(h.proxyCreations[0]?.token, 'USER-TOKEN', '代理应以用户令牌做交换');
  h.manager.dispose();
});

test('三选一「输入令牌重试」：令牌无效 → 提示后重弹（tokenAttemptFailed=true），第二次令牌有效 → 复用', async () => {
  const askInfos: { tokenAttemptFailed: boolean }[] = [];
  const tokenProbes: (string | null)[] = [];
  const h = makeHarness(undefined, {
    askPortConflict: async (info) => {
      askInfos.push({ tokenAttemptFailed: info.tokenAttemptFailed });
      return askInfos.length === 1 ? { kind: 'token', token: 'BAD' } : { kind: 'token', token: 'GOOD' };
    },
    probeService: async (_host, _port, _timeout, t) => {
      if (t !== undefined) tokenProbes.push(t);
      return t === 'GOOD' ? 'dsh' : 'dsh-unauthenticated';
    },
  });
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false);
  assert.deepEqual(tokenProbes, ['BAD', 'GOOD'], '两个令牌都应被探测验证');
  assert.deepEqual(askInfos.map((i) => i.tokenAttemptFailed), [false, true], '第二次弹窗应提示上次令牌无效');
  assert.deepEqual(h.persistTokenCalls, ['GOOD'], '只有验证有效的令牌才写入设置');
  h.manager.dispose();
});

test('三选一「按原流程重试」：实例已消失 → 原端口自启（owned=true），只问一次', async () => {
  const askCalls: number[] = [];
  let probeCount = 0;
  const h = makeHarness(undefined, {
    askPortConflict: async () => {
      askCalls.push(1);
      return { kind: 'retry' };
    },
    probeService: async () => {
      probeCount += 1;
      // 首探 dsh-unauthenticated（外来实例在）→ retry 重探 down（实例已消失）→ spawn 等待循环 down → dsh
      return probeCount === 1 ? 'dsh-unauthenticated' : probeCount <= 3 ? 'down' : 'dsh';
    },
  });
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true, '实例消失后应原端口自启');
  assert.equal(h.manager.getTarget().port, 3080, '不应换端口');
  assert.equal(h.spawnCount, 1);
  assert.equal(askCalls.length, 1, '只应问一次');
  await h.manager.stop(); // 收尾停掉子进程：dispose 才会移除父进程 exit 钩子
  h.manager.dispose();
});

test('三选一「按原流程重试」：实例仍在占用 → 重弹三选一 → 选择「使用其他端口」回退', async () => {
  const askInfos: { tokenAttemptFailed: boolean }[] = [];
  const h = makeHarness(undefined, {
    askPortConflict: async (info) => {
      askInfos.push({ tokenAttemptFailed: info.tokenAttemptFailed });
      return askInfos.length === 1 ? { kind: 'retry' } : { kind: 'other-port' };
    },
  });
  // 首探 unauth → retry 重探 unauth → 候选 3081 down → spawn 等待循环 dsh
  h.probeQueue = ['dsh-unauthenticated', 'dsh-unauthenticated', 'down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true, '最终换端口自启');
  assert.equal(s.url, 'http://127.0.0.1:3081/');
  assert.equal(askInfos.length, 2, 'retry 后仍占用应重弹三选一');
  await h.manager.stop(); // 收尾停掉子进程：dispose 才会移除父进程 exit 钩子
  h.manager.dispose();
});

test('决策等待期间不落任何回退（dismiss 循环由回调负责重弹）：未选择则不换端口、不 spawn、不报失败', async () => {
  // holder 对象：闭包内赋值 + 事后取用（TS 对 let 闭包捕获的流窄化不随调用重置，对象属性则重置）
  const askState: { resolve: ((d: PortConflictDecision) => void) | undefined } = { resolve: undefined };
  const h = makeHarness(undefined, {
    askPortConflict: () => new Promise<PortConflictDecision>((resolve) => { askState.resolve = resolve; }),
  });
  // 首探 unauth（决策挂起）→ 明确选择「使用其他端口」后：候选 3081 down → spawn 等待循环 dsh
  h.probeQueue = ['dsh-unauthenticated', 'down', 'dsh'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 20)); // 决策挂起期间：不应有任何回退动作
  assert.equal(h.spawnCount, 0, '等待决策期间不应 spawn');
  assert.equal(h.manager.getTarget().port, 3080, '不应换端口');
  assert.notEqual(h.manager.getSnapshot().state, 'failed', '等待决策期间不应报失败');
  const resolveAsk = askState.resolve;
  assert.ok(resolveAsk, '决策回调应已被调用（挂起中）');
  resolveAsk({ kind: 'other-port' });
  const s = await p;
  assert.equal(s.state, 'ready', '明确选择后回退继续（换端口自启）');
  await h.manager.stop(); // 收尾停掉子进程：dispose 才会移除父进程 exit 钩子
  h.manager.dispose();
});

test('决策等待期间 stop()：可中断等待，流程以 idle 结束（用户后续选择被丢弃、不落回退）', async () => {
  const askState: { resolve: ((d: PortConflictDecision) => void) | undefined } = { resolve: undefined };
  const h = makeHarness(undefined, {
    askPortConflict: () => new Promise<PortConflictDecision>((resolve) => { askState.resolve = resolve; }),
  });
  h.probeQueue = ['dsh-unauthenticated'];
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 10)); // 等待进入决策
  await h.manager.stop(); // 等待期间被叫停
  askState.resolve?.({ kind: 'other-port' }); // 用户此刻才选择：结果应被丢弃
  const s = await p;
  assert.equal(s.state, 'idle', '叫停后不得覆盖 stop() 设置的 idle');
  assert.equal(h.spawnCount, 0, '不应 spawn');
  assert.equal(h.manager.getTarget().port, 3080, '不应换端口');
  h.manager.dispose();
});

test('崩溃自愈宽限耗尽 → 三选一「输入令牌重试」：令牌有效 → 复用另一窗口实例（不换端口、不再 spawn）', async () => {
  let crashed = false;
  const h = makeHarness(undefined, {
    cookieGraceDelayMs: 1,
    askPortConflict: async () => ({ kind: 'token', token: 'WINNER-TOKEN' }),
    probeService: async (_host, port, _timeout, t) => {
      if (port === 3080) return t === 'WINNER-TOKEN' ? 'dsh' : crashed ? 'dsh-unauthenticated' : 'down';
      return 'down';
    },
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  crashed = true; // 本窗口子进程因 3080 被「另一窗口的 dsh」先绑定而 EADDRINUSE 崩溃
  h.child?.emitExit(1);
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false, '以用户提供的令牌复用另一窗口实例');
  assert.equal(s.url, 'http://127.0.0.1:3080/?token=WINNER-TOKEN');
  assert.equal(h.manager.getTarget().port, 3080, '不应换端口');
  assert.equal(h.spawnCount, 1, '崩溃后不再 spawn');
  assert.deepEqual(h.persistTokenCalls, ['WINNER-TOKEN'], '验证有效后应回调持久化 dsh.externalToken');
  h.manager.dispose();
});

// —— 「断开面板连接」（disconnectEmbed / ensureEmbed）——
// 用户断开 = 只停窗口嵌入代理 + 清 embedUrl；后端进程/子进程所有权/退出钩子/健康探测语义不变。

test('disconnectEmbed()：只停代理并清 embedUrl，服务保持 ready、子进程不被杀、owned 不变', async () => {
  const h = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t) => (t === 'TOK-DETACH' ? 'dsh' : 'down'),
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5));
  h.child?.emitStdout('dsh web: http://127.0.0.1:3080/?token=TOK-DETACH\n');
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.ok(s.embedUrl, '就绪后应有嵌入代理地址');
  assert.equal(h.proxyStarts, 1);

  await h.manager.disconnectEmbed();
  const after = h.manager.getSnapshot();
  assert.equal(after.state, 'ready', '断开后服务状态保持 ready（后端未被停）');
  assert.equal(after.owned, true, '子进程所有权不变');
  assert.equal(after.url, 'http://127.0.0.1:3080/?token=TOK-DETACH', '后端真实地址不变');
  assert.equal(after.embedUrl, null, '嵌入地址被清空（面板据此显示断开占位页）');
  assert.equal(h.proxyStops, 1, '嵌入代理被停止');
  assert.equal(h.child?.killed.length ?? 0, 0, '绝不能 kill 子进程');
  await h.manager.stop(); // 收尾停掉假子进程（验证 stop 仍正常，语义不被断开影响）
  h.manager.dispose();
});

test('disconnectEmbed() 幂等：代理已停时再次调用不重复 stop、不改变快照', async () => {
  const h = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t) => (t === 'TOK-IDEM' ? 'dsh' : 'down'),
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5));
  h.child?.emitStdout('dsh web: http://127.0.0.1:3080/?token=TOK-IDEM\n');
  await p;
  await h.manager.disconnectEmbed();
  await h.manager.disconnectEmbed();
  assert.equal(h.proxyStops, 1, '第二次断开应为空操作');
  assert.equal(h.manager.getSnapshot().state, 'ready');
  await h.manager.stop();
  h.manager.dispose();
});

test('重连闭环：disconnectEmbed() 后 ensureEmbed() 以原令牌重建代理并恢复 embedUrl（状态流转 ready→停代理→重建）', async () => {
  const h = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t) => (t === 'TOK-RE' ? 'dsh' : 'down'),
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5));
  h.child?.emitStdout('dsh web: http://127.0.0.1:3080/?token=TOK-RE\n');
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(h.proxyStarts, 1);
  await h.manager.disconnectEmbed();
  assert.equal(h.manager.getSnapshot().embedUrl, null);

  await h.manager.ensureEmbed();
  const s2 = h.manager.getSnapshot();
  assert.equal(s2.state, 'ready');
  assert.ok(s2.embedUrl?.startsWith('http://127.0.0.1:'), 'embedUrl 应恢复');
  assert.equal(h.proxyStarts, 2, '应重建代理');
  assert.equal(h.proxyStops, 1, '旧代理不重复停');
  assert.equal(h.proxyCreations[1].token, 'TOK-RE', '重建沿用原令牌（不重启后端）');
  assert.equal(h.child?.killed.length ?? 0, 0, '重连不 kill 子进程');

  await h.manager.ensureEmbed();
  assert.equal(h.proxyStarts, 2, '代理已在时 ensureEmbed 幂等（直接复用）');
  await h.manager.stop();
  h.manager.dispose();
});

test('ensureEmbed()：旧版 dsh（无令牌/无代理）断开与重连均为空操作，embedUrl 保持 null', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh']; // 无令牌 stdout → 旧版直连语义
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.embedUrl, null);
  assert.equal(h.proxyStarts, 0);
  await h.manager.disconnectEmbed();
  await h.manager.ensureEmbed();
  assert.equal(h.proxyStops, 0, '无代理可停');
  assert.equal(h.proxyStarts, 0, '无令牌不建代理');
  assert.equal(h.manager.getSnapshot().embedUrl, null);
  assert.equal(h.manager.getSnapshot().state, 'ready');
  await h.manager.stop();
  h.manager.dispose();
});

// —— 共享服务跨窗口「强制停止」（owner pid 记录 + 复用窗口 stopSharedService）——

// —— owner 记录生命周期（owner 窗口侧写入/清理；模拟 globalState 的 ownerJar）——

test('自启子进程就绪：跨窗口 owner 记录写入 pid；stop() 停掉进程后记录清除', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().owned, true);
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 1234, '就绪时应写入自启子进程 pid（供复用窗口识别归属）');
  await h.manager.stop();
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.equal(h.ownerJar.has('127.0.0.1:3080'), false, '停掉自启进程后应清除 owner 记录');
  h.manager.dispose();
});

test('restart()：先停旧进程清记录，新进程就绪后重新写入 owner pid', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'dsh'];
  await h.manager.ensureRunning();
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 1234);
  h.probeQueue = ['down', 'dsh'];
  const s = await h.manager.restart();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 1234, '重启就绪后记录应重新发布');
  h.manager.dispose();
});

test('自启子进程被外部终止（意外退出）：回 idle、停代理、清 owner 记录（owner 窗口侧自动感知）', async () => {
  const h = makeHarness(undefined, {
    probeService: async (_host, _port, _timeout, t) => (t === 'TOK-A' ? 'dsh' : 'down'),
  });
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 5));
  h.child?.emitStdout('dsh web: http://127.0.0.1:3080/?token=TOK-A\n');
  const s = await p;
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 1234, '就绪应已写 owner 记录');
  assert.equal(h.proxyStarts, 1);
  h.child?.emitExit(1); // 模拟另一窗口强停 kill 了该进程
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.equal(h.proxyStops, 1, '代理随服务停止');
  await new Promise((r) => setTimeout(r, 5)); // 等 void 的异步记录清理完成
  assert.equal(h.ownerJar.has('127.0.0.1:3080'), false, '子进程意外退出应清除 owner 记录');
  h.manager.dispose();
});

test('启动等待期子进程崩溃：不清除 pid 不同的他窗口 owner 记录（clear-if-mine 守卫）', async () => {
  const h = makeHarness();
  h.ownerJar.set('127.0.0.1:3080', 5555); // 另一窗口的 dsh 进程记录（本窗口假子进程 pid=1234）
  h.probeQueue = ['down', 'down', 'foreign']; // 崩溃后自愈失败 → err.startCrashed
  const p = h.manager.ensureRunning();
  await new Promise((r) => setTimeout(r, 1));
  h.child?.emitExit(1);
  const s = await p;
  assert.equal(s.state, 'failed');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 5555, 'pid 不匹配时不得误删他窗口的记录（多窗口冷启动竞态）');
  h.manager.dispose();
});

// —— 复用窗口 stopSharedService（对话框经 deps.askStopReused 注入，决策分支全覆盖）——

test('复用窗口 Stop：无 owner 记录 → 不弹窗、仅脱钩（no-record，维持原行为）', async () => {
  const askCalls: SharedStopAskInfo[] = [];
  const h = makeHarness(undefined, {
    askStopReused: async (info) => { askCalls.push(info); return 'force-stop'; },
  });
  h.probeQueue = ['dsh']; // 复用就绪（owned=false）
  await h.manager.ensureRunning();
  assert.equal(h.manager.getSnapshot().state, 'ready');
  assert.equal(h.manager.getSnapshot().owned, false);
  const outcome = await h.manager.stopSharedService();
  assert.equal(outcome, 'no-record');
  assert.equal(askCalls.length, 0, '无记录不弹对话框');
  assert.equal(h.manager.getSnapshot().state, 'idle', '照旧脱钩');
  assert.equal(h.externalKillCalls.length, 0, '不 kill 任何进程');
  h.manager.dispose();
});

test('复用窗口 Stop：owner 记录 pid 已不存在 → 不弹窗、清失效记录、仅脱钩（gone）', async () => {
  const askCalls: SharedStopAskInfo[] = [];
  const h = makeHarness(undefined, {
    askStopReused: async (info) => { askCalls.push(info); return 'force-stop'; },
  });
  h.ownerJar.set('127.0.0.1:3080', 4242);
  h.externalAlive.set(4242, false); // 记录的进程已死（owner 窗口崩溃残留）
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  const outcome = await h.manager.stopSharedService();
  assert.equal(outcome, 'gone');
  assert.equal(askCalls.length, 0, 'pid 已死不弹强停对话框');
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.equal(h.ownerJar.has('127.0.0.1:3080'), false, '失效记录应顺带清除');
  assert.equal(h.externalKillCalls.length, 0);
  h.manager.dispose();
});

test('复用窗口 Stop：对话框「取消」→ 保持连接，不动记录/代理/进程', async () => {
  const infos: SharedStopAskInfo[] = [];
  const h = makeHarness(undefined, {
    askStopReused: async (info) => { infos.push(info); return 'cancel'; },
  });
  h.ownerJar.set('127.0.0.1:3080', 9999); // 他窗口的存活服务记录
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  const outcome = await h.manager.stopSharedService();
  assert.equal(outcome, 'cancel');
  assert.equal(infos.length, 1);
  assert.equal(infos[0].authority, '127.0.0.1:3080');
  assert.equal(infos[0].pid, 9999);
  assert.equal(h.manager.getSnapshot().state, 'ready', '取消后保持连接');
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 9999, '取消不清 owner 记录');
  assert.equal(h.externalKillCalls.length, 0, '取消不 kill');
  h.manager.dispose();
});

test('复用窗口 Stop：对话框「仅断开本窗口连接」→ 脱钩，但服务与记录保留（不 kill）', async () => {
  const h = makeHarness(undefined, {
    askStopReused: async () => 'detach',
  });
  h.ownerJar.set('127.0.0.1:3080', 9999);
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  const outcome = await h.manager.stopSharedService();
  assert.equal(outcome, 'detach');
  assert.equal(h.manager.getSnapshot().state, 'idle', '本窗口脱钩');
  assert.equal(h.externalKillCalls.length, 0, '仅断开不 kill 共享服务');
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 9999, '服务仍在运行：owner 记录保留，其他窗口仍可识别');
  h.manager.dispose();
});

test('复用窗口 Stop：二次确认强停 → kill 外部 pid、清 owner 记录、停代理、回 idle（force-killed）', async () => {
  const h = makeHarness(undefined, {
    askStopReused: async () => 'force-stop', // 对话框返回「已通过二次确认的强制停止」
  });
  h.cookieJar.set('127.0.0.1:3080', 'dsh-auth-b=1'); // Cookie 复用路径：就绪时建面板代理
  h.ownerJar.set('127.0.0.1:3080', 9999);
  h.probeQueue = ['dsh-unauthenticated', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false);
  assert.equal(h.proxyStarts, 1, '复用就绪应已建面板代理');
  const outcome = await h.manager.stopSharedService();
  assert.equal(outcome, 'force-killed');
  assert.deepEqual(h.externalKillCalls, [9999], '应对 owner 记录的 pid 发强停');
  assert.equal(h.ownerJar.has('127.0.0.1:3080'), false, '强停成功后清 owner 记录');
  assert.equal(h.proxyStops, 1, '代理随脱钩停止');
  assert.equal(h.manager.getSnapshot().state, 'idle');
  h.manager.dispose();
});

test('弹窗期间共享服务进程退出：强停复检不通过 → 回退仅脱钩并清记录（gone），不 kill', async () => {
  let askCalls = 0;
  let aliveChecks = 0;
  const h = makeHarness(undefined, {
    askStopReused: async () => { askCalls += 1; return 'force-stop'; },
    externalProcess: {
      // 预检（弹窗前）存活 → 复检（弹窗后）已死：模拟弹窗期间进程被他人停止
      isAlive: () => { aliveChecks += 1; return aliveChecks === 1; },
      stop: async (pid: number) => { h.externalKillCalls.push(pid); },
    },
  });
  h.ownerJar.set('127.0.0.1:3080', 9999);
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  const outcome = await h.manager.stopSharedService();
  assert.equal(outcome, 'gone');
  assert.equal(askCalls, 1, '预检存活应先弹对话框');
  assert.equal(aliveChecks, 2, '强停前应复检一次');
  assert.equal(h.externalKillCalls.length, 0, '复检失败不得 kill');
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.equal(h.ownerJar.has('127.0.0.1:3080'), false, '失效记录应清除');
  h.manager.dispose();
});

test('强停 kill 抛错（EPERM 等）：kill-failed、本窗口脱钩、owner 记录保留（服务可能仍在运行）', async () => {
  const h = makeHarness(undefined, {
    askStopReused: async () => 'force-stop',
    externalProcess: {
      isAlive: () => true,
      stop: async () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); },
    },
  });
  h.ownerJar.set('127.0.0.1:3080', 9999);
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  const outcome = await h.manager.stopSharedService();
  assert.equal(outcome, 'kill-failed');
  assert.equal(h.manager.getSnapshot().state, 'idle', '失败也照常脱钩');
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 9999, 'kill 失败不清记录');
  h.manager.dispose();
});

test('未注入决策回调（旧装配兜底）：共享服务 Stop 直接脱钩，不弹窗不 kill', async () => {
  const h = makeHarness(); // 不注入 askStopReused
  h.ownerJar.set('127.0.0.1:3080', 9999);
  h.probeQueue = ['dsh'];
  await h.manager.ensureRunning();
  const outcome = await h.manager.stopSharedService();
  assert.equal(outcome, 'detach');
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.equal(h.externalKillCalls.length, 0);
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 9999, '脱钩不动他窗口的服务与记录');
  h.manager.dispose();
});

// —— 「最后一个使用者退出才清理」：跨窗口使用者注册表协议（releaseOnExit）——
// 窗口在 manager 进入 ready 时登记扩展宿主 pid、停止使用/退出时注销；退出清理（releaseOnExit）
// 注销自己 → 过滤死 pid → 仍有其他存活使用者则移交不杀，自己是最后使用者才 kill。

/** 内存使用者注册表 store（两个 manager 共享同一 jar 模拟跨窗口 globalState；值=去重 pid 列表） */
function jarUsersStore(jar: Map<string, number[]>) {
  return {
    load: (host: string, port: number): UsersRecord | null => {
      const list = jar.get(`${host}:${port}`);
      return list === undefined ? null : { extPids: [...list] };
    },
    save: (host: string, port: number, record: UsersRecord): void => {
      jar.set(`${host}:${port}`, [...record.extPids]);
    },
    clear: (host: string, port: number): void => {
      jar.delete(`${host}:${port}`);
    },
  };
}

/** 模拟两个窗口（A/B）的装配：共享 owner 记录、使用者注册表与外部进程控制 */
function makeTwoWindows() {
  const ownerJar = new Map<string, number>();
  const usersJar = new Map<string, number[]>();
  const extKills: number[] = [];
  const dead = new Set<number>(); // externalProcess.isAlive=false 的 pid（模拟崩溃/已死窗口）
  const shared = {
    ownerStore: {
      load: (host: string, port: number) => ownerJar.get(`${host}:${port}`) ?? null,
      save: (host: string, port: number, pid: number) => { ownerJar.set(`${host}:${port}`, pid); },
      clear: (host: string, port: number) => { ownerJar.delete(`${host}:${port}`); },
    },
    usersStore: jarUsersStore(usersJar),
    externalProcess: {
      isAlive: (pid: number) => !dead.has(pid),
      stop: async (pid: number) => { extKills.push(pid); },
    },
  };
  const a = makeHarness(undefined, { selfPid: 9001, ...shared });
  const b = makeHarness(undefined, { selfPid: 9002, ...shared });
  return { a, b, ownerJar, usersJar, extKills, dead };
}

/** 驱动窗口自启就绪（初始探测 down → spawn → 等待循环命中 dsh；owned=true，注册/发布 owner pid） */
async function bootOwned(h: Harness): Promise<void> {
  h.probeQueue = ['down', 'dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
}

/** 驱动窗口复用就绪（初始探测即 dsh；owned=false，登记使用者） */
async function bootReuse(h: Harness): Promise<void> {
  h.probeQueue = ['dsh'];
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, false);
}

test('协议：多窗口共享时 owner 先退出 → 不杀服务进程、置移交标志、owner 记录保留（移交）', async () => {
  const { a, b, ownerJar, usersJar, extKills } = makeTwoWindows();
  await bootOwned(a); // A 自启就绪（owner）
  assert.deepEqual(usersJar.get('127.0.0.1:3080'), [9001], 'A 就绪应登记为使用者');
  assert.equal(ownerJar.get('127.0.0.1:3080'), 1234, 'A 就绪应发布 owner pid（假子进程 pid=1234）');
  await bootReuse(b); // B 复用同一服务
  assert.deepEqual(usersJar.get('127.0.0.1:3080'), [9001, 9002], 'B 就绪应追加登记');
  // A（owner）先退出（模拟 deactivate 主路径 releaseOnExit(true)）：
  await a.manager.releaseOnExit(true);
  assert.deepEqual(extKills, [], 'owner 退出不得 kill 共享服务进程');
  assert.equal(a.child?.killed.length ?? 0, 0, '不得对自启子进程发 kill（SIGTERM/SIGKILL 均不应出现）');
  assert.equal(a.manager.isExitKillSkipped(), true, '应置移交标志（exit 钩子据此跳过兜底杀进程）');
  assert.equal(ownerJar.get('127.0.0.1:3080'), 1234, 'owner 记录保留：供最后退出者按记录定位 kill');
  assert.deepEqual(usersJar.get('127.0.0.1:3080'), [9002], 'A 已注销，B 仍在册');
  // 收尾（测试内进程不真正退出）：手动停 A 的子进程释放 exit 钩子
  await a.manager.stop();
  a.manager.dispose();
  b.manager.dispose();
});

test('协议：owner 先退出移交后，最后使用者（复用窗口）退出 → 按 owner 记录 kill 并清记录', async () => {
  const { a, b, ownerJar, usersJar, extKills } = makeTwoWindows();
  await bootOwned(a);
  await bootReuse(b);
  await a.manager.releaseOnExit(true); // owner 先退出：移交不杀
  assert.equal(extKills.length, 0);
  await b.manager.releaseOnExit(true); // 最后使用者退出：应清理共享服务进程
  assert.deepEqual(extKills, [1234], '最后使用者退出应按 owner 记录定位 kill 服务进程（stopExternalProcess）');
  assert.equal(ownerJar.has('127.0.0.1:3080'), false, '清理成功后清 owner 记录');
  assert.equal(usersJar.has('127.0.0.1:3080'), false, '最后使用者注销后注册表键清空');
  assert.equal(b.manager.isExitKillSkipped(), false, '已实际清理的场景无需移交标志');
  await a.manager.stop();
  a.manager.dispose();
  b.manager.dispose();
});

test('协议：单窗口（唯一使用者，owner）退出 → 照旧清理自启子进程（行为与现状一致）', async () => {
  const h = makeHarness(); // 默认装配已注入 usersStore（h.usersJar）
  await bootOwned(h);
  assert.deepEqual(h.usersJar.get('127.0.0.1:3080'), [process.pid], '就绪应登记本窗口扩展宿主 pid');
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 1234);
  await h.manager.releaseOnExit(true);
  assert.equal(h.manager.getSnapshot().state, 'idle');
  assert.ok((h.child?.killed ?? []).includes('SIGTERM'), '唯一使用者退出应照旧停掉自启子进程');
  assert.equal(h.ownerJar.has('127.0.0.1:3080'), false, '子进程停止后清 owner 记录');
  assert.equal(h.usersJar.has('127.0.0.1:3080'), false, '退出后注册表无残留');
  assert.equal(h.manager.isExitKillSkipped(), false);
  h.manager.dispose();
});

test('协议：复用窗口先退出（移交），owner 最后退出 → 走 stopChild 杀自己的子进程（不触发 externalProcess.stop）', async () => {
  const { a, b, ownerJar, usersJar, extKills } = makeTwoWindows();
  await bootOwned(a);
  await bootReuse(b);
  await b.manager.releaseOnExit(true); // B（复用窗口）先退出：A 仍在册 → 移交（B 无子进程本就无可杀）
  assert.equal(extKills.length, 0, 'B 退出不 kill');
  assert.deepEqual(usersJar.get('127.0.0.1:3080'), [9001], 'B 注销后只剩 A');
  await a.manager.releaseOnExit(true); // A（owner，最后使用者）退出：stopChild 清理自有子进程
  assert.deepEqual(extKills, [], 'owner 自启进程清理走 stopChild，不触发 externalProcess.stop');
  assert.ok((a.child?.killed ?? []).includes('SIGTERM'), 'A 退出应杀自己的子进程');
  assert.equal(ownerJar.has('127.0.0.1:3080'), false, 'stopOwned 顺带清 owner 记录');
  a.manager.dispose();
  b.manager.dispose();
});

test('协议：stopOnExit=false → 退出仅注销自己，不 kill、不置移交标志、owner 记录保留（服务留守）', async () => {
  const h = makeHarness();
  await bootOwned(h);
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 1234);
  await h.manager.releaseOnExit(false); // stopOnExit=false：deactivate 不清理（服务留守）
  assert.equal(h.manager.getSnapshot().state, 'ready', '服务保持就绪（留守）');
  assert.equal((h.child?.killed ?? []).length, 0, '不得 kill 自启子进程');
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 1234, 'owner 记录保留（供后续复用窗口识别归属）');
  assert.equal(h.usersJar.has('127.0.0.1:3080'), false, '本窗口已注销（不再使用该服务）');
  assert.equal(h.manager.isExitKillSkipped(), false, 'stopOnExit=false 不置移交标志');
  await h.manager.stop(); // 收尾：测试内进程不真正退出，手动停子进程释放 exit 钩子
  h.manager.dispose();
});

test('协议：退出清理前过滤崩溃窗口残留的死 pid（已死使用者不计，仍判定为最后使用者并清理孤儿服务）', async () => {
  const { a, b, ownerJar, usersJar, extKills, dead } = makeTwoWindows();
  await bootOwned(a);
  await bootReuse(b);
  assert.deepEqual(usersJar.get('127.0.0.1:3080'), [9001, 9002]);
  // A 窗口被强杀（kill -9）：deactivate 与 exit 钩子都没跑 → 注册表残留 A 的条目、owner 记录残留、子进程成孤儿
  dead.add(9001); // A 的扩展宿主进程已死
  await b.manager.releaseOnExit(true); // B（最后在册使用者）退出：过滤死 pid 后仍判空 → 清理孤儿服务
  assert.deepEqual(extKills, [1234], '死使用者被过滤后 B 是最后使用者：按 owner 记录 kill 孤儿服务进程');
  assert.equal(ownerJar.has('127.0.0.1:3080'), false, '清理后清 owner 记录');
  assert.equal(usersJar.has('127.0.0.1:3080'), false, '死条目与 B 的注销一并清空');
  await a.manager.stop(); // 收尾：停掉 A 的孤儿子进程（测试内），释放 exit 钩子
  a.manager.dispose();
  b.manager.dispose();
});

test('协议：登记/注销随就绪与 idle 流转（子进程意外退出 → 注销；再次就绪 → 重新登记；stop → 注销）', async () => {
  const h = makeHarness();
  await bootOwned(h);
  assert.deepEqual(h.usersJar.get('127.0.0.1:3080'), [process.pid], '就绪应登记');
  h.child?.emitExit(1); // 子进程意外退出（服务被杀/崩溃）→ 回 idle
  assert.equal(h.manager.getSnapshot().state, 'idle');
  await new Promise((r) => setTimeout(r, 5)); // 等 void 的异步注销完成
  assert.equal(h.usersJar.has('127.0.0.1:3080'), false, '服务死亡回 idle 应注销');
  assert.equal(h.ownerJar.has('127.0.0.1:3080'), false, '意外退出清 owner 记录');
  await bootOwned(h); // 重新启动就绪
  assert.deepEqual(h.usersJar.get('127.0.0.1:3080'), [process.pid], '再次就绪应重新登记');
  await h.manager.stop(); // 手动停止（脱钩）→ 注销
  assert.equal(h.usersJar.has('127.0.0.1:3080'), false, 'stop 脱钩应注销');
  await bootOwned(h); // 再次就绪（第三轮）
  assert.deepEqual(h.usersJar.get('127.0.0.1:3080'), [process.pid], '再启动就绪重新登记');
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 1234, 'owner 记录随新子进程重新发布');
  await h.manager.stop();
  h.manager.dispose();
});

test('协议：restart 先注销、就绪再登记（owner 记录同步重新发布）', async () => {
  const h = makeHarness();
  await bootOwned(h);
  assert.deepEqual(h.usersJar.get('127.0.0.1:3080'), [process.pid]);
  h.probeQueue = ['down', 'dsh'];
  const s = await h.manager.restart();
  assert.equal(s.state, 'ready');
  assert.equal(s.owned, true);
  assert.deepEqual(h.usersJar.get('127.0.0.1:3080'), [process.pid], '重启就绪后应重新登记');
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 1234, '重启就绪后 owner 记录重新发布');
  await h.manager.stop();
  h.manager.dispose();
});

test('协议：未注入使用者注册表（旧装配）→ releaseOnExit 降级旧行为 stop()（owner 退出即杀）', async () => {
  const h = makeHarness(undefined, { usersStore: undefined }); // 显式关掉注册表（旧装配）
  await bootOwned(h);
  assert.equal(h.usersJar.has('127.0.0.1:3080'), false, '无注册表不登记');
  await h.manager.releaseOnExit(true);
  assert.equal(h.manager.getSnapshot().state, 'idle', '旧装配：退出即停自启进程（与现状一致）');
  assert.ok((h.child?.killed ?? []).includes('SIGTERM'), '旧装配照旧杀自启子进程');
  assert.equal(h.ownerJar.has('127.0.0.1:3080'), false, '旧装配 stop 照旧清 owner 记录');
  assert.equal(h.manager.isExitKillSkipped(), false);
  h.manager.dispose();
});

// —— v0.3.12 退出路径加固：降级语义保守化（F2）/ 退出复查窗口 / exit 钩子共享守卫（F5）/ dispose 无杀伤 ——
// 用户真机复现：A（owner）spawn 3080 服务、B 复用且面板正常使用中，仅关 A 窗口 → 服务被杀。
// 线上根因：VS Code deactivate 期间 globalState.update 必 reject(Canceled)（存储已关闭），
// A 的注销写回失败 → 注册表残留 A 自身条目 → pruneDeadUsers 的写回清理同样被拒 →
// 旧实现把写回失败并入 catch 返回 null → releaseOnExit 误判「注册表读取失败」→ 降级
// stop() → 杀掉 B 正在使用的服务进程。以下用例逐一回归各防线。

test('根因回归：退出期间注册表写回被拒（deactivate 存储已关闭必 reject）→ 仍按镜像读取结果移交，绝不误杀共享服务', async () => {
  // 复刻 VS Code deactivate 生命周期：globalState.update 必 reject(Canceled)，
  // globalState.get 仍读本窗口内存镜像（同步，不受影响）
  const usersJar = new Map<string, number[]>();
  let writesClosed = false;
  const usersStore: UsersStore = {
    load: (host, port) => {
      const list = usersJar.get(`${host}:${port}`);
      return list === undefined ? null : { extPids: [...list] };
    },
    save: async (host, port, record) => {
      if (writesClosed) throw new Error('Canceled');
      usersJar.set(`${host}:${port}`, [...record.extPids]);
    },
    clear: async (host, port) => {
      if (writesClosed) throw new Error('Canceled');
      usersJar.delete(`${host}:${port}`);
    },
  };
  const a = makeHarness(undefined, { selfPid: 9001, usersStore });
  const b = makeHarness(undefined, { selfPid: 9002, usersStore });
  await bootOwned(a); // A 自启就绪（owner，登记 pid=9001）
  await bootReuse(b); // B 复用同一服务（登记 pid=9002）
  assert.deepEqual(usersJar.get('127.0.0.1:3080'), [9001, 9002]);
  writesClosed = true; // A 进入 deactivate：所有注册表写入被拒（注销/过滤写回均失败）
  await a.manager.releaseOnExit(true);
  assert.equal(a.child?.killed.length ?? 0, 0, '移交：绝不能杀 B 正在使用的服务进程（v0.3.11 此处必现误杀）');
  assert.equal(a.manager.isExitKillSkipped(), true, '应置移交标志（exit 钩子跳过兜底杀）');
  assert.deepEqual(usersJar.get('127.0.0.1:3080'), [9001, 9002], '注册表残留可接受（A 的注销写不落盘）：由后续窗口死 pid 过滤自愈');
  assert.equal(b.manager.getSnapshot().state, 'ready', 'B 侧连接不受 A 退出影响');
  await a.manager.stop(); // 收尾：测试内手动停 A 的子进程，释放 exit 钩子
  a.manager.dispose();
  b.manager.dispose();
});

test('F2：注册表读取失败 → 保守不杀（宁留孤儿不误杀共享服务），置 skipExitKill 跳过 exit 钩子兜底杀', async () => {
  const logs: string[] = [];
  const h = makeHarness(undefined, {
    log: (line) => logs.push(line),
    consoleLog: (line) => logs.push(line),
    usersStore: {
      load: async () => { throw new Error('storage broken'); },
      save: async () => {},
      clear: async () => {},
    },
  });
  await bootOwned(h); // registerSelf 同因读取失败而不登记（注册表不可用即无协调，符合预期）
  await h.manager.releaseOnExit(true);
  assert.equal(h.child?.killed.length ?? 0, 0, '「不确定」不再等于「杀」：读取失败不得杀自启子进程（可能有其他窗口在用）');
  assert.equal(h.manager.isExitKillSkipped(), true, 'exit 钩子兜底杀须同步跳过');
  assert.ok(logs.some((l) => l.includes('保守不清理')), '降级决策必须落持久日志（exthost）');
  h.manager.runExitHookDecision();
  assert.equal(h.child?.killed.length ?? 0, 0, 'skipExitKill=true 时 exit 钩子不得兜底杀');
  await h.manager.stop(); // 收尾：手动清理（模拟孤儿最终被用户/后续会话清理）
  h.manager.dispose();
});

test('F2：健康失联回 idle 但子进程仍存活（child 保留）→ 退出按注册表移交，不再绕过注册表直接 stop 误杀', async () => {
  const ownerJar = new Map<string, number>();
  const usersJar = new Map<string, number[]>();
  const extKills: number[] = [];
  const shared = {
    ownerStore: {
      load: (host: string, port: number) => ownerJar.get(`${host}:${port}`) ?? null,
      save: (host: string, port: number, pid: number) => { ownerJar.set(`${host}:${port}`, pid); },
      clear: (host: string, port: number) => { ownerJar.delete(`${host}:${port}`); },
    },
    usersStore: jarUsersStore(usersJar),
    externalProcess: {
      isAlive: (pid: number) => true,
      stop: async (pid: number) => { extKills.push(pid); },
    },
  };
  const a = makeHarness(undefined, { selfPid: 9001, healthIntervalMs: 20, ...shared });
  const b = makeHarness(undefined, { selfPid: 9002, ...shared });
  await bootOwned(a);
  await bootReuse(b);
  assert.ok(a.child, '自启子进程在册');
  a.probeQueue = ['down']; // A 的健康探测瞬时失败（服务繁忙/网络抖动）
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(a.manager.getSnapshot().state, 'idle', '健康失联：回 idle');
  assert.ok(a.child, '但子进程仍存活（健康失败路径不杀自有子进程——B 仍在使用的共享服务）');
  // B 仍在册 → A 退出必须移交（v0.3.11 旧行为：state!=ready 绕过注册表直接 stop → 误杀）
  await a.manager.releaseOnExit(true);
  assert.equal(a.child?.killed.length ?? 0, 0, '仍有其他使用者：移交不杀');
  assert.equal(a.manager.isExitKillSkipped(), true);
  assert.deepEqual(extKills, []);
  await a.manager.stop(); // 收尾
  a.manager.dispose();
  b.manager.dispose();
});

test('F2：未就绪且无自启子进程（启动失败）→ 退出纯脱钩，绝不按 owner 记录清理由他人启动的服务', async () => {
  const h = makeHarness();
  h.ownerJar.set('127.0.0.1:3080', 7777); // 他窗口/终端启动的服务记录（本窗口从未使用该服务）
  h.probeQueue = ['foreign']; // 端口被占 → failed（无子进程、从未就绪、从未登记）
  const s = await h.manager.ensureRunning();
  assert.equal(s.state, 'failed');
  await h.manager.releaseOnExit(true);
  assert.deepEqual(h.externalKillCalls, [], '从未使用该服务的窗口退出不得 kill 他人服务');
  assert.equal(h.ownerJar.get('127.0.0.1:3080'), 7777, 'owner 记录不动');
  h.manager.dispose();
});

test('退出复查窗口：其他窗口的登记在首查后才同步到本窗口镜像 → 延迟复查后改判移交，不杀', async () => {
  const usersJar = new Map<string, number[]>();
  const a = makeHarness(undefined, {
    selfPid: 9001,
    exitRecheckDelayMs: 40, // 开启复查窗口
    usersStore: jarUsersStore(usersJar),
  });
  await bootOwned(a); // 注册表=[9001]，B 尚未出现
  const p = a.manager.releaseOnExit(true); // 首查 others=0 → 进入复查延迟
  await new Promise((r) => setTimeout(r, 10)); // 仍在复查窗口内
  // B（复用窗口）此刻才完成登记（模拟跨窗口 globalState 镜像广播延迟到达 A）
  usersJar.set('127.0.0.1:3080', [9002]);
  await p;
  assert.equal(a.child?.killed.length ?? 0, 0, '复查发现其他使用者：改判移交不杀');
  assert.equal(a.manager.isExitKillSkipped(), true);
  await a.manager.stop(); // 收尾
  a.manager.dispose();
});

test('退出复查窗口：复查后仍无其他使用者 → 照常清理自启子进程（单窗口语义不变）', async () => {
  const h = makeHarness(undefined, { exitRecheckDelayMs: 5 });
  await bootOwned(h);
  await h.manager.releaseOnExit(true);
  assert.ok((h.child?.killed ?? []).includes('SIGTERM'), '复查无他人后照旧停自启子进程');
  assert.equal(h.ownerJar.has('127.0.0.1:3080'), false, '清理顺带清 owner 记录');
  assert.equal(h.manager.isExitKillSkipped(), false);
  h.manager.dispose();
});

test('F5 exit 钩子：本会话登记成功过（共享使用迹象）→ 即使 skipExitKill=false 也跳过兜底杀（宁留孤儿不误杀）', async () => {
  const logs: string[] = [];
  const h = makeHarness(undefined, { consoleLog: (line) => logs.push(line) });
  await bootOwned(h); // registerSelf 成功 → sharedUseSignaled=true；child 存活
  assert.equal(h.manager.isSharedUseSignaled(), true);
  assert.equal(h.manager.isExitKillSkipped(), false); // 未走退出清理（模拟 deactivate 被打断/未运行）
  h.manager.runExitHookDecision(); // 进程 exit：钩子决策
  assert.equal(h.child?.killed.length ?? 0, 0, '有共享使用迹象：跳过兜底杀（宁可留孤儿）');
  assert.ok(logs.some((l) => l.includes('跳过兜底杀') && l.includes('共享使用迹象')), '跳过原因必须落持久日志');
  await h.manager.stop(); // 收尾
  h.manager.dispose();
});

test('F5 exit 钩子：从未登记成功（旧装配）且无共享迹象 → 兜底杀照常执行（防僵尸进程）', async () => {
  const logs: string[] = [];
  const h = makeHarness(undefined, { usersStore: undefined, consoleLog: (line) => logs.push(line) });
  await bootOwned(h);
  assert.equal(h.manager.isSharedUseSignaled(), false, '旧装配从未登记：无共享迹象');
  h.manager.runExitHookDecision();
  assert.ok((h.child?.killed ?? []).includes('SIGKILL'), '无共享迹象照常兜底杀，防孤儿进程');
  assert.ok(logs.some((l) => l.includes('执行兜底杀')), '兜底杀必须落持久日志（pid + 原因标记）');
  await h.manager.stop();
  h.manager.dispose();
});

test('F5 exit 钩子：启动中途（未就绪未登记）进程退出 → 兜底杀启动中的子进程（防僵尸）', async () => {
  const h = makeHarness();
  h.probeQueue = ['down', 'down', 'down'];
  const p = h.manager.ensureRunning(); // 启动流程进行中（waiting）
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(h.child, '启动中已有子进程');
  assert.equal(h.manager.isSharedUseSignaled(), false, '未就绪未登记：无共享迹象');
  h.manager.runExitHookDecision();
  assert.ok((h.child?.killed ?? []).includes('SIGKILL'), '启动中途退出：兜底杀防僵尸');
  await h.manager.stop(); // 叫停启动流程（stopRequested → doStart 以 idle 收尾）
  const s = await p;
  assert.equal(s.state, 'idle');
  h.manager.dispose();
});

test('dispose 无杀伤：移交场景（child 存活 + skipExitKill=true）deactivate 尾部 dispose 不杀子进程，exit 钩子仍跳过', async () => {
  const { a, b } = makeTwoWindows();
  await bootOwned(a);
  await bootReuse(b);
  await a.manager.releaseOnExit(true); // 移交
  a.manager.dispose(); // deactivate 尾部调用
  assert.equal(a.child?.killed.length ?? 0, 0, 'dispose 绝不杀移交中的子进程');
  a.manager.runExitHookDecision(); // 进程真正退出时钩子仍保留（child 存活）且决策为跳过
  assert.equal(a.child?.killed.length ?? 0, 0, '移交后 exit 钩子不得兜底杀');
  await a.manager.stop(); // 收尾
  a.manager.dispose(); // 幂等
  b.manager.dispose();
});



