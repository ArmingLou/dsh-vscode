// src/extension.ts — 插件入口：装配各模块、注册命令、监听配置变更
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { initI18n, t } from './i18n';
import { readConfig, normalizeExternalToken, type DshConfig } from './config';
import { probeService } from './service/detect';
import { createProcessRunner, findInPath, resolveLoginShellPath, mergePath, findInPathPosix, scanCommonDshLocations, defaultExecSync, type ResolveResult } from './service/process';
import { ServiceManager, type ManagerOptions, type SessionCookieStore, type OwnerPidStore, type UsersStore, type UsersRecord } from './service/manager';
import { DshPanelProvider } from './panel/provider';
import { StatusBarController } from './statusbar';
import { resolveWorkspaceRoot } from './workspaceRoot';
import { createUrlResolver } from './remote';
import { createDshApiClient } from './bridge/api';
import { syncWorkspace } from './bridge/sync';
import {
  installBridge,
  uninstallBridge,
  createNodeFs,
  type BridgeInstallResult,
} from './bridge/installer';
import { cleanupAllImageCaches, cleanupStaleImageCaches } from './bridge/host';
import * as nodeFs from 'node:fs/promises';
import { evaluateBridgeStatus, bridgeWarningText } from './bridge/status';

let manager: ServiceManager | null = null;
let output: vscode.OutputChannel | null = null;
/** 当前展示用本地可达 URL 的来源（读面板解析结果；远程=隧道 URL，本地=null 回退原地址） */
let getDisplayUrl: (() => string | null) | null = null;

/** 日志缓冲（供「复制日志」命令 dsh.copyLogs 使用；上限行数防内存膨胀） */
const logBuffer: string[] = [];
/** 日志缓冲最大行数（超出后丢弃最早的行） */
const LOG_BUFFER_MAX = 5000;

/** 统一日志出口：加 HH:MM:SS 时间戳 → 写入输出通道 + 日志缓冲（复制日志命令的数据源） */
function appendLog(line: string): void {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const full = `[${ts}] ${line}`;
  logBuffer.push(full);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  output?.appendLine(full);
}

/** globalState 键：用户点击「不再提示」后置 true，持久静默桥接降级警告 */
const BRIDGE_SILENCE_KEY = 'dsh.bridgeWarningSilenced';
/**
 * 握手超时（毫秒）：面板打开且服务就绪后，此时间内无任何 bridgeAck 视为握手失败。
 * 曾为 3s：重装/冷启动时 dsh web 首屏需引导十余个 client 模块再初始化 UI，
 * 3 秒内来不及握手，导致误报「bridge 未激活」+ 面板首屏白屏（实测 07:45 热启动 1s 内
 * 握手成功、14:16 冷启动 3s 超时）。放宽到 20s，并配合「超时后自动重载面板重试一次」。
 */
const HANDSHAKE_TIMEOUT_MS = 20000;
/** 激活后评估桥接状态的延迟（毫秒）：给握手回执留出时间（不小于握手超时+重试余量） */
const BRIDGE_EVAL_DELAY_MS = 22000;

/** DshConfig → ManagerOptions（探测 3s、轮询 0.5s，与规格一致） */
function toManagerOptions(config: DshConfig): ManagerOptions {
  return {
    host: config.host,
    port: config.port,
    extraArgs: config.extraArgs,
    autoStart: config.autoStart,
    // 子进程工作目录兜底：按 dsh.workspaceRootIndex 解析工作区根目录，让 dsh web 以工作区为 cwd
    cwd: resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], config.workspaceRootIndex),
    executablePath: config.executablePath,
    openInBrowser: config.openInBrowser,
    externalToken: config.externalToken, // 复用外部已启动实例的访问令牌（dsh.externalToken）
    timeoutMs: 3000,
    pollMs: 500,
  };
}

/**
 * 计算 npm 全局 node_modules 目录（Windows 且 dsh 可定位时）。
 *
 * 背景：Windows 下 VS Code 扩展宿主 spawn 的 dsh 进程对 profile 插件的 ESM 解析与普通命令行
 * 进程不同，profiles 双位置仍可能解析不到桥接包；而 npm 全局 node_modules
 * （AppData\Roaming\npm\node_modules）是确定可达的位置。本函数据此返回该目录作为第三安装目标。
 *
 * 规则（仅 win32）：
 * - 优先 config.executablePath（非空且不以 .js 结尾）→ dirname；
 * - 否则 findInPath('dsh.cmd', process.env.PATH) → dirname；
 * - 都找不到 → undefined（不传，保持双位置向后兼容）。
 * - 非 win32 → undefined。
 */
function resolveNpmGlobalNodeModules(config: DshConfig): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const exec = config.executablePath;
  if (exec && !exec.endsWith('.js')) {
    return dirname(exec);
  }
  const found = findInPath('dsh.cmd', process.env.PATH ?? '');
  if (found) {
    return dirname(found);
  }
  return undefined;
}

/**
 * 定位 dsh 可执行文件并读取其版本（Windows 由 dsh.cmd 推导 bin.js 后读包内 package.json）。
 * 用于环境信息头：问题报告据此核对 dsh 安装位置与版本，无需再追问用户环境。
 */
function describeDshExecutable(config: DshConfig, logFn: (line: string) => void): { path: string | null; version: string | null } {
  let shim: string | null = null;
  let binJs: string | null = null;
  if (process.platform === 'win32') {
    shim = config.executablePath && !config.executablePath.endsWith('.js')
      ? config.executablePath
      : findInPath('dsh.cmd', process.env.PATH ?? '');
    if (shim) {
      binJs = shim.endsWith('.js')
        ? shim
        : join(dirname(shim), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    }
  } else {
    if (config.executablePath && config.executablePath.length > 0) {
      shim = config.executablePath;
      logFn(`[dsh-locate] executablePath=${shim}, skipping PATH resolution`);
    } else {
      const hostPath = process.env.PATH ?? '';
      const resolve: ResolveResult = resolveLoginShellPath(process.env.SHELL, defaultExecSync, hostPath, logFn);
      const merged = mergePath(resolve.path, hostPath, ':');
      const hasNvm = merged.includes('.nvm/versions/node');
      logFn(`[dsh-locate] usedShell=${resolve.usedShell ?? '(无)'} hasNvm=${hasNvm} in merged PATH`);
      const found = findInPathPosix('dsh', merged);
      if (found) {
        logFn(`[dsh-locate] findInPathPosix=${found} shim=${found}`);
        shim = found;
      } else {
        logFn(`[dsh-locate] findInPathPosix=(未命中), scanning common locations...`);
        const scanned = scanCommonDshLocations(undefined, undefined, undefined, logFn);
        shim = scanned ?? 'dsh';
        logFn(`[dsh-locate] scanCommonDshLocations=${scanned ?? '(未命中)'} shim=${shim}`);
      }
    }
    if (shim && shim !== 'dsh') {
      try {
        const versionOutput = defaultExecSync(`"${shim}" --version`).trim();
        const firstLine = versionOutput.split('\n')[0];
        if (firstLine) return { path: shim, version: firstLine };
      } catch {
        // 版本探测失败按未知处理
      }
    }
  }
  if (binJs) {
    try {
      const version = JSON.parse(readFileSync(join(dirname(dirname(binJs)), 'package.json'), 'utf8')).version;
      return { path: shim, version };
    } catch {
      /* 读取失败按版本未知处理 */
    }
  }
  return { path: shim, version: null };
}

/** 插件激活：VS Code 启动完成后调用 */
export function activate(context: vscode.ExtensionContext): void {
  // 语言规则：vscode.env.language 以 zh- 开头 → 中文，其余一律英文
  initI18n(vscode.env.language);
  output = vscode.window.createOutputChannel('DSH');

  const { config, errors } = readConfig();
  for (const err of errors) appendLog(`[config] ${err}`);

  // —— 环境信息头：版本/平台/可执行文件/关键配置，问题报告排查的第一手依据 ——
  appendLog('=== DSH 扩展环境信息 ===');
  appendLog(`扩展版本: ${context.extension.packageJSON.version}`);
  appendLog(`VS Code 版本: ${vscode.version}`);
  appendLog(`平台: ${process.platform} (${process.arch})`);
  const electronVersion = (process.versions as { electron?: string }).electron;
  appendLog(`宿主 Node: ${process.version}${electronVersion ? ` / Electron ${electronVersion}` : ''}`);
  const dshInfo = describeDshExecutable(config, appendLog);
  appendLog(`dsh 可执行文件: ${dshInfo.path ?? '未定位'}`);
  appendLog(`dsh 版本: ${dshInfo.version ?? '未知'}`);
  appendLog(
    `配置: host=${config.host} port=${config.port} autoStart=${config.autoStart} stopOnExit=${config.stopOnExit} ` +
    `bridgeEnabled=${config.bridgeEnabled} extraArgs=${JSON.stringify(config.extraArgs)} ` +
    `executablePath=${config.executablePath || '(空)'} shortcutMappings=${Object.keys(config.shortcuts).length}`,
  );
  appendLog(`工作区: ${vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join(', ') || '(无)'}`);
  appendLog('=============================');

  // —— 桥接状态（扩展级单一状态：握手/评估只跑一套，面板只负责展示与回执转发）——
  // install：桥接安装结果；桥接禁用时为 null（不安装、不评估、不弹警告）。
  // handshakeOk：握手回执（onBridgeAck 写入）；undefined=尚未握手，true/false=握手成败。
  let install: BridgeInstallResult | null = null;
  let handshakeOk: boolean | undefined;
  let handshakeTimer: NodeJS.Timeout | undefined;
  let evalTimer: NodeJS.Timeout | undefined;
  let panelOpened = false; // 是否已有面板打开过（触发握手超时的前提之一）
  let warningShown = false; // 本次会话是否已弹过降级警告（防止重复弹）
  let handshakeRetries = 0; // 握手超时后的自动重载重试次数（每个就绪周期最多 1 次；防无限重载）

  /** 桥接安装参数（dshHome / bridgeSourceDir 全插件共用，避免三处重复拼接；Windows 装配第三安装目标） */
  const installOpts = {
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    bridgeSourceDir: join(__dirname, 'bridge-client'),
    fs: createNodeFs(),
    npmGlobalNodeModules: resolveNpmGlobalNodeModules(config),
  };

  /**
   * 安全安装桥接：installBridge 的 IO 异常会直接抛出（Task 2 已知局限），
   * 此处 try/catch 捕获后按 degraded 处理（原因写入日志），绝不影响面板其它功能。
   */
  function safeInstallBridge(): BridgeInstallResult {
    try {
      return installBridge(installOpts);
    } catch (err) {
      appendLog(`[bridge] install failed: ${String(err)}`);
      return { status: 'degraded', reason: String(err) };
    }
  }

  // 激活时安装桥接：bridge.enabled=false 时不安装、不注入握手脚本、不评估、不弹警告
  if (config.bridgeEnabled) {
    install = safeInstallBridge();
  }

  /** 清除握手超时定时器（收到回执或重试时调用） */
  function clearHandshakeTimer(): void {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    }
  }

  /**
   * 启动握手超时（幂等）：面板已打开且服务已就绪、且尚未回执时，3 秒内无 bridgeAck 视为失败。
   * 服务未就绪时没有 iframe、握手不可能发生，因此不在此刻启动定时器，
   * 避免「服务启动慢」被误判为桥接降级；待 manager 进入 ready 后由 onChange 再触发。
   */
  function startHandshakeTimeout(): void {
    if (install === null) return; // 桥接被禁用：无握手脚本，不启动定时器
    if (handshakeOk !== undefined || handshakeTimer !== undefined) return;
    if (!panelOpened) return;
    if (manager?.getSnapshot().state !== 'ready') return;
    handshakeTimer = setTimeout(() => {
      handshakeTimer = undefined;
      // 超时内无任何 bridgeAck → 先自动重载重试一次（冷启动首屏可能未完成，
      // 模块引导慢/中途 404 会导致页面白屏且握手必然超时），再判失败（degraded）
      if (handshakeOk === undefined) {
        if (handshakeRetries < 1) {
          handshakeRetries += 1;
          appendLog('[bridge] handshake timeout，重载面板重试一次（冷启动首屏可能未完成）');
          refreshPanel(); // 重渲染 = iframe 重载：DSH 页面重新引导并再次握手
          startHandshakeTimeout();
          return;
        }
        appendLog('[bridge] handshake timeout');
        handshakeOk = false;
        setBridgeTrouble(true); // 点亮页面内「加载异常」提示条（提供手动重试入口，不再无声白屏）
        evaluateAndWarn(); // 握手刚失败，立即评估（不必再等固定延迟）
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  /** 握手回执回调（面板注入）：记录结果、取消超时、同步提示条（握手已发生，无论成败） */
  function onBridgeAck(ok: boolean, version?: string): void {
    // 日志带桥接版本：页面里跑的是哪个版本的桥接代码一目了然（排查“装了新版还在跑旧行为”用）
    appendLog(`[bridge] handshake ${ok ? 'ok' : 'failed'}${version ? ` (bridge v${version})` : ''}`);
    handshakeOk = ok;
    handshakeRetries = 0; // 新握手周期重置自动重载计数
    clearHandshakeTimer();
    if (ok) {
      setBridgeTrouble(false); // 握手成功：隐藏「加载异常」提示条（页面已正常工作）
    } else {
      setBridgeTrouble(true); // 页面已加载但桥接失败：点亮提示条供「重试安装桥接」
      evaluateAndWarn();
    }
  }

  /** 重渲染面板（iframe 重载；供握手超时自动重试与外部调用） */
  function refreshPanel(): void {
    panel?.refresh();
  }

  /** 同步面板的「页面加载异常」提示条显隐（纯 postMessage，不重载 iframe） */
  function setBridgeTrouble(trouble: boolean): void {
    panel?.setTrouble(trouble);
  }

  /** 面板首次打开：标记已打开并尝试启动握手超时（幂等，不重复建定时器） */
  function onPanelFirstOpen(): void {
    panelOpened = true;
    startHandshakeTimeout();
  }

  /**
   * 评估桥接状态并在 degraded 时弹警告。
   * 静默条件（任一为真则不弹）：设置项 dsh.bridge.silenceWarning、globalState 静默标志、
   * 或本次会话已弹过；安装/握手成功（ok / pending-restart）也不弹。
   */
  function evaluateAndWarn(): void {
    if (install === null) return; // 桥接被禁用，不评估
    const status = evaluateBridgeStatus(install, handshakeOk);
    if (status !== 'degraded') return;
    if (readConfig().config.silenceWarning) return; // 设置项静默
    if (context.globalState.get<boolean>(BRIDGE_SILENCE_KEY)) return; // 「不再提示」静默
    if (warningShown) return; // 本次会话已弹过
    warningShown = true;
    const text = bridgeWarningText(status);
    if (text === null) return; // 防御性兜底（degraded 必有文案）
    void vscode.window
      .showWarningMessage(t(text), t('bridge.retryNow'), t('bridge.neverAgain'))
      .then((choice) => {
        if (choice === t('bridge.retryNow')) {
          void retryBridge(); // 重试安装：重新 installBridge + 重启服务
        } else if (choice === t('bridge.neverAgain')) {
          void context.globalState.update(BRIDGE_SILENCE_KEY, true); // 不再提示
        }
      });
  }

  /** 调度一次桥接状态评估（可重复调用；重复调用会重置定时器，只保留最后一次） */
  function scheduleEvaluation(): void {
    if (evalTimer) clearTimeout(evalTimer);
    evalTimer = setTimeout(() => {
      evalTimer = undefined;
      evaluateAndWarn();
    }, BRIDGE_EVAL_DELAY_MS);
  }

  /** 重试安装桥接（命令 dsh.bridge.retry 与警告「重试安装」按钮共用） */
  async function retryBridge(): Promise<void> {
    try {
      if (!readConfig().config.bridgeEnabled) return; // 桥接被禁用：不重试
      // 重新安装（异常降级并记日志，不中断重试流程）
      install = safeInstallBridge();
      // 重置握手状态：重启后 iframe 重载会重新握手，onBridgeAck 会写入新结果
      handshakeOk = undefined;
      handshakeRetries = 0;
      clearHandshakeTimer();
      setBridgeTrouble(false); // 重试期间隐藏「加载异常」提示条（iframe 即将重载重握手）
      // 清警告静默（globalState 标志），允许后续再次弹出降级警告
      await context.globalState.update(BRIDGE_SILENCE_KEY, false);
      warningShown = false;
      // 重启服务，触发面板 iframe 重载与重新握手
      await manager?.restart();
      // 重启后重新评估一次（留出握手回执时间）
      scheduleEvaluation();
    } catch (err) {
      // 重试失败只记日志：命令入口是 void 调用，异常不能成为未处理拒绝
      appendLog(`[bridge] retry failed: ${String(err)}`);
    }
  }

  /** 卸载桥接（命令 dsh.bridge.uninstall）：删除 profile 条目与目录，提示需重启 DSH 服务生效 */
  async function uninstallBridgeCmd(): Promise<void> {
    try {
      uninstallBridge(installOpts);
      void vscode.window.showInformationMessage(t('bridge.uninstalled'));
    } catch (err) {
      appendLog(`[bridge] uninstall failed: ${String(err)}`);
      void vscode.window.showWarningMessage(t('bridge.uninstallFailed', { message: String(err) }));
    }
  }

  /** globalState 键：持久化代理会话 Cookie（按 authority 分键，跨窗口共享） */
  const proxyCookieKey = (host: string, port: number): string => `dsh.proxyCookie@${host}:${port}`;
  /**
   * 会话 Cookie 持久化：接 context.globalState（用户级存储，跨窗口共享；
   * workspaceState 不跨窗口，不满足复用要求）。dsh 的会话 Cookie 由机器级持久
   * secret（~/.dsh/.credentials.yaml）签名，同一 authority 的 Cookie 跨 dsh 重启/
   * 跨实例有效——持久化后，其他窗口/下次会话在拿不到外来实例令牌时也能复用该实例。
   */
  const cookieStore: SessionCookieStore = {
    load: (host, port) => context.globalState.get<string>(proxyCookieKey(host, port)) ?? null,
    save: async (host, port, cookie) => {
      await context.globalState.update(proxyCookieKey(host, port), cookie);
    },
    clear: async (host, port) => {
      await context.globalState.update(proxyCookieKey(host, port), undefined);
    },
  };

  /** globalState 键：自启 dsh 子进程 pid 的跨窗口记录（键形仿 cookie 的 dsh.proxyCookie@host:port） */
  const ownerPidKey = (host: string, port: number): string => `dsh.ownerPid@${host}:${port}`;
  /**
   * 跨窗口 owner 记录存取（用户级 globalState 共享）：owner 窗口在自启子进程就绪时写入 pid；
   * 复用窗口点 Stop Service 时读取并校验 pid 存活，据此决定是否提供「强制停止共享服务」。
   * 记录随进程停止/意外退出清理；owner 窗口崩溃残留由消费方按 pid 存活校验兜底（读前先验活）。
   */
  const ownerStore: OwnerPidStore = {
    load: (host, port) => context.globalState.get<number>(ownerPidKey(host, port)) ?? null,
    save: async (host, port, pid) => {
      await context.globalState.update(ownerPidKey(host, port), pid);
    },
    clear: async (host, port) => {
      await context.globalState.update(ownerPidKey(host, port), undefined);
    },
  };

  /** globalState 键：使用中窗口注册表（键形仿 dsh.ownerPid@host:port） */
  const usersKey = (host: string, port: number): string => `dsh.users@${host}:${port}`;
  /**
   * 使用中窗口（扩展宿主 pid）注册表存取（用户级 globalState 共享）：
   * 窗口在 manager 进入 ready（连接服务，含自启就绪与复用就绪）时登记、停止使用/退出时注销；
   * 窗口退出清理（releaseOnExit）据此判定是否「最后一个使用者」——最后使用者退出才自动清理
   * 服务进程（复用 dsh.stopOnExit 语义：true=最后使用者退出才清理；false=永不自动清理）。
   * 本窗口 pid 由 manager 侧取 process.pid（=本窗口扩展宿主进程），此处只管存储。
   */
  const usersStore: UsersStore = {
    load: (host, port) => context.globalState.get<UsersRecord>(usersKey(host, port)) ?? null,
    save: async (host, port, record) => {
      await context.globalState.update(usersKey(host, port), record);
    },
    clear: async (host, port) => {
      await context.globalState.update(usersKey(host, port), undefined);
    },
  };

  /**
   * 探测出口：接入 detect 级诊断日志（非 dsh 判定时记录 HTTP 状态码/响应体片段/错误信息，
   * 定位真实环境中的探测分类偏差——如 401 认证提示文案变化、代理劫持导致的 down）。
   */
  const probeWithDiag = (host: string, port: number, timeoutMs?: number, token?: string, cookie?: string) =>
    probeService(host, port, timeoutMs, token, cookie, (line) => appendLog(line));

  manager = new ServiceManager(toManagerOptions(config), {
    probeService: probeWithDiag,
    processRunner: createProcessRunner(),
    log: (line) => appendLog(line),
    // 端口被占用自动临时替换成功：弹窗告知用户新端口（仅本次会话，配置未变）
    onPortFallback: (requested, fallback) => {
      void vscode.window.showInformationMessage(t('msg.portFallback', { port: requested, fallback }));
    },
    cookieStore,
    ownerStore,
    usersStore,
    // 复用窗口「停止服务」遇到「另一窗口启动的共享服务」时的决策对话框（modal 三选一，
    // 强停前再弹一次红色二次确认；仅 dsh.stop 命令路径会触发，deactivate 的 stop() 绝不弹窗）
    askStopReused: async (info) => {
      const authority = info.authority;
      const detachOnly = t('stop.detachOnly');
      const forceStop = t('stop.forceStop');
      const cancel = t('stop.cancel');
      appendLog(`[stop] ${authority} 上的共享 DSH 服务由另一窗口启动（pid=${info.pid}），弹出停止方式选择`);
      const choice = await vscode.window.showWarningMessage(
        t('stop.sharedPrompt', { authority }),
        { modal: true },
        detachOnly,
        forceStop,
        cancel,
      );
      if (choice === forceStop) {
        // 强停影响所有使用者：二次红色确认后才真正执行（ESC/关闭弹窗按取消处理）
        const confirmStop = t('stop.confirmStop');
        const confirmed = await vscode.window.showWarningMessage(
          t('stop.forceConfirm'),
          { modal: true },
          confirmStop,
          cancel,
        );
        if (confirmed === confirmStop) {
          appendLog(`[stop] 用户二次确认：强制停止共享 DSH 服务（pid=${info.pid}）`);
          return 'force-stop';
        }
        appendLog('[stop] 强停二次确认被取消：保持当前连接');
        return 'cancel';
      }
      if (choice === detachOnly) {
        appendLog('[stop] 用户选择仅断开本窗口连接');
        return 'detach';
      }
      appendLog('[stop] 用户取消停止操作：保持当前连接');
      return 'cancel';
    },
    // 端口冲突强制三选一（dsh-unauthenticated 且 Cookie 复用落空时）：
    // modal 弹窗，ESC/关闭立即重弹直到用户明确选择；等待期间不落任何回退。
    askPortConflict: async (info) => {
      const authority = `${info.host}:${info.port}`;
      const enterToken = t('conflict.enterToken');
      const useOtherPort = t('conflict.useOtherPort');
      const retry = t('conflict.retry');
      appendLog(`[process] ${authority} 疑似被其他终端/窗口启动的 dsh web 占用（未认证），弹出三选一等待用户决策`);
      for (;;) {
        // 流程已被叫停（stop）：不再打扰用户（停止重弹），返回任意决策（manager 会丢弃并保持 idle）
        if (info.isCancelled()) return { kind: 'other-port' };
        const message = info.tokenAttemptFailed
          ? t('msg.portConflictTokenFailed', { authority })
          : t('msg.portConflict', { authority });
        const choice = await vscode.window.showWarningMessage(
          message,
          { modal: true, detail: t('msg.portConflictDetail') },
          enterToken,
          useOtherPort,
          retry,
        );
        if (info.isCancelled()) return { kind: 'other-port' };
        if (choice === enterToken) {
          const input = await vscode.window.showInputBox({
            prompt: t('conflict.tokenPrompt', { authority }),
            placeHolder: t('conflict.tokenPlaceholder'),
            ignoreFocusOut: true, // 点击别处不关闭：令牌粘贴过程不因失焦而丢失
          });
          if (info.isCancelled()) return { kind: 'other-port' };
          // 复用 externalToken 归一化逻辑：兼容完整 URL / 整行启动日志 / 纯令牌
          const token = input === undefined ? '' : normalizeExternalToken(input);
          if (token === '') continue; // 输入框取消或空输入：回到三选一
          appendLog(`[process] 用户选择以令牌复用 ${authority}（输入已归一化），交由服务管理器验证`);
          return { kind: 'token', token };
        }
        if (choice === useOtherPort) {
          appendLog(`[process] 用户选择换端口启动新实例（${authority} 被其他 dsh 实例占用）`);
          return { kind: 'other-port' };
        }
        if (choice === retry) {
          appendLog(`[process] 用户选择按原流程重试（重新探测 ${authority}）`);
          return { kind: 'retry' };
        }
        // ESC / 关闭弹窗：立即重新弹出三选一（循环直到明确选择，不落任何回退）
      }
    },
    // 「输入令牌重试」验证有效（303 命中）后：写入 dsh.externalToken 设置（用户级），
    // 后续会话/其他窗口可直接复用该实例；无效令牌绝不写入。
    onPersistExternalToken: (token) => {
      void vscode.workspace.getConfiguration('dsh')
        .update('externalToken', token, vscode.ConfigurationTarget.Global)
        .then(
          () => appendLog('[process] 已写入 dsh.externalToken 设置（用户级）：后续会话可直接复用该实例'),
          (err: unknown) => appendLog(`[process] 写入 dsh.externalToken 设置失败: ${String(err)}`),
        );
    },
  });
  manager.setExitBehavior(!config.stopOnExit);

  // 工作区根目录解析：多根工作区按 dsh.workspaceRootIndex 取根（越界回退第一个）。
  // 该 getter 仅用于 provider 的文件相对路径解析（openFile 的 workspaceRoot 兜底基准）。
  const workspaceRootGetter = (): string | undefined =>
    resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], readConfig().config.workspaceRootIndex);
  // 桥接启用 getter：随时读取最新配置，供 readyPage 决定是否注入握手脚本
  const bridgeEnabledGetter = (): boolean => readConfig().config.bridgeEnabled;
  // 远程启用 getter：v0.3.0 由 dsh.remote.enabled 驱动（默认关闭，远程窗口不自动启动远端 dsh）
  const remoteEnabledGetter = (): boolean => readConfig().config.remoteEnabled;
  // 图片降级 getter：dsh.image.fallback 驱动桥接客户端「非视觉模型自动降级」行为
  const imageFallbackGetter = (): boolean => readConfig().config.imageFallback;
  // 快捷键映射 getter：dsh.bridge.shortcuts（含默认映射）随握手消息带给桥接客户端
  const shortcutsGetter = (): Record<string, string> => readConfig().config.shortcuts;
  // 上次渲染用快捷键映射（配置变更时对比，决定是否重渲染面板让 iframe 重新握手）
  let lastShortcuts: Record<string, string> = config.shortcuts;
  // URL 解析器：远程窗口经 vscode.env.asExternalUri 建立端口隧道，返回本地可达 URL；本地原样返回
  const resolveExternalUrl = createUrlResolver({
    asExternalUri: async (uri) => await vscode.env.asExternalUri(vscode.Uri.parse(uri.toString())),
  });

  // 唯一面板（左侧活动栏视图 dsh.panel）的 provider；与 manager 一一对应（服务状态一致）
  const panel = new DshPanelProvider(
    manager,
    onPanelFirstOpen, // 面板首次打开：标记并尝试启动握手超时
    onBridgeAck,
    workspaceRootGetter,
    bridgeEnabledGetter,
    remoteEnabledGetter,
    resolveExternalUrl,
    imageFallbackGetter,
    shortcutsGetter,
    () => {
      void retryBridge(); // 「重新加载异常提示条」的「重试安装桥接」按钮 → 重装桥接并重启服务
    },
    () => {
      void syncWorkspaceOnce(); // 桥接握手成功后触发工作区同步
    },
  );
  // 复制网址命令读取面板的展示 URL（远程=隧道本地 URL）
  getDisplayUrl = () => panel.getDisplayUrl();
  new StatusBarController(manager);

  /**
   * 「断开面板连接」命令（dsh.disconnect）：唯一面板直接命中，无需多面板路由。
   * 面板未在显示（命令面板触发等）时不操作——沿用旧语义：面板隐藏时绝不误断。
   * 单面板语义：断开面板（粘性占位页 + 销毁 iframe）后，本窗口已无任何面板在嵌入
   * 「窗口共享嵌入代理」→ 无条件停掉代理（disconnectEmbed 幂等，代理未启用时为 no-op；
   * 后端进程、子进程所有权、退出钩子、健康探测一律不受影响）。
   */
  function disconnectPanelCmd(): void {
    if (!panel.isViewVisible()) return; // 面板未在显示：命令无操作
    if (!panel.disconnectPanel()) return; // 已断开 / 远程未启用窗口：无操作
    void manager?.disconnectEmbed();
  }

  /**
   * 「停止服务」命令（dsh.stop，面板标题栏 Stop Service）：
   * - 自有服务（owned）或服务未就绪 → 直接 manager.stop()（原有语义，无弹窗）；
   * - 复用他窗口的共享服务（ready 且 owned=false）→ manager.stopSharedService()：
   *   有存活 owner 记录 → 弹「仅断开本窗口连接 / 强制停止服务 / 取消」+ 强停二次确认
   *   （对话框在注入的 askStopReused 回调内，见上）；无记录 / 记录失效 → 提示后仅脱钩。
   * 程序化停止（deactivate/窗口关闭）仍走 manager.stop() 纯脱钩路径，绝不弹窗。
   */
  function stopServiceCmd(): void {
    const m = manager;
    if (!m) return;
    void (async () => {
      const s = m.getSnapshot();
      if (s.owned || s.state !== 'ready') {
        await m.stop();
        return;
      }
      const outcome = await m.stopSharedService();
      const authority = `${m.getTarget().host}:${m.getTarget().port}`;
      if (outcome === 'no-record') {
        void vscode.window.showInformationMessage(t('stop.noOwnerRecord', { authority }));
      } else if (outcome === 'gone') {
        void vscode.window.showInformationMessage(t('stop.ownerDead'));
      } else if (outcome === 'kill-failed') {
        void vscode.window.showWarningMessage(t('stop.killFailed', { authority }));
      }
      // cancel / detach / force-killed：对话框/面板状态已表达结果，不再追加通知
    })();
  }

  // 服务就绪后启动握手超时（若面板已打开）
  manager.onChange((s) => {
    if (s.state === 'ready') {
      startHandshakeTimeout(); // 服务就绪：若面板已打开，启动握手超时
    }
  });

  /** 工作区同步：取当前 VS Code 工作区根目录 → dsh workspace/create（幂等）→ workspaceId 下发到 iframe */
  let workspaceSynced = false;
  async function syncWorkspaceOnce(): Promise<void> {
    if (workspaceSynced) return;
    const root = workspaceRootGetter();
    if (root === undefined) return;
    const snapshot = manager?.getSnapshot();
    if (!snapshot || snapshot.state !== 'ready' || !snapshot.url) return;
    try {
      const api = await createDshApiClient(snapshot.url, manager?.getSessionCookie() ?? undefined);
      const ws = await syncWorkspace(api, root);
      workspaceSynced = true;
      panel.setWorkspaceId(ws.workspaceId);
      appendLog(`[bridge] workspace synced: ${ws.workspaceId} (${root})`);
    } catch (err) {
      appendLog(`[bridge] workspace sync failed: ${String(err)}`);
    }
  }

  context.subscriptions.push(
    // 第三参数：隐藏面板时保留 webview（iframe 不销毁、DSH 页面会话不丢）
    vscode.window.registerWebviewViewProvider('dsh.panel', panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.openPanel', () => openPanel()),
    vscode.commands.registerCommand('dsh.openExternal', () => openExternal()),
    vscode.commands.registerCommand('dsh.restart', () => void manager?.restart()),
    vscode.commands.registerCommand('dsh.stop', () => stopServiceCmd()),
    vscode.commands.registerCommand('dsh.disconnect', () => disconnectPanelCmd()),
    vscode.commands.registerCommand('dsh.copyUrl', () => copyUrl()),
    vscode.commands.registerCommand('dsh.showLogs', () => output?.show()),
    vscode.commands.registerCommand('dsh.copyLogs', () => copyLogs()),
    vscode.commands.registerCommand('dsh.bridge.retry', () => void retryBridge()),
    vscode.commands.registerCommand('dsh.bridge.uninstall', () => void uninstallBridgeCmd()),
    vscode.commands.registerCommand('dsh.cleanupImageCache', () => void cleanupImageCacheCmd()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dsh')) {
        onConfigChanged();
        // 快捷键映射变化：重渲染面板 → 握手脚本把新映射带给 iframe（iframe 随重渲染重载并重新握手）
        const { config } = readConfig();
        if (JSON.stringify(config.shortcuts) !== JSON.stringify(lastShortcuts)) {
          lastShortcuts = config.shortcuts;
          panel.refresh();
        }
      }
    }),
    { dispose: () => manager?.dispose() },
  );

  // 激活后延迟评估一次桥接状态：degraded 且未静默时弹警告
  scheduleEvaluation();

  // 启动时扫地清理：上次会话（VS Code 已重启/面板已销毁）可能遗留的"孤儿"图片降级临时文件——
  // 它们不在内存注册表里（重启即丢失），只能按工作区目录扫描删除（仅限 dsh-imgcache-* 白名单命名）。
  {
    const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    void cleanupStaleImageCaches((d) => nodeFs.readdir(d), async (p: string) => { await nodeFs.unlink(p); }, roots).catch(() => {});
  }
}

/** 打开 DSH 面板：聚焦视图（VS Code 自动打开视图所在的左侧活动栏侧边栏） */
async function openPanel(): Promise<void> {
  await vscode.commands.executeCommand('dsh.panel.focus');
}

/** 在外部浏览器打开 DSH 页面 */
async function openExternal(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(s.url));
}

/** 复制 DSH 页面地址到剪贴板（远程窗口复制隧道本地 URL） */
async function copyUrl(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  // 远程窗口优先复制「已解析的本地隧道 URL」，用户直接可访问；本地回退原地址
  const display = getDisplayUrl?.() ?? s.url;
  await vscode.env.clipboard.writeText(display);
  void vscode.window.showInformationMessage(t('info.urlCopied', { url: display }));
}

/** 复制完整 DSH 日志（含环境信息头）到剪贴板：问题报告的提交内容 */
async function copyLogs(): Promise<void> {
  await vscode.env.clipboard.writeText(logBuffer.join('\n'));
  void vscode.window.showInformationMessage(t('msg.logsCopied'));
}

/** 手动清理命令：删除图片降级临时缓存（先按注册表删全部，再扫工作区根清理孤儿） */
async function cleanupImageCacheCmd(): Promise<void> {
  const fsDeps = { writeFile: async () => {}, rmFile: async (p: string) => { await nodeFs.unlink(p); } };
  try {
    await cleanupAllImageCaches(fsDeps);
  } catch {
    // 注册表清理失败不中断后续扫描
  }
  const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  let removed = 0;
  try {
    removed = await cleanupStaleImageCaches((d) => nodeFs.readdir(d), async (p: string) => { await nodeFs.unlink(p); }, roots);
  } catch {
    removed = 0;
  }
  void vscode.window.showInformationMessage(t('msg.imageCacheCleaned', { count: removed }));
}

/** 配置变更：host/port 变化时自动重启自启服务，退出策略实时生效（快捷键映射的重渲染见 activate 内订阅） */
function onConfigChanged(): void {
  const m = manager;
  if (!m) return;
  const { config } = readConfig();
  void m.reconfigure(toManagerOptions(config));
  m.setExitBehavior(!config.stopOnExit);
}

/**
 * 插件停用（窗口退出主路径）：按 stopOnExit 与「使用者注册表」协调共享服务去留。
 * 新语义（v0.3.11）：「最后一个使用该 dsh 服务的窗口退出才自动清理」——
 * 多窗口共享同一服务时，owner 窗口先退出不再杀服务进程（其他窗口继续用），
 * 最后使用者退出才清理；单窗口行为与旧版一致（唯一窗口退出即清理）。
 * stopOnExit=true（默认）= 上述「最后使用者退出才清理」；false = 永不自动清理（服务留守）。
 * 手动 Stop Service（stopServiceCmd）不受影响——那仍是立即停止/强停对话框语义。
 */
export async function deactivate(): Promise<void> {
  // 退出路径持久日志（console → exthost 日志文件，窗口关闭后可查）：deactivate 是否
  // 运行、运行到哪一步、最终清理决策，事后从 ~/Library/Application Support/Code/logs/
  // <日期>/window*/exthost/ 按 [dsh-vscode] 前缀 grep 判别。
  console.log('[dsh-vscode] [exit] deactivate 开始');
  // v0.3.0：图片缓存兜底清理（关闭 VS Code/停用扩展时，页面 pagehide 不必然触发）
  try {
    await cleanupAllImageCaches({ writeFile: async () => {}, rmFile: async (p) => { await nodeFs.unlink(p); } });
  } catch {
    // 清理失败不影响停用流程
  }
  const config = readConfig().config;
  console.log(`[dsh-vscode] [exit] 开始退出清理（stopOnExit=${config.stopOnExit}，host=${config.host}:${config.port}）`);
  appendLog(`[exit] deactivate：stopOnExit=${config.stopOnExit}`);
  // 注销本窗口并按使用者注册表决定服务去留（内部判定：无注册表/读取失败/有其他使用者
  // 等分支的关键决策都会经 manager.persistLog 同步落 exthost 日志）
  await manager?.releaseOnExit(config.stopOnExit);
  console.log('[dsh-vscode] [exit] 退出清理完成（deactivate 正常结束）');
  manager?.dispose();
}
