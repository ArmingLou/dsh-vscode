// test/manager.test.ts — 服务管理器状态机的单元测试（假探测 + 假子进程）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceManager, isNoOpenStderr, extractAuthToken, type ManagerDeps } from '../src/service/manager';
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
  states: string[];             // 记录状态变化序列
  proxyStarts: number;          // 假代理 start() 次数（断言代理生命周期）
  proxyStops: number;           // 假代理 stop() 次数
  proxyCreations: { target: { host: string; port: number }; token: string }[]; // 每次创建的 target/token
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
    states: [],
    proxyStarts: 0,
    proxyStops: 0,
    proxyCreations: [],
  };
  const probeService = async (_host: string, _port: number, _timeoutMs?: number, token?: string): Promise<ProbeResult> => {
    h.probeCount += 1;
    h.probeTokens.push(token ?? null);
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
  const fakeProxyFactory = (opts: { target: { host: string; port: number }; token: string }) => {
    h.proxyCreations.push({ target: { ...opts.target }, token: opts.token });
    return {
      url: `http://127.0.0.1:${59000 + h.proxyCreations.length}/`,
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
    { probeService, processRunner, log: () => {}, startTimeoutMs: 50, proxyFactory: fakeProxyFactory, ...depsOpts },
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



