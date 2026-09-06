// src/service/manager.ts — 服务管理器：状态机编排探测/启动/等待/停止
// 纯模块：不依赖 vscode；探测与进程管理均通过依赖注入，便于单测。
import { findFreePort, PORT_FALLBACK_ATTEMPTS, type ProbeResult } from './detect';
import {
  isProcessAlive,
  stopExternalProcess,
  type ChildProcessLike,
  type ProcessRunner,
} from './process';
import { createDefaultProxyFactory, type DshProxyLike, type DshProxyTarget } from './proxy';
import type { MsgKey } from '../i18n';

/** 服务状态 */
export type ServiceState = 'idle' | 'detecting' | 'starting' | 'waiting' | 'ready' | 'failed' | 'stopping';

/** 对外发布的状态快照（不可变副本） */
export interface ServiceSnapshot {
  state: ServiceState;
  /** 真实页面地址（http://host:port/，新版 dsh 携带 ?token=；浏览器打开/复制地址用） */
  url: string | null;
  /** 面板嵌入地址（新版 dsh 经扩展宿主代理，webview 无 Cookie 也能访问；旧版为 null 回退 url） */
  embedUrl: string | null;
  /** 失败原因（i18n 键，由面板/状态栏负责翻译） */
  error: MsgKey | null;
  /** 错误文案的 {变量} 值 */
  errorVars?: Record<string, string | number>;
  /** 当前就绪的服务是否由插件启动（决定 stop 时是否可杀） */
  owned: boolean;
}

/** 管理器配置 */
export interface ManagerOptions {
  host: string;
  port: number;
  extraArgs: string[];
  autoStart: boolean;
  /** 子进程工作目录（兜底：让 dsh web 以 VS Code 工作区为 cwd，缺省则不指定） */
  cwd?: string;
  /** 单次探测超时（毫秒） */
  timeoutMs: number;
  /** 等待就绪的轮询间隔（毫秒） */
  pollMs: number;
  /** dsh 可执行文件绝对路径（非空时优先于平台默认命令名使用） */
  executablePath?: string;
  /** 是否允许 dsh web 打开浏览器（true=不传 --no-open；默认追加 --no-open） */
  openInBrowser?: boolean;
  /**
   * 外部已启动 dsh web 服务的访问令牌（dsh.externalToken，已归一化为纯令牌）：
   * 终端里手动启动的实例插件拿不到其动态令牌，配置后即可复用该实例
   * （探测/地址/代理均使用该令牌）；留空则按「端口占用 → 自动换端口多实例」处理。
   */
  externalToken?: string;
}

/**
 * 判断子进程崩溃是否因 --no-open 参数不被 dsh 支持（stderr 含 "unknown option" 与 "no-open"）。
 * 纯函数：把"是否走 --no-open 兜底重启"的判定显式化，便于单测与回溯。
 */
export function isNoOpenStderr(stderr: string): boolean {
  return /unknown option/.test(stderr) && /no-open/.test(stderr);
}

/**
 * 从 dsh web 启动输出中提取进程访问令牌。
 *
 * 新版 dsh 每次启动动态生成 32 字节随机令牌（无禁用/固定选项），并在启动时打印
 * `dsh web: http://host:port/?token=XXX (LAN: ...)`；未带令牌访问首页会收到 401。
 * 扩展必须解析该行才能探测与打开页面。旧版 dsh 不打印令牌 → 返回 null（按无令牌探测）。
 *
 * @param output 子进程 stdout（可为跨 chunk 累积的缓冲尾，行被截断时本次返回 null，
 *               后续 chunk 补全后再调用即可命中）
 * @returns 令牌字符串；未匹配返回 null
 */
export function extractAuthToken(output: string): string | null {
  const m = /dsh web:\s*(https?:\/\/\S+)/.exec(output);
  if (!m) return null;
  try {
    const token = new URL(m[1]).searchParams.get('token');
    return token !== null && token !== '' ? token : null; // 空令牌视为未解析
  } catch {
    return null;
  }
}

/** 端口冲突决策回调收到的上下文 */
export interface PortConflictInfo {
  host: string;
  port: number;
  /** 上一次「输入令牌重试」未命中（令牌无效或实例已变化）：弹窗文案应提示用户 */
  tokenAttemptFailed: boolean;
  /** 决策等待期间流程是否已被叫停（stop）：回调应停止重弹并立即返回任意决策（结果会被丢弃） */
  isCancelled: () => boolean;
}

/** 端口冲突决策结果（'token' 携带用户输入并按 externalToken 规则归一化后的令牌） */
export type PortConflictDecision =
  | { kind: 'token'; token: string }
  | { kind: 'other-port' }
  | { kind: 'retry' };

/** 注入依赖 */
export interface ManagerDeps {
  probeService: (host: string, port: number, timeoutMs?: number, token?: string, cookie?: string) => Promise<ProbeResult>;
  processRunner: ProcessRunner;
  /** 日志出口（扩展里接到 Output Channel） */
  log: (line: string) => void;
  /** 端口被占用时自动临时替换成功后的通知回调（扩展里弹窗告知用户新端口） */
  onPortFallback?: (requestedPort: number, fallbackPort: number) => void;
  /**
   * 端口冲突强制决策回调（dsh-unauthenticated 且 Cookie 复用落空、autoStart=true 时）：
   * 扩展里弹 modal 三选一——「输入令牌重试」/「使用其他端口启动实例」/「按原流程重试」，
   * ESC/关闭必须重弹直到用户明确选择（等待期间不落任何回退）；令牌输入与归一化也在
   * 回调内完成，选择 'token' 时返回归一化后的令牌交由 manager 验证。
   * 未注入时维持旧行为：直接走「自动换端口」回退（旧装配/部分单测）。
   */
  askPortConflict?: (info: PortConflictInfo) => Promise<PortConflictDecision>;
  /**
   * 「输入令牌重试」探测命中（303 令牌交换）后的持久化钩子：把确认有效的令牌写入
   * dsh.externalToken 设置（用户级；扩展实现）。仅在验证有效后调用——无效令牌
   * 绝不写入设置，避免污染后续会话。
   */
  onPersistExternalToken?: (token: string) => void | Promise<void>;
  /** 会话 Cookie 持久化存取（复用外来实例；缺省为不持久化） */
  cookieStore?: SessionCookieStore;
  /**
   * 自启子进程 pid 的跨窗口记录存取（缺省不记录：复用窗口的「强制停止共享服务」随之不可用，
   * 点 Stop Service 维持旧行为——仅脱钩并提示）。
   */
  ownerStore?: OwnerPidStore;
  /**
   * 使用中窗口注册表（跨窗口共享服务的使用者计数；缺省不注入 → 不登记不协调，
   * 退出清理降级为旧行为——owner 窗口退出即杀自启子进程）。
   */
  usersStore?: UsersStore;
  /**
   * 本窗口扩展宿主 pid（使用者注册表登记/注销用；缺省 process.pid；
   * 单测注入不同值模拟多窗口）。
   */
  selfPid?: number;
  /**
   * 同步持久日志出口（默认 console.log → 扩展宿主 exthost 日志文件，窗口关闭后仍可查）。
   * 退出路径（releaseOnExit / 使用者注册表读写 / exit 钩子）的关键分支除 deps.log 外
   * 必须经此再落一份：OutputChannel 随窗口销毁，事后排障只能依赖 exthost 持久日志。
   * 单测注入收集器避免污染测试输出。
   */
  consoleLog?: (line: string) => void;
  /**
   * 退出清理判定「自己是最后使用者」后的延迟复查窗口（毫秒，默认 400）：
   * 等待跨窗口 globalState 镜像同步（其他窗口刚就绪登记、本窗口镜像尚未收到主进程
   * 存储广播的短暂窗口）再读一次注册表，复查到其他使用者则改判移交。≤0 关闭复查
   * （单测注入 0 保持既有用例时序）。复查仅发生在「即将 kill」分支：移交路径不受
   * 影响（亚秒返回）；清理路径 400ms + stopChild 收尾 ~3.2s 仍在 deactivate 5s 预算内。
   */
  exitRecheckDelayMs?: number;
  /**
   * 外部进程（另一窗口自启的 dsh）的存活探测与强停原语（强停共享服务用）。
   * 未注入时默认 process.ts 的真实实现（process.kill）；单测注入假实现避免触碰真实进程。
   */
  externalProcess?: { isAlive(pid: number): boolean; stop(pid: number): Promise<void> };
  /**
   * 「复用窗口停止共享服务」的决策回调（复用窗口点 Stop Service、目标服务存在存活 owner
   * 记录时调用；modal 弹窗与强停前二次确认在扩展层实现，返回最终决策）。
   * 未注入时维持旧行为：直接脱钩（不弹窗、不 kill）。
   */
  askStopReused?: (info: SharedStopAskInfo) => Promise<SharedStopDecision>;
  /** 崩溃自愈 Cookie 复用的宽限重试间隔（毫秒，默认 1000；单测注入小值缩短用例耗时） */
  cookieGraceDelayMs?: number;
  /** 就绪后的健康探测间隔（毫秒，默认 30000；≤0 关闭探测） */
  healthIntervalMs?: number;
  /** 启动总超时（毫秒，默认 15000） */
  startTimeoutMs?: number;
  /**
   * 面板嵌入代理工厂（默认创建真实 DshProxy；单测注入假实现）。
   * 新版 dsh 的 SameSite=Strict 会话 Cookie 在 VS Code webview（跨站子框架）中无法回传，
   * 面板必须经扩展宿主代理访问；旧版 dsh 无令牌时不需要代理。
   */
  proxyFactory?: (opts: { target: DshProxyTarget; token: string; initialCookie?: string }) => DshProxyLike;
}

/**
 * 会话 Cookie 持久化存取（按 host:port 分键）。
 * 扩展里接 context.globalState（用户级、跨窗口共享）；单测注入内存实现。
 * 背景：dsh 的会话 Cookie 由机器级持久 secret 签名（~/.dsh/.credentials.yaml），
 * 同一 authority 的 Cookie 跨 dsh 重启/跨实例/跨窗口有效——持久化后，
 * 其他窗口/下次会话在拿不到外来实例令牌的情况下也能复用该实例。
 */
export interface SessionCookieStore {
  load(host: string, port: number): string | null | Promise<string | null>;
  save(host: string, port: number, cookie: string): void | Promise<void>;
  clear(host: string, port: number): void | Promise<void>;
}

/**
 * 自启 dsh 子进程 pid 的跨窗口记录存取（按 host:port 分键）。
 * 扩展里接 context.globalState（用户级、跨窗口共享，键形如 `dsh.ownerPid@host:port`，与
 * 会话 Cookie 的 `dsh.proxyCookie@host:port` 同构）。owner 窗口在自启子进程就绪时写入 pid，
 * 复用窗口据此识别「该共享服务由哪个窗口启动」并决定能否提供「强制停止」。
 * 记录随进程停止/意外退出清理；owner 窗口崩溃导致的残留可接受——消费方使用前必须校验
 * pid 存活（0 号信号探测），并负责清理已失效的记录。单测注入内存实现。
 */
export interface OwnerPidStore {
  load(host: string, port: number): number | null | Promise<number | null>;
  save(host: string, port: number, pid: number): void | Promise<void>;
  clear(host: string, port: number): void | Promise<void>;
}

/** 使用者注册表记录：正在使用该 dsh 服务的窗口（扩展宿主）pid 列表（去重） */
export interface UsersRecord {
  extPids: number[];
}

/**
 * 使用中窗口（扩展宿主 pid）注册表存取（按 host:port 分键）。
 * 扩展里接 context.globalState（用户级、跨窗口共享，键形如 `dsh.users@host:port`，
 * 与 ownerPid/Cookie 键同构）；单测注入内存实现。
 *
 * 协议背景：「最后一个使用该 dsh 服务的 VS Code 窗口退出后才自动清理服务进程」——
 * 窗口在 manager 进入 ready（连接该服务，含自启就绪与复用就绪）时登记本窗口扩展宿主 pid；
 * 停止使用（stop/脱钩/失联回 idle/重启）与窗口退出时注销。退出清理（releaseOnExit）前用
 * isProcessAlive 过滤死 pid（窗口崩溃/强杀残留）：仍有其他存活使用者 → 移交不杀；
 * 自己是最后使用者才按 owner 记录/自启子进程清理。
 * 未注入（旧装配缺省）→ 不登记不协调，退出清理降级为旧行为（owner 窗口退出即杀）。
 */
export interface UsersStore {
  load(host: string, port: number): UsersRecord | null | Promise<UsersRecord | null>;
  save(host: string, port: number, record: UsersRecord): void | Promise<void>;
  clear(host: string, port: number): void | Promise<void>;
}

/** 「复用窗口停止共享服务」决策回调的入参（记录存在且 pid 存活时才回调） */
export interface SharedStopAskInfo {
  host: string;
  port: number;
  /** 展示用 host:port（日志与文案变量） */
  authority: string;
  /** owner 记录中的 pid（目标 dsh 服务进程） */
  pid: number;
}

/**
 * 「复用窗口停止共享服务」的对话框决策（modal 在扩展层实现：
 * 三选一「仅断开本窗口连接 / 强制停止服务 / 取消」+ 强停前的二次红色确认，均在回调内完成）。
 * - 'detach'：仅断开本窗口（服务继续运行）；
 * - 'force-stop'：用户已通过二次确认，同意强制终止共享服务进程；
 * - 'cancel'：用户取消（含强停二次确认被否），保持当前连接不动。
 */
export type SharedStopDecision = 'detach' | 'force-stop' | 'cancel';

/**
 * stopSharedService() 的执行结果（命令层据此决定是否追加提示文案）：
 * - 'cancel'：用户取消，保持连接；
 * - 'detach'：仅断开本窗口（用户选择，或未注入决策回调时的旧行为兜底）；
 * - 'force-killed'：已强停共享服务进程并清 owner 记录，本窗口脱钩；
 * - 'gone'：owner 记录的 pid 已不存在（进程已退出/弹窗期间退出），清失效记录后仅脱钩；
 * - 'no-record'：无 owner 记录（终端或旧版本扩展启动），维持原行为仅脱钩；
 * - 'kill-failed'：强停信号发送失败（如 EPERM），本窗口脱钩但服务可能仍在运行。
 */
export type SharedStopOutcome =
  | 'cancel'
  | 'detach'
  | 'force-killed'
  | 'gone'
  | 'no-record'
  | 'kill-failed';

/** 启动总超时默认值（毫秒）——dsh 冷启动约 14s，留 4x 余量覆盖慢机/多实例；按用户决定固定 60s */
const DEFAULT_START_TIMEOUT_MS = 60000;
/** 就绪后健康探测间隔默认值（毫秒） */
const DEFAULT_HEALTH_INTERVAL_MS = 30000;
/** 「崩溃后换端口重启」的最大轮数（防死循环；超过后报启动崩溃） */
const PORT_FALLBACK_MAX_ROUNDS = 3;
/** ensureProxy 失败重试次数 */
const PROXY_RETRY_ATTEMPTS = 3;
/** ensureProxy 重试间隔（毫秒） */
const PROXY_RETRY_DELAY_MS = 1000;
/**
 * 崩溃自愈 Cookie 复用的宽限重试次数：多窗口同时冷启动时，赢家（另一窗口的 dsh）
 * 绑定端口后约 1 秒内才把会话 Cookie 持久化并同步到本窗口，输家（EADDRINUSE 崩溃方）
 * 的自愈可能抢在发布之前——留出宽限窗口重试，仍落空才走「自动换端口」回退。
 */
const COOKIE_REUSE_GRACE_ATTEMPTS = 3;
/** 崩溃自愈 Cookie 复用的宽限重试间隔（毫秒） */
const COOKIE_REUSE_GRACE_DELAY_MS = 1000;
/**
 * 退出清理「最后使用者」判定后的延迟复查窗口（毫秒）：吸收跨窗口 globalState 镜像
 * 同步延迟（B 刚登记、A 镜像尚未收到广播的短暂窗口）。400ms + 现有 stopChild 收尾
 * ~3.2s ≈ 3.6s，仍在 deactivate 5s 硬预算内。
 */
const EXIT_RECHECK_DELAY_MS = 400;

/** 默认持久日志出口：console.log（扩展宿主环境落入 exthost 日志文件，窗口关闭后可查） */
const defaultConsoleLog = (line: string): void => { console.log(line); };

/** 默认外部进程控制原语（process.ts 的真实实现）；deps 未注入时使用。单测注入假实现避免触碰真实进程 */
const defaultExternalProcess = {
  isAlive: (pid: number): boolean => isProcessAlive(pid),
  stop: (pid: number): Promise<void> => stopExternalProcess(pid),
};

/** resolvePortConflict 的内部结果（manager 私有流转，不对外） */
export type PortConflictResolution =
  | { outcome: 'reused' }   // 已以用户令牌复用进入 ready
  | { outcome: 'retry' }    // 调用方完整重跑探测决策
  | { outcome: 'fallback' } // 调用方走「自动换端口」回退
  | { outcome: 'stopped' }; // 决策等待期间被叫停：保持 stop() 已设置的 idle

export class ServiceManager {
  private snapshot: ServiceSnapshot = { state: 'idle', url: null, embedUrl: null, error: null, owned: false };
  private listeners = new Set<(s: ServiceSnapshot) => void>();
  /** 进行中的启动/重启流程（防并发，幂等复用） */
  private op: Promise<ServiceSnapshot> | null = null;
  /** 就绪后的健康探测定时器（兜底外部服务失联/子进程活着但服务已死） */
  private healthTimer: NodeJS.Timeout | null = null;
  /** 停止请求标志：启动流程进行中也要立即停掉已 spawn 的子进程 */
  private stopRequested = false;
  /** 插件自己启动的子进程（复用外部服务时为 null） */
  private child: ChildProcessLike | null = null;
  /** 旧版 dsh 不支持 --no-open：本次会话检测到后置 true，后续启动一律去掉该参数 */
  private noOpenDisabled = false;
  /** 最近一次启动子进程的 stderr 缓冲（有界，用于识别 "unknown option '--no-open'" 崩溃根因） */
  private childStderr = '';
  /** 最近一次启动子进程的 stdout 缓冲（有界，用于解析 "dsh web: ...?token=..." 启动行） */
  private childStdout = '';
  /** 当前子进程的访问令牌（新版 dsh 每次启动动态生成，从 stdout 启动行解析）。
   * 令牌与进程绑定：子进程退出/重启/停止后必须清空，否则用旧令牌探测新进程会误判。
   */
  private authToken: string | null = null;
  /**
   * 复用外来实例的会话 Cookie（无令牌场景）：探测/健康探测/代理注入均使用；
   * 由持久化存储加载并经探测验证后生效，随服务停止/目标变化清空（存储中的凭据另行管理）。
   */
  private sessionCookie: string | null = null;
  /** 面板嵌入代理（仅新版 dsh 有令牌时存在；随服务停止/重启销毁） */
  private proxy: DshProxyLike | null = null;
  /** 代理对应的令牌（重建判据：令牌/端口变化时重启代理并重新交换） */
  private proxyKey: string | null = null;
  /** 配置中设定的原始端口（不含运行时 fallback），reconfigure 用来判定端口是否真正变更 */
  private originalPort: number;
  private disposed = false;
  /**
   * 退出移交标志：releaseOnExit 判定「仍有其他窗口在使用（移交）」或「stopOnExit=false
   * 服务留守」时置位，父进程 exit 钩子据此跳过兜底杀子进程（最后一次 spawn 时复位，
   * 新一轮子进程生命周期重新决策）。
   */
  private skipExitKill = false;
  /**
   * 共享使用迹象（F5 守卫）：本会话 registerSelf 成功过、或 pruneDeadUsers 快照曾见过
   * 其他存活使用者。置位后 exit 钩子在 skipExitKill=false 时也跳过兜底杀——退出清理
   * 被打断（deactivate 5s 超时等）时宁可留下孤儿进程（后续窗口按死 pid 过滤 / owner
   * 记录失效清理自愈），绝不误杀其他窗口正在使用的共享服务。
   */
  private sharedUseSignaled = false;
  /** 父进程退出时杀掉子进程，防止僵尸（stopOnExit=false 时移除）；按使用者注册表移交后跳过 */
  private parentExitHook = (): void => {
    this.exitKillDecision('process-exit');
  };

  /**
   * exit 钩子的兜底杀决策（同步，不得抛出）：
   * - skipExitKill=true（退出清理已按注册表移交/保守不杀）→ 跳过；
   * - sharedUseSignaled=true（本会话有共享使用迹象）→ 跳过（宁留孤儿不误杀共享服务）；
   * - 无存活子进程引用 → 无需执行；
   * - 其余（退出清理未完成或未运行、无共享迹象）→ SIGKILL 兜底杀防僵尸。
   * 所有分支同步落持久日志（exthost），事后可判别兜底杀是否发生及原因。
   */
  private exitKillDecision(reason: string): void {
    const authority = `${this.opts.host}:${this.opts.port}`;
    const child = this.child;
    const pid = child?.pid;
    if (this.skipExitKill) {
      this.persistLog(`[exit-hook] ${authority} 跳过兜底杀（原因=${reason}）：skipExitKill=true（退出清理已按使用者注册表移交或保守不杀）`);
      return;
    }
    if (this.sharedUseSignaled) {
      this.persistLog(`[exit-hook] ${authority} 跳过兜底杀（原因=${reason}）：本会话存在共享使用迹象（登记成功/曾见其他使用者，child pid=${pid ?? '无'}），宁留孤儿不误杀共享服务`);
      return;
    }
    if (!pid || !child) {
      this.persistLog(`[exit-hook] ${authority} 兜底杀无需执行（原因=${reason}）：无存活子进程引用（skipExitKill=false）`);
      return;
    }
    this.persistLog(`[exit-hook] ${authority} 执行兜底杀 pid=${pid}（原因=${reason}，skipExitKill=false 且无共享使用迹象：退出清理未完成或未运行，防僵尸进程）`);
    try {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* 非 Unix 或进程组已退出 */ }
      child.kill('SIGKILL');
    } catch {
      /* 进程可能已退出，忽略 */
    }
  }

  /**
   * （单测专用）直接执行 exit 钩子决策：生产路径由 process 'exit' 事件触发，单测无法
   * 安全模拟进程退出（会波及同进程内其他 manager 的钩子），经此入口直测兜底杀/跳过
   * 逻辑。不真正退出进程。
   */
  runExitHookDecision(): void {
    this.exitKillDecision('test');
  }

  constructor(private opts: ManagerOptions, private deps: ManagerDeps) {
    // externalToken 空串/纯空白 = 未配置（VS Code 设置默认 ''，归一化后仍为 ''）：
    // 统一归一化为 undefined。否则空串会流入探测（'' ?? undefined 仍为 ''），
    // 使 detect 的「无令牌 401 → dsh-unauthenticated」判据被破坏，疑似 dsh 实例
    // 被误判 foreign → 静默换端口、不弹三选一（真实环境未配置时必现）。
    if (opts.externalToken !== undefined && opts.externalToken.trim() === '') {
      this.opts = { ...opts, externalToken: undefined };
    }
    this.originalPort = opts.port;
    process.once('exit', this.parentExitHook);
  }

  /** 当前状态快照（副本，防外部篡改） */
  getSnapshot(): ServiceSnapshot {
    return { ...this.snapshot };
  }

  /** releaseOnExit 是否已置退出移交标志（exit 钩子将跳过兜底杀进程；退出流程/测试确认用） */
  isExitKillSkipped(): boolean {
    return this.skipExitKill;
  }

  /** 本会话是否出现过共享使用迹象（登记成功/曾见其他存活使用者）——F5 exit 钩子守卫的判据（测试确认用） */
  isSharedUseSignaled(): boolean {
    return this.sharedUseSignaled;
  }

  /**
   * 关键分支持久日志：deps.log（OutputChannel，随窗口销毁）之外同步再落一份到
   * consoleLog（默认 console.log → exthost 持久日志，窗口关闭后仍可查，带
   * [dsh-vscode] 前缀便于 grep）。供退出路径事后排障；任何出口失败都不影响主流程。
   */
  private persistLog(line: string): void {
    try { this.deps.log(line); } catch { /* OutputChannel 可能已销毁 */ }
    try { (this.deps.consoleLog ?? defaultConsoleLog)(`[dsh-vscode] ${line}`); } catch { /* 日志出口失败不传播 */ }
  }

  /** 当前目标地址（面板生成 CSP frame-src 用） */
  getTarget(): { host: string; port: number } {
    return { host: this.opts.host, port: this.opts.port };
  }

  /** 订阅状态变化，返回退订函数 */
  onChange(cb: (s: ServiceSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 更新内部状态并广播 */
  private set(partial: Partial<ServiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const cb of this.listeners) cb(this.getSnapshot());
  }

  /** 网页地址（新版 dsh 需要携带进程访问令牌；未解析到令牌时回退裸地址兼容旧版） */
  private url(): string {
    const base = `http://${this.opts.host}:${this.opts.port}/`;
    return this.authToken ? `${base}?token=${encodeURIComponent(this.authToken)}` : base;
  }

  /** 确保服务就绪：复用已有 / 自动启动（幂等：并发调用共享同一次流程） */
  ensureRunning(): Promise<ServiceSnapshot> {
    if (this.op) return this.op;
    if (this.snapshot.state === 'ready') return Promise.resolve(this.getSnapshot());
    this.stopRequested = false; // 新一轮启动流程重置停止标志
    this.op = this.doStart().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /** 重启：停掉自己启动的服务后重新走启动流程 */
  restart(): Promise<ServiceSnapshot> {
    if (this.op) return this.op;
    this.stopRequested = false; // 新一轮启动流程重置停止标志
    this.op = (async () => {
      await this.stopOwned();
      return this.doStart();
    })().finally(() => {
      this.op = null;
    });
    return this.op;
  }

  /**
   * 停止：仅停止插件自己启动的服务；启动流程进行中也会立即停掉已 spawn 的子进程。
   * 复用窗口的「强制停止共享服务」请走 stopSharedService()（由命令层调用）——
   * stop() 保持纯脱钩语义，绝不弹窗（deactivate/窗口关闭等程序化路径依赖这一点）。
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearHealthWatch(); // 复用外部服务时也要清掉健康探测定时器
    if (this.child) {
      await this.stopOwned();
    } else {
      await this.detachReused();
    }
  }

  /**
   * 复用的外来实例（含 Cookie 会话）脱钩：清健康探测/内存引用/代理并回 idle，注销使用者登记。
   * 持久化凭据（Cookie / owner 记录）保留——实例仍在运行，凭据下次启动验证后仍可复用。
   * stop() 的非 owned 分支与 stopSharedService() 的强停收尾共用。
   */
  private async detachReused(): Promise<void> {
    await this.unregisterSelf(); // 停止使用：从使用者注册表注销本窗口
    this.clearHealthWatch();
    this.sessionCookie = null;
    await this.stopProxy(); // 复用外部服务也可能有代理（理论罕见，防泄漏）
    this.set({ state: 'idle', url: null, embedUrl: null, owned: false, error: null });
  }

  /**
   * 「停止服务」的共享服务语义（**仅由命令层调用**；deactivate/程序化 stop 仍走 stop()）。
   * 复用窗口（ready 且 owned=false）点 Stop Service 时先查跨窗口 owner 记录：
   * - 无记录（终端启动 / 旧版本扩展启动）→ 维持旧行为仅脱钩（'no-record'，调用方提示）；
   * - 记录存在但 pid 已死 → 清失效记录 + 仅脱钩（'gone'，调用方提示「服务进程已退出」）；
   * - 记录存活 → 经 deps.askStopReused 弹窗决策：
   *   cancel=保持连接不动；detach=仅断开本窗口；force-stop（回调内已完成二次确认）=
   *   先复检 pid 存活（弹窗期间可能已退出）→ SIGTERM→宽限→SIGKILL 单 pid 强停
   *   （不碰进程组：外部进程组不归本扩展管理）→ 清 owner 记录 → 照常脱钩。
   *   owner 窗口侧由子进程 exit 监听自动感知（handleUnexpectedExit）并清理自身状态与记录。
   * 强停失败（EPERM 等）→ 'kill-failed'：本窗口仍脱钩，owner 记录保留（服务可能仍在运行）。
   */
  async stopSharedService(): Promise<SharedStopOutcome> {
    // 防御：与命令层快照竞态（决策期间自启流程意外完成等），有自有子进程按自有停止处理
    if (this.child) {
      await this.stopOwned();
      return 'detach';
    }
    const ext = this.deps.externalProcess ?? defaultExternalProcess;
    const authority = `${this.opts.host}:${this.opts.port}`;
    const recorded = await this.readSharedOwner();
    if (recorded === null) {
      this.deps.log(`[stop] ${authority} 无跨窗口 owner 记录（终端/旧版本扩展启动），无法强停，仅断开本窗口`);
      await this.detachReused();
      return 'no-record';
    }
    const pid = recorded.pid;
    if (!ext.isAlive(pid)) {
      this.deps.log(`[stop] owner 记录进程 pid=${pid} 已不存在（${authority}），清除失效记录并仅断开本窗口`);
      await this.clearOwnerPidIfMine(pid);
      await this.detachReused();
      return 'gone';
    }
    const ask = this.deps.askStopReused;
    if (!ask) {
      // 未注入决策回调（旧装配/单测兜底）：维持旧行为直接脱钩
      this.deps.log('[stop] 未注入共享服务停止决策回调（旧装配），仅断开本窗口');
      await this.detachReused();
      return 'detach';
    }
    this.deps.log(`[stop] ${authority} 上的共享 DSH 服务由另一窗口启动（pid=${pid}），弹出停止方式决策`);
    const decision = await ask({ host: this.opts.host, port: this.opts.port, authority, pid });
    if (decision === 'cancel') {
      this.deps.log(`[stop] 用户取消：保持与 ${authority} 的连接`);
      return 'cancel';
    }
    if (decision === 'detach') {
      this.deps.log(`[stop] 用户选择仅断开本窗口（${authority} 上的服务继续运行）`);
      await this.detachReused();
      return 'detach';
    }
    // force-stop：回调内已通过二次确认；执行前复检 pid（弹窗期间进程可能已退出）
    if (!ext.isAlive(pid)) {
      this.deps.log(`[stop] 强停前发现 pid=${pid} 已不存在（${authority}，弹窗期间退出），清除记录并仅断开本窗口`);
      await this.clearOwnerPidIfMine(pid);
      await this.detachReused();
      return 'gone';
    }
    this.clearHealthWatch(); // 强停期间不让健康探测干扰状态流转
    this.set({ state: 'stopping' });
    try {
      await ext.stop(pid);
      this.deps.log(`[stop] 已强制终止共享 DSH 服务进程 pid=${pid}（${authority}）`);
    } catch (err) {
      this.deps.log(`[stop] 强制终止 pid=${pid} 失败: ${String(err)}`);
      await this.detachReused();
      return 'kill-failed';
    }
    await this.clearOwnerPidIfMine(pid); // 强停成功清记录（owner 窗口侧的 exit 清理同样会清，幂等）
    await this.detachReused();
    return 'force-killed';
  }

  /**
   * 窗口退出主路径（extension deactivate 调用；须在进程退出前完成，可异步读写 globalState）。
   * 与手动 stopServiceCmd 无关——手动停止仍是立即停止语义，只有「窗口退出」走本协议。
   *
   * cleanup=true（stopOnExit=true，默认）——「最后一个使用该服务的窗口退出才清理」：
   * 1. 未注入注册表（旧装配）→ 维持旧行为 stop()（退出即停自启/启动中的进程）；
   * 2. 注销自己（退出期间 globalState 写入可能被拒——VS Code deactivate 时存储服务
   *    已关闭，属预期；注册表残留由 prune 的 selfPid 过滤与后续窗口死 pid 过滤自愈）；
   * 3. pruneDeadUsers 过滤死 pid 后仍有其他存活使用者 → 移交：不杀、置 skipExitKill、
   *    owner 记录保留（供最后退出者按记录定位 kill）；
   * 4. 注册表读取失败 → 保守不杀（v0.3.12 语义反转：「不确定」不再等于「杀」——宁留
   *    孤儿不误杀共享服务；残留由下次 pruneDeadUsers / owner 记录失效清理自愈）；
   * 5. 自己是最后使用者 → 延迟复查注册表（吸收跨窗口镜像同步延迟）后仍无他人：
   *    自启子进程走 stopOwned（杀子进程 + 顺带清 owner 记录）；复用的他人服务按跨窗口
   *    owner 记录定位 kill 后清记录；复查发现他人 → 改判移交。未就绪且无子进程 →
   *    纯脱钩收尾（绝不触碰他人服务）。
   *
   * cleanup=false（stopOnExit=false）——服务留守（供外部/其他窗口继续使用）：
   * 仅注销自己，不清理、不 kill、不动 owner/其他使用者记录，也不置移交标志
   * （该语义下 exit 钩子本就不在注册状态）。用户此后改回 true 时按上述协议清理。
   */
  async releaseOnExit(cleanup: boolean): Promise<void> {
    const authority = `${this.opts.host}:${this.opts.port}`;
    if (!cleanup) {
      this.persistLog(`[exit] ${authority} stopOnExit=false（服务留守）：仅注销本窗口，不清理`);
      await this.unregisterSelf();
      return;
    }
    if (!this.deps.usersStore) {
      // 旧装配：无注册表无法协调 → 维持旧行为（退出即停自启/启动中的进程）
      this.persistLog(`[exit] ${authority} 未注入使用者注册表（旧装配）：退出清理走旧行为（停本窗口自启/启动中的进程）`);
      await this.stop();
      return;
    }
    // 退出流程不再允许新的启动动作：中断进行中的启动循环轮询（不杀已 spawn 的子进程，
    // 去留由注册表判定），避免退出期间崩溃自愈逻辑再 spawn 新进程成孤儿。
    this.stopRequested = true;
    // 注销自己（退出 = 停止使用）。写回失败属预期（deactivate 期间存储已关闭）：
    // 注册表残留由下方 prune 的 selfPid 过滤与后续窗口的死 pid 过滤自愈。
    await this.unregisterSelf();
    const others = await this.pruneDeadUsers();
    if (others === null) {
      // 注册表读取失败：无法确认是否还有其他使用者 → 保守不杀（v0.3.12 反转旧「不确定即杀」）
      this.skipExitKill = true;
      this.persistLog(`[exit] ${authority} 使用者注册表读取失败：保守不清理（宁留孤儿不误杀共享服务），exit 钩子兜底杀已跳过；残留由后续 prune/owner 记录失效清理自愈`);
      return;
    }
    if (others.length > 0) {
      // 仍有其他窗口在使用该服务：移交——不杀；置标志防 exit 钩子兜底误杀；owner 记录保留
      this.skipExitKill = true;
      this.persistLog(`[exit] ${authority} 仍有 ${others.length} 个窗口在使用该服务（pid=${others.join(',')}）：移交，本窗口退出不清理，等待最后使用者退出时清理`);
      return;
    }
    if (this.child) {
      // 最后使用者 & owner（含未就绪但子进程仍存活的路径——健康失联回 idle、启动/
      // 等待中、启动超时 failed 等，统一按注册表协调，不再绕过注册表直接 stop 误杀）：
      // 延迟复查（吸收跨窗口 globalState 镜像同步延迟）再清理自启子进程。
      const recheck = await this.recheckUsersAfterDelay(authority);
      if (recheck !== 'alone') return; // 复查见他人 → 移交；读取失败 → 保守不杀（均已置标志并记日志）
      this.persistLog(`[exit] ${authority} 复查后仍无其他使用者，本窗口（owner）退出清理自启服务进程（pid=${this.child.pid}）`);
      await this.stopOwned();
      return;
    }
    if (this.snapshot.state === 'ready') {
      // 复用他人启动的共享服务 + 最后使用者：同样复查后按跨窗口 owner 记录定位清理
      const recheck = await this.recheckUsersAfterDelay(authority);
      if (recheck !== 'alone') return;
      const recorded = await this.readSharedOwner();
      if (recorded === null) {
        this.persistLog(`[exit] ${authority} 无其他使用者且无 owner 记录（终端/外部启动的实例），不在此协议内，不做清理`);
        return;
      }
      const ext = this.deps.externalProcess ?? defaultExternalProcess;
      if (!ext.isAlive(recorded.pid)) {
        this.persistLog(`[exit] ${authority} owner 记录进程 pid=${recorded.pid} 已不存在，清除失效记录（服务已不在，无需清理）`);
        await this.clearOwnerPidIfMine(recorded.pid);
        return;
      }
      this.persistLog(`[exit] ${authority} 复查后仍无其他使用者，本窗口（最后使用者）退出，按 owner 记录清理共享服务进程 pid=${recorded.pid}`);
      try {
        await ext.stop(recorded.pid);
      } catch (err) {
        this.persistLog(`[exit] ${authority} 清理共享服务进程 pid=${recorded.pid} 失败: ${String(err)}（owner 记录保留，服务可能仍在运行）`);
        return;
      }
      await this.clearOwnerPidIfMine(recorded.pid); // 清理成功清记录
      return;
    }
    // 未就绪且无自启子进程（idle/failed/启动失败等）：纯脱钩收尾，不 kill 任何进程
    this.persistLog(`[exit] ${authority} 本窗口未就绪且无自启子进程（state=${this.snapshot.state}）：仅脱钩收尾，不清理任何进程`);
    await this.stop();
  }

  /**
   * 退出清理前的延迟复查：判定「自己是最后使用者」后，等一个短暂窗口（默认 400ms）
   * 再读一次使用者注册表——覆盖「其他窗口刚就绪登记、本窗口的 globalState 内存镜像
   * 尚未收到主进程存储广播」的同步窗口。复查见他人/读取失败都已置 skipExitKill 并记
   * 持久日志；返回 'alone' 才允许执行 kill。exitRecheckDelayMs≤0 时跳过复查（单测时序）。
   */
  private async recheckUsersAfterDelay(authority: string): Promise<'alone' | 'others' | 'unknown'> {
    const delayMs = this.deps.exitRecheckDelayMs ?? EXIT_RECHECK_DELAY_MS;
    if (delayMs <= 0) return 'alone';
    await new Promise((r) => setTimeout(r, delayMs));
    const others = await this.pruneDeadUsers();
    if (others === null) {
      this.skipExitKill = true;
      this.persistLog(`[exit] ${authority} 复查时使用者注册表读取失败：保守不清理（宁留孤儿不误杀共享服务）`);
      return 'unknown';
    }
    if (others.length > 0) {
      this.skipExitKill = true;
      this.persistLog(`[exit] ${authority} 复查发现 ${others.length} 个窗口在使用该服务（pid=${others.join(',')}，首查为镜像同步延迟）：移交，本窗口退出不清理`);
      return 'others';
    }
    return 'alone';
  }

  /**
   * 「断开面板」：仅停止本窗口的面板嵌入代理并清空快照 embedUrl。
   * 这是用户断开嵌入连接的资源侧动作，**绝不**触碰：后端进程（无论 owned 与否）、
   * 子进程所有权（child/owned）、stopOnExit 与父进程退出钩子、健康探测——
   * 服务状态保持 ready（后端仍在运行，其他窗口/面板不受影响）。
   * 幂等：代理未在运行时为空操作；已就绪的 url/owned 快照字段保持不变。
   */
  async disconnectEmbed(): Promise<void> {
    await this.stopProxy();
    if (this.snapshot.embedUrl !== null) {
      // 仅清嵌入地址，状态仍为 ready（与"服务停止"的 idle 语义区分）
      this.set({ embedUrl: null });
    }
  }

  /**
   * 「重新连接面板」：确保面板嵌入代理可用（幂等）。
   * - 代理已在且令牌/目标未变 → 直接复用（空操作）；
   * - 代理被断开/缺失但仍有令牌或会话 Cookie → 重建并重新交换会话；
   * - 无令牌且无 Cookie（旧版 dsh 直连模式）→ 无需代理，空操作；
   * - 服务未就绪 → 空操作（代理由启动流程在就绪时建立，此处交给 ensureRunning 语义）。
   * 服务就绪时同步刷新快照 url/embedUrl 并广播（面板据此恢复 iframe）。
   * 不触碰子进程所有权、退出钩子与健康探测。
   */
  async ensureEmbed(): Promise<void> {
    await this.ensureProxy();
    if (this.snapshot.state === 'ready') {
      this.set({ url: this.url(), embedUrl: this.proxy?.url ?? null });
    }
  }

  /** 停掉自启子进程并回到 idle（顺带注销使用者登记；restart 先经此注销、就绪再登记） */
  private async stopOwned(): Promise<void> {
    await this.unregisterSelf(); // 停止使用：从使用者注册表注销本窗口
    this.clearHealthWatch();
    await this.stopProxy(); // 代理随令牌一起销毁
    if (!this.child) {
      this.set({ state: 'idle', url: null, embedUrl: null, owned: false, error: null });
      return;
    }
    this.set({ state: 'stopping' });
    const child = this.child;
    this.child = null;
    this.authToken = null; // 子进程将停止，其访问令牌随之失效
    this.sessionCookie = null; // 自启实例不走 Cookie 会话，防御性清空
    try {
      await this.deps.processRunner.stopChild(child);
    } catch (err) {
      this.deps.log(`[process] 停止子进程失败: ${String(err)}`);
    }
    await this.clearOwnerPidIfMine(child.pid); // 自启进程已停：清跨窗口 owner 记录
    this.set({ state: 'idle', url: null, embedUrl: null, owned: false, error: null });
  }

  /**
   * 进入就绪（所有就绪路径共用的收尾）：广播 ready 快照 →（自启路径）发布跨窗口 owner pid →
   * 登记本窗口为服务使用者（注册表）→ 启动健康探测。
   */
  private async enterReady(owned: boolean, publishChildPid?: number): Promise<void> {
    this.set({ state: 'ready', url: this.url(), embedUrl: this.proxy?.url ?? null, owned });
    if (publishChildPid !== undefined) await this.publishOwnerPid(publishChildPid);
    await this.registerSelf();
    this.startHealthWatch();
  }

  /**
   * 完整启动流程：探测 → 复用 / 启动 → 等待就绪。
   * 阶段一（探测与冲突决策）以循环组织：「按原流程重试」决策由此完整重跑——
   * 实例可能已消失（down → 原端口自启），仍被占用则重新走 Cookie 复用 → 三选一决策。
   *
   * @param portFallbackRounds 已发生的「崩溃后换端口重启」轮数（递归调用时递增；
   *                            达到上限后不再换端口，直接报启动崩溃，防止死循环）
   */
  private async doStart(portFallbackRounds = 0): Promise<ServiceSnapshot> {
    let probe: ProbeResult;
    for (;;) {
      this.set({ state: 'detecting', error: null });
      // 探测令牌：自启子进程解析出的令牌优先；未配置/未解析时用外部令牌（复用终端已启动的实例）
      probe = await this.deps.probeService(
        this.opts.host, this.opts.port, this.opts.timeoutMs,
        this.authToken ?? this.opts.externalToken ?? undefined,
      );
      this.deps.log(`[process] 初始探测 ${this.opts.host}:${this.opts.port} → ${probe}（令牌：${this.authToken ? '自启实例令牌' : this.opts.externalToken ? 'externalToken' : '无'}）`);
      if (probe === 'dsh') {
        // 已有服务在跑：直接复用（外部实例需配置 externalToken 才能通过探测；自启实例走等待循环）
        if (this.stopRequested) return this.getSnapshot(); // 探测期间被叫停，不覆盖用户的停止意图
        this.authToken = this.opts.externalToken ?? null; // 复用外部实例：其令牌来自配置
        this.sessionCookie = null; // 令牌复用：会话走令牌交换，不再使用旧 Cookie
        await this.ensureProxy(); // 外部实例同样需要面板嵌入代理（webview 无 Cookie）
        await this.enterReady(false); // 复用就绪：登记本窗口为使用者（含健康探测启动）
        return this.getSnapshot();
      }
      if (probe === 'dsh-unauthenticated') {
        // 「疑似 dsh 未认证」（无令牌 401 + dsh 认证提示）：端口上很可能是其他终端/窗口启动的
        // dsh 实例（其令牌只打印在该进程 stdout，插件拿不到）。先尝试用持久化会话 Cookie 复用
        // （owned=false，不杀他人进程）；复用落空则进入强制三选一决策。
        if (this.stopRequested) return this.getSnapshot(); // 探测期间被叫停
        this.deps.log(`[process] ${this.opts.host}:${this.opts.port} 疑似其他终端/窗口启动的 dsh web（未认证 401），尝试以持久化会话 Cookie 复用`);
        if (await this.tryReuseWithCookie()) return this.getSnapshot();
        if (this.stopRequested) return this.getSnapshot(); // Cookie 探测期间被叫停
        // Cookie 复用落空 → 强制决策（仅 autoStart=true 弹窗；false 保持 err.portOccupied 语义）。
        // 未注入决策回调时维持旧行为：直接走下方「自动换端口」回退。
        if (this.opts.autoStart) {
          const decision = await this.resolvePortConflict();
          if (decision.outcome === 'reused' || decision.outcome === 'stopped') return this.getSnapshot();
          if (decision.outcome === 'retry') continue; // 完整重跑探测决策
          // 'fallback'（选择「使用其他端口」）→ 落入下方换端口回退
        }
      }
      break;
    }
    if (probe === 'dsh-unauthenticated' || probe === 'foreign') {
      // 端口被其他程序占用（或经用户决策选择换端口）：自动临时替换为第一个空闲端口
      // （仅本次会话生效，不写配置）。不自动启动时替换端口没有意义，保持原「端口被占用」提示。
      if (this.opts.autoStart) {
        const fallback = await findFreePort(
          this.opts.host, this.opts.port, PORT_FALLBACK_ATTEMPTS, this.deps.probeService, this.opts.timeoutMs,
        );
        if (fallback !== null) {
          if (this.stopRequested) return this.getSnapshot(); // 探测候选期间被叫停，不覆盖用户的停止意图
          this.deps.log(`[process] 端口 ${this.opts.port} 被其他程序占用，本次会话临时改用端口 ${fallback}`);
          this.deps.onPortFallback?.(this.opts.port, fallback);
          // 运行时替换端口：本次会话内 URL/探测/重启均使用新端口；
          // 不写回 VS Code 配置，重启 VS Code 后恢复用户配置的端口。
          this.opts.port = fallback;
          // 不 return：落入下方启动流程（autoStart 为 true）
        } else {
          // 连续 50 个候选端口都被占用：保持原「端口被占用」错误
          this.set({ state: 'failed', error: 'err.portOccupied', errorVars: { port: this.opts.port } });
          return this.getSnapshot();
        }
      } else {
        this.set({ state: 'failed', error: 'err.portOccupied', errorVars: { port: this.opts.port } });
        return this.getSnapshot();
      }
    }
    if (!this.opts.autoStart) {
      this.set({ state: 'failed', error: 'err.notRunning' });
      return this.getSnapshot();
    }

    // 启动子进程
    if (this.stopRequested) return this.getSnapshot(); // 启动前被叫停
    this.set({ state: 'starting' });
    // Node 在 Windows 上对 .cmd 批处理文件带 cwd 参数 spawn 存在已知的同步抛 EINVAL
    // （参数无效）问题：只要传入 cwd（无论英文/中文路径）就会抛 EINVAL，与路径内容无关。
    // 因此这里做一次「去掉 cwd 重试」的降级：第一次失败若为 EINVAL 且带了 cwd，
    // 则以 cwd=undefined 再 spawn 一次（args/主机/端口/可执行路径照旧）；重试仍失败才报错。
    let child: ChildProcessLike;
    let cwdForSpawn: string | undefined = this.opts.cwd;
    let retried = false; // 是否已执行过去掉 cwd 的降级重试（最多重试一次）
    for (;;) {
      try {
        child = this.deps.processRunner.startDsh({
          host: this.opts.host,
          port: this.opts.port,
          extraArgs: this.opts.extraArgs,
          cwd: cwdForSpawn,
          executablePath: this.opts.executablePath,
          // noOpenDisabled 后视为"用户要求弹浏览器"（即不追加 --no-open），兼容旧版 dsh
          openInBrowser: this.noOpenDisabled ? true : this.opts.openInBrowser,
        });
        break; // spawn 成功（未同步抛异常），跳出重试循环继续等待就绪
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        this.deps.log(`[process] 启动失败: ${String(err)} (code=${code}, cwd=${cwdForSpawn ?? ''})`);
        // EINVAL + 带 cwd 且尚未重试过：这是 Node/Windows 上 .cmd 带 cwd 的已知兼容问题，
        // 去掉 cwd 重试一次，而不是直接报失败（直接报错会把参数问题误报成启动失败）。
        if (code === 'EINVAL' && cwdForSpawn !== undefined && !retried) {
          this.deps.log(`[process] spawn EINVAL（工作目录参数在 Windows 上不可用），已自动回退为不带 cwd 重试: ${String(err)}`);
          cwdForSpawn = undefined; // 去掉 cwd 降级重试
          retried = true;
          continue;
        }
        // 区分错误类型：EINVAL 是 spawn 参数无效（Windows 上 cwd 非法等，重试后仍无效）；
        // NODE_NOT_FOUND 是 Windows 下找不到可用的 node.exe（Electron 环境不能把 Code.exe 当 node）；
        // ENOENT 才是命令缺失；其余保守地归为「未找到命令」。
        if (code === 'EINVAL') {
          this.set({
            state: 'failed',
            error: 'err.spawnEinval',
            errorVars: { cwd: String(this.opts.cwd ?? '') },
          });
        } else if (code === 'NODE_NOT_FOUND') {
          this.set({ state: 'failed', error: 'err.nodeNotFound' });
        } else {
          this.set({ state: 'failed', error: 'err.dshNotFound' });
        }
        return this.getSnapshot();
      }
    }
    this.child = child;
    this.skipExitKill = false; // 新一轮子进程生命周期：清退出移交标志（退出决策重新评估）
    this.childStderr = ''; // 新一轮启动重置 stderr 缓冲（供 --no-open 崩溃识别）
    this.childStdout = ''; // 新一轮启动重置 stdout 缓冲（供访问令牌解析）
    this.authToken = null; // 新进程的令牌未知：先按旧版（无令牌）探测，等到 URL 行后更新
    // 记录实际执行的启动命令（含解析出的 node 路径与全部参数），供问题排查对照环境差异
    const lastStart = this.deps.processRunner.lastStart;
    if (lastStart) {
      this.deps.log(`[process] 启动命令: ${lastStart.command} ${lastStart.args.join(' ')}`);
    }

    // spawn 的 ENOENT 通过 'error' 事件异步到达，用标志位让等待循环立即失败
    let spawnFailed = false;
    // 等待阶段子进程退出的标志（等待循环据此判定 err.startCrashed）
    let childExited = false;
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      this.deps.log(`[process] ${err.message} (code=${code}, cwd=${this.opts.cwd ?? ''})`);
      // EINVAL（Windows 上非法的 spawn 参数，如 UNC/无效 cwd）与 ENOENT（命令缺失）
      // 同等对待：立即置为 failed，避免走「等待超时」路径误导用户。
      if (code === 'EINVAL') {
        spawnFailed = true;
        this.set({
          state: 'failed',
          error: 'err.spawnEinval',
          errorVars: { cwd: String(this.opts.cwd ?? '') },
        });
      } else if (code === 'ENOENT') {
        spawnFailed = true;
        this.set({ state: 'failed', error: 'err.dshNotFound' });
      }
    });
    child.on('exit', () => {
      childExited = true;
      this.handleUnexpectedExit(child);
    });
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      this.deps.log(`[stdout] ${text.trimEnd()}`);
      // 新版 dsh 每次启动动态生成进程令牌，启动行形如 "dsh web: http://host:port/?token=XXX"。
      // 解析后用于探测与面板地址：未带令牌访问新版 dsh 首页会收到 401。
      // 有界缓冲累计 stdout（行可能跨 chunk），命中即更新令牌并刷新就绪地址。
      if (this.childStdout.length < 4096) {
        this.childStdout += text;
        if (this.childStdout.length > 8192) this.childStdout = this.childStdout.slice(-4096);
      }
      const token = extractAuthToken(this.childStdout);
      if (token !== null && token !== this.authToken) {
        this.authToken = token;
        this.deps.log('[process] 已捕获 dsh web 访问令牌（新版 dsh 动态生成）');
        if (this.proxy && this.proxyKey === `${token}@${this.opts.host}:${this.opts.port}`) {
          void this.proxy.setToken?.(token).catch((err) =>
            this.deps.log(`[proxy] 令牌刷新失败: ${String(err)}`),
          );
        } else {
          void (async () => {
            await this.ensureProxy();
            if (this.snapshot.state === 'ready') {
              this.set({ url: this.url(), embedUrl: this.proxy?.url ?? null });
            }
          })();
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      // 有界缓冲最近一次启动的 stderr（用于识别 --no-open 不支持导致的启动崩溃）
      if (this.childStderr.length < 4096) {
        this.childStderr += text;
        if (this.childStderr.length > 8192) this.childStderr = this.childStderr.slice(-4096);
      }
      this.deps.log(`[stderr] ${text.trimEnd()}`);
    });

    // 等待就绪：轮询探测直到 ready / 子进程退出 / 超时
    this.set({ state: 'waiting' });
    const startTimeoutMs = this.deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      if (spawnFailed) return this.getSnapshot(); // 已置为 failed（err.dshNotFound）
      if (this.stopRequested) return this.getSnapshot(); // 等待阶段被叫停（先于 childExited 判定）
      if (childExited) {
        // 兼容旧版 dsh：不支持 --no-open 时 commander 报 "unknown option '--no-open'" 后退出。
        // 这是参数问题而非端口占用，必须识别出来并去掉该参数**原端口**重启，
        // 否则会被当成"启动期间端口被抢占"而陷入换端口级联（实测踩坑）。
        if (!this.opts.openInBrowser && !this.noOpenDisabled) {
          // 给 stderr 一点冲刷时间，避免 'exit' 早于 'data' 的竞态导致漏判
          await new Promise((resolve) => setTimeout(resolve, 60));
          if (isNoOpenStderr(this.childStderr)) {
            this.deps.log('[process] 当前 dsh 版本不支持 --no-open，本次会话自动去掉该参数后原端口重启');
            this.noOpenDisabled = true;
            this.child = null;
            return this.doStart(portFallbackRounds); // 原端口重试（不递增换端口轮数）
          }
        }
        // 子进程没撑到就绪就退出：两类场景——
        // 1) 残留 dsh 实例占着端口，新实例因 EADDRINUSE 崩溃；
        // 2) 启动期间端口被其他程序抢占（如 WSL 与 Windows 共享 localhost 端口，
        //    WSL 侧 dsh 慢启动导致探测时端口空闲、启动后却被其占用）。
        // 自愈策略：探测一次端口——
        //   a. 已有 dsh 在跑 → 直接复用（owned=false，不误杀他人进程）；
        //   b. 端口被非 dsh 抢占（含 WSL 转发代理占端口但页面不可达）→ 自动换端口重启；
        //   c. 其余 → 启动崩溃。
        this.child = null;
        this.authToken = null; // 子进程已退出，其令牌随之失效；残留实例是别的进程，令牌未知
        const reuse = await this.deps.probeService(this.opts.host, this.opts.port, this.opts.timeoutMs, this.authToken ?? undefined);
        this.deps.log(`[process] 子进程退出后的自愈探测 ${this.opts.host}:${this.opts.port} → ${reuse}`);
        // 自愈探测期间被叫停：保留 stop() 已设置的状态（idle），绝不覆盖为 failed
        if (this.stopRequested) return this.getSnapshot();
        if (reuse === 'dsh') {
          this.deps.log('[process] 子进程退出，但端口已有 dsh 服务在运行（残留实例占端口自愈），改为复用');
          await this.enterReady(false); // 复用就绪：登记本窗口为使用者
          return this.getSnapshot();
        }
        if (reuse === 'dsh-unauthenticated') {
          // 多窗口同时冷启动的竞态自愈：本窗口子进程因端口被「另一窗口刚绑定的 dsh」
          // 抢占（EADDRINUSE）而崩溃。对方令牌只打印在其 stdout，但对方就绪后会立刻
          // 把会话 Cookie 持久化到共享存储——本进程崩溃通常晚于对方绑定数秒（Cookie
          // 多半已就绪），先以 Cookie 复用（含宽限重试，吸收「绑定→发布」的短暂窗口
          // 与跨窗口存储同步延迟）；落空则与主路径一致走强制三选一决策（不静默换端口）。
          if (await this.tryReuseWithCookieGrace()) return this.getSnapshot();
          if (this.stopRequested) return this.getSnapshot(); // 宽限重试期间被叫停
          if (this.opts.autoStart) {
            const decision = await this.resolvePortConflict();
            if (decision.outcome === 'reused' || decision.outcome === 'stopped') return this.getSnapshot();
            if (decision.outcome === 'retry') return this.doStart(portFallbackRounds); // 完整重跑探测决策
            // 'fallback'（选择「使用其他端口」）→ 落入下方换端口重启
          }
        }
        // 换端口重启：端口在启动期间被抢占，自动改用第一个空闲端口（仅本次会话，
        // 弹窗告知）；带轮数上限防死循环（每次崩溃都换新端口重启，最多 3 轮）。
        if (this.opts.autoStart && portFallbackRounds < PORT_FALLBACK_MAX_ROUNDS) {
          const fallback = await findFreePort(
            this.opts.host, this.opts.port, PORT_FALLBACK_ATTEMPTS, this.deps.probeService, this.opts.timeoutMs,
          );
          if (fallback !== null && !this.stopRequested) {
            this.deps.log(`[process] 子进程退出（端口 ${this.opts.port} 启动期间被抢占），本次会话临时改用端口 ${fallback} 重启`);
            this.deps.onPortFallback?.(this.opts.port, fallback);
            this.opts.port = fallback; // 运行时替换：本次会话内 URL/探测/重启均使用新端口
            return this.doStart(portFallbackRounds + 1); // 递归重启（新端口重新探测 + 启动）
          }
        }
        this.set({ state: 'failed', error: 'err.startCrashed' });
        return this.getSnapshot();
      }
      const result = await this.deps.probeService(this.opts.host, this.opts.port, this.opts.timeoutMs, this.authToken ?? undefined);
      if (result === 'dsh') {
        // 就绪前先确保面板嵌入代理就绪（新版 dsh 需代理注入会话 Cookie；失败则回退直连并记日志）
        await this.ensureProxy();
        // 进入就绪并发布跨窗口 owner pid（供复用窗口识别归属/强停）+ 登记本窗口为使用者
        await this.enterReady(true, child.pid);
        return this.getSnapshot();
      }
      // 'foreign' 表示子进程没能绑定端口（被占）——继续等待会让用户困惑，
      // 但可能只是服务尚未就绪的瞬间，保守起见继续轮询直到超时。
      if (Date.now() >= deadline) {
        this.set({
          state: 'failed',
          error: 'err.startTimeout',
          errorVars: { seconds: Math.round(startTimeoutMs / 1000) },
        });
        return this.getSnapshot();
      }
      await new Promise((r) => setTimeout(r, this.opts.pollMs));
    }
  }

  /**
   * 用持久化会话 Cookie 尝试复用「疑似 dsh 未认证」的实例（owned=false，不杀他人进程）。
   * 探测命中（200 + __DSH_BOOT__）→ 以该 Cookie 建面板代理进入 ready；
   * Cookie 陈旧（探测仍 401）或实例不在 → 清除存储并返回 false（调用方继续引导 + 换端口回退）。
   */
  private async tryReuseWithCookie(): Promise<boolean> {
    const store = this.deps.cookieStore;
    if (!store) return false;
    let cookie: string | null = null;
    try {
      cookie = await store.load(this.opts.host, this.opts.port);
    } catch (err) {
      this.deps.log(`[process] 读取持久化会话 Cookie 失败: ${String(err)}`);
      return false;
    }
    if (!cookie) {
      // 决策链日志：Cookie 复用不可用的原因（该 host:port 从未持久化或已清除）
      this.deps.log(`[process] 无持久化会话 Cookie（${this.opts.host}:${this.opts.port}），Cookie 复用不可用`);
      return false;
    }
    // 只记录 Cookie 名（dsh-auth-*），不落凭据值
    this.deps.log(`[process] 读取持久化会话 Cookie（${this.opts.host}:${this.opts.port}）：命中 ${cookie.split('=')[0]}`);
    const result = await this.deps.probeService(
      this.opts.host, this.opts.port, this.opts.timeoutMs, undefined, cookie,
    );
    this.deps.log(`[process] 以持久化会话 Cookie 探测 ${this.opts.host}:${this.opts.port} → ${result}`);
    if (result !== 'dsh') {
      // Cookie 陈旧（401）或实例已失联：视为失效并清除存储，继续后续决策/回退
      this.deps.log('[process] 持久化会话 Cookie 已失效（探测未命中），清除后继续');
      await this.forgetSessionCookie();
      return false;
    }
    this.deps.log(`[process] 以持久化会话 Cookie 复用 ${this.opts.host}:${this.opts.port} 上已有的 dsh 实例`);
    this.sessionCookie = cookie;
    this.authToken = null; // 无令牌复用：健康探测/代理均走 Cookie 会话
    await this.ensureProxy();
    await this.enterReady(false); // 复用就绪：登记本窗口为使用者
    return true;
  }

  /**
   * 崩溃自愈场景的 Cookie 复用（带宽限重试）：多窗口同时冷启动时，本窗口子进程因
   * 端口被「另一窗口刚绑定的 dsh」抢占（EADDRINUSE）而崩溃；对方就绪后会立刻把
   * 会话 Cookie 持久化到共享存储，但「绑定端口 → 发布 Cookie」之间存在短暂窗口，
   * 跨窗口 globalState 同步亦有延迟——首次读取落空时在宽限窗口内重试，
   * 仍落空返回 false（调用方继续引导 + 换端口回退，保持既有行为）。
   */
  private async tryReuseWithCookieGrace(): Promise<boolean> {
    const delayMs = this.deps.cookieGraceDelayMs ?? COOKIE_REUSE_GRACE_DELAY_MS;
    for (let attempt = 1; attempt <= COOKIE_REUSE_GRACE_ATTEMPTS; attempt++) {
      if (await this.tryReuseWithCookie()) return true;
      if (this.stopRequested) return false; // 宽限等待期间被叫停：不再重试
      if (attempt < COOKIE_REUSE_GRACE_ATTEMPTS && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return false;
  }

  /**
   * 端口冲突强制决策（主路径与崩溃自愈路径共用的最终决策点）。
   * 前置条件：探测为 dsh-unauthenticated 且持久化 Cookie 复用已落空（autoStart=true）。
   * - 'token'：以用户提供的令牌重探目标端口；命中（303 令牌交换）→ 复用（owned=false），
   *   经 onPersistExternalToken 把确认有效的令牌持久化到 dsh.externalToken 设置（用户级）；
   *   未命中 → 携 tokenAttemptFailed 重弹三选一（提示令牌无效或实例已变化）；
   * - 'retry'：返回 retry，调用方完整重跑探测决策（实例可能已消失 → 原端口自启）；
   * - 'other-port'：返回 fallback，调用方走「自动换端口」回退（仅此选择才换端口）。
   * 未注入 askPortConflict 时直接返回 fallback（维持既有自动回退行为，旧装配/单测）。
   * 决策等待期间被叫停（stopRequested）返回 stopped：调用方保持 stop() 已设置的 idle，
   * 绝不落任何回退；isCancelled 供回调在用户交互间隙检测叫停并停止重弹。
   */
  private async resolvePortConflict(): Promise<PortConflictResolution> {
    const ask = this.deps.askPortConflict;
    if (!ask) return { outcome: 'fallback' };
    let tokenAttemptFailed = false;
    for (;;) {
      if (this.stopRequested) return { outcome: 'stopped' };
      const decision = await ask({
        host: this.opts.host,
        port: this.opts.port,
        tokenAttemptFailed,
        isCancelled: () => this.stopRequested,
      });
      if (this.stopRequested) return { outcome: 'stopped' }; // 弹窗期间被叫停：丢弃用户选择
      if (decision.kind === 'token') {
        const result = await this.deps.probeService(
          this.opts.host, this.opts.port, this.opts.timeoutMs, decision.token,
        );
        this.deps.log(`[process] 以用户提供的令牌探测 ${this.opts.host}:${this.opts.port} → ${result}`);
        if (result === 'dsh') {
          this.authToken = decision.token; // 复用外来实例：令牌来自用户输入（已验证有效）
          this.sessionCookie = null; // 令牌复用：会话走令牌交换
          await this.ensureProxy();
          await this.enterReady(false); // 复用就绪：登记本窗口为使用者
          this.deps.log(`[process] 以用户提供的令牌复用 ${this.opts.host}:${this.opts.port} 上已有的 dsh 实例`);
          // 持久化 dsh.externalToken（尽力而为：失败仅记日志，不影响本次会话）
          try {
            await this.deps.onPersistExternalToken?.(decision.token);
          } catch (err) {
            this.deps.log(`[process] 持久化 dsh.externalToken 失败: ${String(err)}`);
          }
          return { outcome: 'reused' };
        }
        tokenAttemptFailed = true; // 令牌无效或实例已变化：再弹三选一并提示
        continue;
      }
      if (decision.kind === 'retry') return { outcome: 'retry' };
      return { outcome: 'fallback' };
    }
  }

  /** 持久化会话 Cookie（尽力而为：失败仅记日志，不影响启动流程） */
  private async persistSessionCookie(cookie: string): Promise<void> {
    const store = this.deps.cookieStore;
    if (!store) return;
    try {
      await store.save(this.opts.host, this.opts.port, cookie);
      this.deps.log(`[proxy] 会话 Cookie 已持久化（${this.opts.host}:${this.opts.port}，可供其他窗口/下次会话复用）`);
    } catch (err) {
      this.deps.log(`[proxy] 会话 Cookie 持久化失败: ${String(err)}`);
    }
  }

  /** 清除持久化会话 Cookie（尽力而为：探测 401/实例失联即视为失效） */
  private async forgetSessionCookie(): Promise<void> {
    const store = this.deps.cookieStore;
    if (!store) return;
    try {
      await store.clear(this.opts.host, this.opts.port);
      this.deps.log(`[proxy] 已清除持久化会话 Cookie（${this.opts.host}:${this.opts.port}）`);
    } catch (err) {
      this.deps.log(`[proxy] 清除持久化会话 Cookie 失败: ${String(err)}`);
    }
  }

  // —— 跨窗口 owner 记录（共享服务归属）：owner 窗口在自启子进程就绪时写 pid，
  //    复用窗口点 Stop Service 时据此识别归属；所有清理都按「记录的 pid 与本窗口子进程一致」
  //    才执行（clear-if-mine），避免多窗口冷启动竞态下误删他窗口的记录 ——

  /** 记录自启子进程 pid（就绪时；未注入存储则跳过；pid 未知时记日志） */
  private async publishOwnerPid(pid: number | undefined): Promise<void> {
    const store = this.deps.ownerStore;
    if (!store) return;
    if (pid === undefined) {
      this.deps.log(`[owner] 自启子进程 pid 未知，跳过跨窗口 owner 记录（${this.opts.host}:${this.opts.port}）`);
      return;
    }
    try {
      await store.save(this.opts.host, this.opts.port, pid);
      this.deps.log(`[owner] 已记录自启进程 pid=${pid}（${this.opts.host}:${this.opts.port}）`);
    } catch (err) {
      this.deps.log(`[owner] 记录自启进程 pid 失败: ${String(err)}`);
    }
  }

  /** 清理 owner 记录（仅当存储中记录的 pid 与给定 pid 一致，防误删他窗口的记录） */
  private async clearOwnerPidIfMine(pid: number | undefined): Promise<void> {
    const store = this.deps.ownerStore;
    if (!store || pid === undefined) return;
    try {
      const stored = await store.load(this.opts.host, this.opts.port);
      if (stored === pid) {
        await store.clear(this.opts.host, this.opts.port);
        this.deps.log(`[owner] 已清除跨窗口 owner 记录（pid=${pid}，${this.opts.host}:${this.opts.port}）`);
      }
    } catch (err) {
      this.deps.log(`[owner] 清除跨窗口 owner 记录失败: ${String(err)}`);
    }
  }

  /** 读取本 host:port 的 owner 记录（未注入存储/读取失败视为无记录） */
  private async readSharedOwner(): Promise<{ pid: number } | null> {
    const store = this.deps.ownerStore;
    if (!store) return null;
    try {
      const pid = await store.load(this.opts.host, this.opts.port);
      return pid === null || pid === undefined ? null : { pid };
    } catch (err) {
      this.deps.log(`[owner] 读取跨窗口 owner 记录失败: ${String(err)}`);
      return null;
    }
  }

  // —— 使用者注册表（「最后一个使用者退出才清理」协议）：窗口进入 ready（连接服务）时登记
  //    本窗口扩展宿主 pid，停止使用（stop/脱钩/失联/退出）时注销；退出清理据此判定是否还有
  //    其他窗口在使用该服务。所有读写都 try/catch 记日志，绝不抛出（注册表只是协调手段，
  //    存取失败仅降级为旧行为，不得中断启动/停止流程）——

  /** 登记本窗口为服务使用者（进入 ready 时；未注入存储则跳过；重复登记去重） */
  private async registerSelf(): Promise<void> {
    const store = this.deps.usersStore;
    if (!store) return;
    const selfPid = this.deps.selfPid ?? process.pid;
    const authority = `${this.opts.host}:${this.opts.port}`;
    try {
      const record = await store.load(this.opts.host, this.opts.port);
      const list = Array.isArray(record?.extPids) ? record.extPids : [];
      if (list.includes(selfPid)) return; // 已登记（幂等）：不重复写
      const next = [...list, selfPid];
      await store.save(this.opts.host, this.opts.port, { extPids: next });
      this.sharedUseSignaled = true; // F5：本会话已成为注册表参与者（共享使用迹象）
      this.persistLog(`[users] ${authority} 本窗口登记为服务使用者（pid=${selfPid}，现存 ${next.length} 个窗口）`);
    } catch (err) {
      this.persistLog(`[users] ${authority} 登记服务使用者失败（pid=${selfPid}）: ${String(err)}`);
    }
  }

  /** 注销本窗口（停止使用/退出时；未登记过则不动注册表；清空后删除键） */
  private async unregisterSelf(): Promise<void> {
    const store = this.deps.usersStore;
    if (!store) return;
    const selfPid = this.deps.selfPid ?? process.pid;
    const authority = `${this.opts.host}:${this.opts.port}`;
    try {
      const record = await store.load(this.opts.host, this.opts.port);
      const list = Array.isArray(record?.extPids) ? record.extPids : [];
      if (!list.includes(selfPid)) return; // 未登记过（或已注销）：不动注册表
      const next = list.filter((pid) => pid !== selfPid);
      if (next.length === 0) {
        await store.clear(this.opts.host, this.opts.port);
      } else {
        await store.save(this.opts.host, this.opts.port, { extPids: next });
      }
      this.persistLog(`[users] ${authority} 本窗口注销服务使用者（pid=${selfPid}${next.length > 0 ? `，剩余 ${next.length} 个窗口` : '，无剩余使用者'}）`);
    } catch (err) {
      // 窗口退出（deactivate）期间 globalState 写入会被拒（存储服务已关闭）：属预期，
      // 残留由 pruneDeadUsers 的 selfPid 过滤与后续窗口的死 pid 过滤自愈。
      this.persistLog(`[users] ${authority} 注销服务使用者失败（pid=${selfPid}）: ${String(err)}（退出期间存储已关闭属预期，残留由死 pid 过滤自愈）`);
    }
  }

  /**
   * 过滤注册表中的失效条目：本窗口自己的残留（注销写回失败等）+ 已死的窗口 pid
   * （崩溃/强杀残留——deactivate 与 exit 钩子都没跑），顺带回写清理。
   * 返回仍存活的「其他窗口」pid 列表（自己不算：退出中的本窗口无论注册表写入成败都不计数）。
   * 读取失败返回 null（调用方按无法确认处理）；**写回清理失败不影响判定结果**——
   * 退出期间 globalState 写入会被拒（VS Code deactivate 时存储服务已关闭），若把写回
   * 失败并入读取失败返回 null，owner 窗口退出会降级 stop() 误杀其他窗口正在使用的
   * 共享服务（v0.3.11 线上根因：注销/过滤写回双双被拒 → prune 返回 null → 误杀）。
   * 残留条目由后续窗口的 prune 死 pid 过滤自愈。
   */
  private async pruneDeadUsers(): Promise<number[] | null> {
    const store = this.deps.usersStore;
    if (!store) return [];
    const selfPid = this.deps.selfPid ?? process.pid;
    const authority = `${this.opts.host}:${this.opts.port}`;
    const ext = this.deps.externalProcess ?? defaultExternalProcess;
    let list: number[];
    try {
      const record = await store.load(this.opts.host, this.opts.port);
      list = Array.isArray(record?.extPids) ? record.extPids : [];
    } catch (err) {
      this.persistLog(`[users] ${authority} 使用者注册表读取失败: ${String(err)}`);
      return null;
    }
    const kept = list.filter((pid) => pid !== selfPid && ext.isAlive(pid));
    if (kept.length > 0) this.sharedUseSignaled = true; // F5：本会话曾见过其他存活使用者
    if (kept.length !== list.length) {
      // 写回清理尽力而为：失败不影响力判定（仍返回 kept）
      try {
        if (kept.length === 0) {
          await store.clear(this.opts.host, this.opts.port);
        } else {
          await store.save(this.opts.host, this.opts.port, { extPids: kept });
        }
        this.persistLog(`[users] ${authority} 过滤 ${list.length - kept.length} 个失效使用者条目（崩溃/强杀/退出残留，剩余 ${kept.length} 个窗口）`);
      } catch (err) {
        this.persistLog(`[users] ${authority} 失效条目写回清理失败: ${String(err)}（不影响力判定；退出期间存储已关闭属预期，残留由后续死 pid 过滤自愈）`);
      }
    }
    return kept;
  }

  /** 就绪状态下子进程意外退出：回到 idle（面板据此显示"已断开"） */
  private handleUnexpectedExit(child: ChildProcessLike): void {
    if (this.child !== child) return; // 已被 stopOwned 接管或已替换
    this.child = null;
    this.authToken = null; // 子进程退出，其访问令牌随之失效
    this.sessionCookie = null; // 防御性清空（自启实例不走 Cookie 会话）
    void this.stopProxy(); // 代理随令牌一起销毁
    void this.clearOwnerPidIfMine(child.pid); // 子进程意外退出（含被其他窗口强停）：清跨窗口 owner 记录
    if (this.snapshot.state === 'ready') {
      void this.unregisterSelf(); // 服务已死：本窗口不再使用，注销使用者登记
      this.clearHealthWatch();
      this.set({ state: 'idle', url: null, embedUrl: null, owned: false, error: null });
    }
  }

  /** 就绪后周期探测：发现服务不再是 DSH 时回到 idle（面板据此显示"已断开"） */
  private startHealthWatch(): void {
    this.clearHealthWatch();
    const interval = this.deps.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    if (interval <= 0) return;
    this.healthTimer = setInterval(() => {
      // 健康探测必须携带访问令牌（或复用外来实例时的会话 Cookie）：
      // 新版 dsh 未认证返回 401，会被误判为「服务失联」而回到 idle
      void this.deps.probeService(
        this.opts.host, this.opts.port, this.opts.timeoutMs,
        this.authToken ?? undefined,
        this.authToken === null ? this.sessionCookie ?? undefined : undefined,
      ).then((result) => {
        if (result !== 'dsh' && this.snapshot.state === 'ready') {
          this.clearHealthWatch(); // 已回 idle，定时器自清理，不空转
          void this.stopProxy(); // 服务失联：代理一并销毁
          void this.unregisterSelf(); // 服务失联：本窗口停止使用，注销使用者登记
          // 复用外来实例（Cookie 会话）失效：同步清除持久化 Cookie，
          // 避免下次启动再拿失效凭据探测（持久化凭据只在验证有效时保留）
          if (!this.child && this.sessionCookie !== null) {
            this.sessionCookie = null;
            void this.forgetSessionCookie();
          }
          this.set({ state: 'idle', url: null, embedUrl: null, owned: false, error: null });
        }
      });
    }, interval);
  }

  /**
   * 确保面板嵌入代理就绪（幂等）：令牌/端口未变时复用，否则重建并重新交换会话 Cookie。
   * 新版 dsh 的 SameSite=Strict 会话 Cookie 在 VS Code webview（跨站子框架）中无法回传，
   * 面板必须经代理访问；旧版 dsh（无令牌）不需要代理，直接返回。
   * 复用外来实例（无令牌但有会话 Cookie）时代理以预置 Cookie 启动，跳过令牌交换。
   * 令牌交换成功后把会话 Cookie 持久化（同 authority 的 Cookie 跨 dsh 重启/跨窗口有效，
   * 其他窗口/下次会话无令牌也能据此复用该实例）。
   * 代理启动失败时重试最多 PROXY_RETRY_ATTEMPTS 次（dsh 可能尚未完全就绪导致交换失败），
   * 全部失败则记录日志，面板将显示"正在连接"占位页而非 401 白屏。
   */
  private async ensureProxy(): Promise<void> {
    const token = this.authToken;
    const cookie = this.sessionCookie;
    if (!token && !cookie) {
      this.deps.log('[proxy] 令牌未解析到（新版 dsh 启动行尚未输出）或旧版无令牌，跳过建代理');
      return;
    }
    // key 含令牌或 Cookie 会话标记：任一变化时重建代理并重新交换
    const key = token
      ? `${token}@${this.opts.host}:${this.opts.port}`
      : `cookie@${this.opts.host}:${this.opts.port}`;
    if (this.proxy && this.proxyKey === key) return;
    await this.stopProxy();
    const factory = this.deps.proxyFactory ?? createDefaultProxyFactory(this.deps.log);
    for (let attempt = 1; attempt <= PROXY_RETRY_ATTEMPTS; attempt++) {
      try {
        const proxy = factory({
          target: { host: this.opts.host, port: this.opts.port },
          token: token ?? '',
          // 预置 Cookie 仅用于无令牌的复用场景；有令牌时必须走令牌交换
          initialCookie: token ? undefined : cookie ?? undefined,
        });
        await proxy.start();
        this.proxy = proxy;
        this.proxyKey = key;
        this.deps.log(`[proxy] 面板嵌入代理已启动: ${proxy.url}（webview 无 Cookie 访问）`);
        if (token) {
          const session = proxy.sessionCookie;
          if (typeof session === 'string' && session) await this.persistSessionCookie(session);
        }
        return;
      } catch (err) {
        this.proxy = null;
        this.proxyKey = null;
        if (attempt < PROXY_RETRY_ATTEMPTS) {
          this.deps.log(`[proxy] 面板嵌入代理启动失败（第 ${attempt}/${PROXY_RETRY_ATTEMPTS} 次），${PROXY_RETRY_DELAY_MS}ms 后重试: ${String(err)}`);
          await new Promise((r) => setTimeout(r, PROXY_RETRY_DELAY_MS));
        } else {
          this.deps.log(`[proxy] 面板嵌入代理启动失败（已重试 ${PROXY_RETRY_ATTEMPTS} 次），面板将显示"正在连接"占位页: ${String(err)}`);
        }
      }
    }
  }

  /** 停止面板嵌入代理（幂等） */
  private async stopProxy(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = null;
    this.proxyKey = null;
    if (proxy) {
      try {
        await proxy.stop();
      } catch (err) {
        this.deps.log(`[proxy] 停止代理失败: ${String(err)}`);
      }
    }
  }

  /** 清除健康探测定时器 */
  private clearHealthWatch(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** 应用新配置；仅 host/port 变化且自启服务在跑时自动重启（其余项原地生效） */
  reconfigure(opts: ManagerOptions): Promise<ServiceSnapshot> {
    const portActuallyChanged = opts.port !== this.originalPort;
    const hostChanged = this.opts.host !== opts.host;
    const targetChanged = hostChanged || portActuallyChanged;
    const tokenChanged = this.opts.externalToken !== opts.externalToken;
    this.originalPort = opts.port;
    if (!portActuallyChanged && this.opts.port !== opts.port) {
      opts = { ...opts, port: this.opts.port };
    }
    this.opts = opts;
    if (targetChanged) {
      if (this.child) return this.restart();
      // 复用外部服务时只更新地址展示，实际可达性由下次 ensureRunning 重新探测
      if (this.snapshot.state === 'ready') {
        // 目标端口变化但无自启子进程：代理目标失效，销毁后由下次就绪重建
        this.sessionCookie = null; // 旧地址的会话 Cookie 不再适用（新地址凭据由下次复用时验证）
        void this.stopProxy();
        this.set({ url: this.url(), embedUrl: null });
      }
    } else if (tokenChanged && !this.child && this.snapshot.state === 'ready') {
      // 外部令牌变化（复用外部实例场景）：立即换令牌刷新地址与代理（下次探测用新令牌）
      this.authToken = this.opts.externalToken ?? null;
      this.sessionCookie = null; // 令牌模式：会话改为令牌交换，不再使用旧 Cookie
      void (async () => {
        await this.ensureProxy(); // key 含令牌：变化时自动重建代理并重新交换
        this.set({ url: this.url(), embedUrl: this.proxy?.url ?? null });
      })();
    }
    return Promise.resolve(this.getSnapshot());
  }

  /** stopOnExit=false 时保持服务运行：移除父进程退出杀子钩子 */
  setExitBehavior(keepAlive: boolean): void {
    if (keepAlive) {
      process.removeListener('exit', this.parentExitHook);
    } else if (!process.listeners('exit').includes(this.parentExitHook)) {
      process.once('exit', this.parentExitHook);
    }
  }

  /** 清理：移除钩子与监听器（不杀子进程，停止由 stop() 决定）；
   * 仍有活跃子进程时保留父进程退出钩子，防止启动流程中被 dispose 后成孤儿。
   * 证实无杀伤路径：dispose 只清健康定时器/嵌入代理/监听器与（无子进程时的）exit
   * 钩子，绝不调用 stop/kill——移交场景（child 存活 + skipExitKill=true）deactivate
   * 尾部调用本方法后，子进程由保留的 exit 钩子按 skipExitKill/sharedUseSignaled 决策。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHealthWatch();
    void this.stopProxy();
    if (!this.child) process.removeListener('exit', this.parentExitHook);
    this.listeners.clear();
  }
}
