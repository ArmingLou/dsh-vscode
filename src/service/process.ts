// src/service/process.ts — dsh web 子进程封装（跨平台）
// 纯模块：spawn 通过参数注入，便于单测；不依赖 vscode。
import { spawn, execSync, type SpawnOptions } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { posix as posixPath, win32 as win32Path } from 'node:path';
import { homedir } from 'node:os';

/** 最小子进程接口（真实 ChildProcess 结构上兼容，测试可注入假实现） */
export interface ChildProcessLike {
  pid?: number;
  stdout?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** spawn 函数签名（便于注入假实现） */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;

/** 启动参数 */
export interface StartOptions {
  host: string;
  port: number;
  extraArgs: string[];
  /** 子进程工作目录（兜底：让 dsh web 以 VS Code 工作区为 cwd，缺省则不指定） */
  cwd?: string;
  /** dsh 可执行文件绝对路径（非空时优先于平台默认命令名 dsh.cmd / dsh 使用） */
  executablePath?: string;
  /** 是否允许 dsh web 打开浏览器（true=不追加 --no-open；默认 false=追加 --no-open） */
  openInBrowser?: boolean;
}

/**
 * 进程运行环境注入（便于单测；默认取生产运行值）。
 * 用于 Windows 分支推导"node 直跑 bin.js"所用的 node 路径与 PATH 查找目录。
 */
export interface RunnerEnv {
  /** node 可执行文件绝对路径（生产为 process.execPath） */
  execPath?: string;
  /** 环境变量 PATH 字符串值（生产为 process.env.PATH） */
  path?: string;
  /** Electron 运行时版本（仅 Electron 环境有值；真实 Node 下为 undefined）。
   *  扩展宿主是 Electron，process.execPath 指向 Code.exe，绝不能当作 node 使用。 */
  electronVersion?: string;
  /** 用户 SHELL 环境变量（macOS/Linux 用于登录 shell PATH 解析；Windows 未使用） */
  shell?: string;
  /** 用户 home 目录（默认 node:os.homedir()；单测可注入） */
  homeDir?: string;
}

/**
 * 校验可传给 spawn 的工作目录：仅接受存在且非 UNC 网络路径的绝对路径。
 *
 * 背景：Windows 的 CreateProcess 对无效工作目录（UNC 网络路径、不存在的路径等）
 * 抛出 EINVAL（spawn 的同步异常），会把「参数错误」伪装成「命令缺失」。此函数在
 * spawn 前把这类 cwd 过滤为 undefined，让 spawn 走自身默认 cwd 的路径。
 *
 * @param cwd        候选工作目录（来自 VS Code 工作区路径）
 * @param platform   平台名（process.platform）
 * @param existsImpl 存在性校验（默认 node:fs.existsSync；单测可注入假实现）
 */
export function sanitizeCwd(
  cwd: string | undefined,
  platform: string,
  existsImpl: (p: string) => boolean = existsSync,
): string | undefined {
  if (cwd === undefined) return undefined;
  // 非 Windows 平台：无 UNC 限制，仅做存在性校验，不存在则返回 undefined
  if (platform !== 'win32') {
    return existsImpl(cwd) ? cwd : undefined;
  }
  // Windows：必须是绝对路径、不是 UNC 网络路径（以 \\ 开头）、且真实存在。
  // 注意：用 path.win32.isAbsolute 判断，因为 cwd 是 Windows 风格路径，与运行平台无关。
  if (!win32Path.isAbsolute(cwd)) return undefined;
  if (cwd.startsWith('\\\\')) return undefined; // UNC：\\server\share
  return existsImpl(cwd) ? cwd : undefined;
}

/**
 * 在 PATH 的目录列表中查找可执行文件（Windows 查找语义的简化版，只找固定文件名）。
 *
 * 真实 Windows 会依次试探 PATH 各目录（含 `.com` / `.exe` / `.bat` / `.cmd` 等扩展名），
 * 这里简化为：按分隔符拆分 envPath，对每个目录拼上固定文件名，用 existsImpl 判断是否存在，
 * 命中即返回该候选路径；全部未命中返回 null。
 *
 * @param target     待查找的固定文件名（如 'dsh.cmd'）
 * @param envPath    环境变量 PATH 的字符串值（分隔符 ':' 或 ';'，Windows 为 ';'）
 * @param existsImpl 存在性校验（默认 node:fs.existsSync；单测可注入假实现）
 * @returns 命中的完整路径，未命中返回 null
 */
export function findInPath(
  target: string,
  envPath: string | undefined,
  existsImpl: (p: string) => boolean = existsSync,
): string | null {
  if (envPath === undefined) return null;
  for (const dir of envPath.split(';')) {
    if (dir === '') continue;
    const candidate = win32Path.join(dir, target);
    if (existsImpl(candidate)) return candidate;
  }
  return null;
}

/** execSync 注入签名（便于单测注入假实现） */
export type ExecSyncFn = (command: string) => string;

/** 默认 execSync 实现：5 秒超时、UTF-8 编码 */
export const defaultExecSync: ExecSyncFn = (cmd) =>
  execSync(cmd, { encoding: 'utf8', timeout: 5000 });

/** 支持的登录 shell basename 白名单（fish 等不保证 -l 语义，跳过） */
const LOGIN_SHELL_WHITELIST = new Set(['bash', 'zsh', 'sh']);

/** 默认候选 shell 路径（当 process.env.SHELL 缺失或不识别时逐个尝试） */
const DEFAULT_CANDIDATE_SHELLS = ['/bin/zsh', '/bin/bash'];

/** resolveLoginShellPath 诊断回调签名 */
export type ResolveLogFn = (line: string) => void;

/** resolveLoginShellPath 返回结构（含诊断信息） */
export interface ResolveResult {
  /** 解析后的 PATH 字符串；失败时为 fallbackPath */
  path: string;
  /** 成功用到的 shell 路径；全部失败为 null */
  usedShell: string | null;
}

/**
 * 直接扫描常见版本管理器/安装目录查找 dsh（不依赖 shell）。
 *
 * 场景：VS Code 从 Dock/Launchpad 启动时宿主 PATH 最小化，且登录 shell (-l) 不 source
 * .zshrc（用户的 nvm 通常在 .zshrc 里加载），导致 shell PATH 解析也拿不到 nvm 目录。
 * 本函数绕过 shell，用 node:fs 直接扫描已知目录，返回第一个存在的 dsh 路径。
 *
 * 扫描顺序：
 * 1) nvm: ~/.nvm/versions/node/\<version\>/bin/dsh（按版本目录名降序取最新）
 * 2) ~/.local/bin/dsh
 * 3) asdf: ~/.asdf/shims/dsh
 * 4) fnm: ~/.fnm/node-versions/\<version\>/installation/bin/dsh（降序取最新）
 * 5) /opt/homebrew/bin/dsh、/usr/local/bin/dsh（brew/various）
 *
 * @param existsImpl 存在性校验（默认 node:fs.existsSync；单测可注入）
 * @param readdirImpl 目录读取（默认 node:fs.readdirSync；单测可注入）
 * @param homedirVal 用户 home 目录（默认 node:os.homedir()；单测可注入）
 * @param logFn 诊断日志回调（可选）
 * @returns 命中的 dsh 绝对路径；全部未命中返回 null
 */
export function scanCommonDshLocations(
  existsImpl: (p: string) => boolean = existsSync,
  readdirImpl: (dir: string) => string[] = (dir) => readdirSync(dir),
  homedirVal: string = homedir(),
  logFn?: ResolveLogFn,
): string | null {
  const home = homedirVal;
  const hits: string[] = [];

  // 1) nvm: ~/.nvm/versions/node/*/bin/dsh — 按版本目录降序取最新
  const nvmDir = posixPath.join(home, '.nvm', 'versions', 'node');
  let nvmTried = false;
  try {
    const versions = readdirImpl(nvmDir);
    nvmTried = true;
    const sorted = versions
      .filter((v) => v.startsWith('v'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of sorted) {
      const candidate = posixPath.join(nvmDir, v, 'bin', 'dsh');
      if (existsImpl(candidate)) {
        logFn?.(`[dsh-scan] nvm hit: ${candidate}`);
        hits.push(candidate);
      }
    }
    if (hits.length > 0) return hits[0];
  } catch {
    // nvm 目录不存在或不可读，跳过
  }
  logFn?.(`[dsh-scan] nvm: ${nvmTried ? 'no dsh in versions' : 'dir not found'}`);

  // 2) ~/.local/bin/dsh
  const localBin = posixPath.join(home, '.local', 'bin', 'dsh');
  if (existsImpl(localBin)) {
    logFn?.(`[dsh-scan] local hit: ${localBin}`);
    return localBin;
  }

  // 3) asdf: ~/.asdf/shims/dsh
  const asdfShim = posixPath.join(home, '.asdf', 'shims', 'dsh');
  if (existsImpl(asdfShim)) {
    logFn?.(`[dsh-scan] asdf hit: ${asdfShim}`);
    return asdfShim;
  }

  // 4) fnm: ~/.fnm/node-versions/*/installation/bin/dsh — 降序取最新
  const fnmDir = posixPath.join(home, '.fnm', 'node-versions');
  let fnmTried = false;
  try {
    const versions = readdirImpl(fnmDir);
    fnmTried = true;
    const sorted = versions
      .filter((v) => v.startsWith('v'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of sorted) {
      const candidate = posixPath.join(fnmDir, v, 'installation', 'bin', 'dsh');
      if (existsImpl(candidate)) {
        logFn?.(`[dsh-scan] fnm hit: ${candidate}`);
        hits.push(candidate);
      }
    }
    if (hits.length > 0) return hits[0];
  } catch {
    // fnm 目录不存在或不可读，跳过
  }
  logFn?.(`[dsh-scan] fnm: ${fnmTried ? 'no dsh in versions' : 'dir not found'}`);

  // 5) brew/various: /opt/homebrew/bin/dsh, /usr/local/bin/dsh
  const brewDirs = ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh'];
  for (const candidate of brewDirs) {
    if (existsImpl(candidate)) {
      logFn?.(`[dsh-scan] brew hit: ${candidate}`);
      return candidate;
    }
  }

  logFn?.(`[dsh-scan] all scan locations exhausted, no dsh found`);
  return null;
}

/**
 * 构造候选 shell 列表：process.env.SHELL（若 basename ∈ 白名单）优先，再追加默认候选，去重去空。
 */
function buildShellCandidates(envShell: string | undefined): string[] {
  const candidates: string[] = [];
  if (envShell) {
    const base = posixPath.basename(envShell);
    if (LOGIN_SHELL_WHITELIST.has(base)) {
      candidates.push(envShell);
    }
  }
  for (const s of DEFAULT_CANDIDATE_SHELLS) {
    if (!candidates.includes(s)) {
      candidates.push(s);
    }
  }
  return candidates;
}

/**
 * 判断候选 shell 的 rc 文件名（bash → .bashrc，zsh → .zshrc，sh → 无）。
 */
function rcFileForShell(shellPath: string): string | null {
  const base = posixPath.basename(shellPath);
  if (base === 'zsh') return '.zshrc';
  if (base === 'bash') return '.bashrc';
  return null;
}

/**
 * 从用户登录 shell 解析 PATH（macOS / Linux 分支专用）。
 *
 * 背景：VS Code 从 Dock/Launchpad 启动时宿主进程不继承用户交互 shell
 * （.zshrc / .zprofile / .bash_profile 等注入的 PATH），导致 nvm/asdf/fnm
 * 等版本管理器 shim 目录不在 process.env.PATH 中。
 *
 * 解析顺序（逐个候选 shell 尝试，首个成功即返回）：
 * 1. **source rc 文件**：`<shell> -c 'source ~/.zshrc >/dev/null 2>&1; echo $PATH'`
 *    - zsh source ~/.zshrc，bash source ~/.bashrc。
 *    - 登录 shell (-l) 不 source .zshrc（用户的 nvm 通常在 .zshrc 里加载），
 *      而 source .zshrc 能拿到 nvm 目录。
 *    - 风险隔离：`>/dev/null 2>&1` 抑制 rc 文件的标准输出（如代理脚本/oh-my-zsh
 *      可能输出文字）；execSync 已有 5s 超时防卡死；任何异常均静默跳过。
 * 2. **登录 shell 回退**：`<shell> -l -c 'echo $PATH'`（旧行为，含 .zprofile/.zlogin
 *    但不含 .zshrc）。
 * 3. 全部候选 shell 失败后回退 fallbackPath。
 *
 * 候选 shell 列表：process.env.SHELL（若 basename ∈ {bash,zsh,sh}）优先，
 * 再追加 /bin/zsh、/bin/bash，去重去空。
 *
 * 任何失败（shell 不存在、执行超时、输出异常）均静默回退 fallbackPath。
 *
 * @param shell        用户 SHELL 环境变量（如 '/bin/zsh'）；undefined 时仍尝试默认候选
 * @param execSyncImpl execSync 注入（默认 defaultExecSync）
 * @param fallbackPath 回退 PATH（通常为 process.env.PATH）
 * @param logFn        诊断日志回调（可选；不传则不输出诊断）
 * @returns 解析结果（含 path 与 usedShell）
 */
export function resolveLoginShellPath(
  shell: string | undefined,
  execSyncImpl: ExecSyncFn,
  fallbackPath: string,
  logFn?: ResolveLogFn,
): ResolveResult {
  const candidates = buildShellCandidates(shell);
  logFn?.(`[path-resolve] SHELL=${shell ?? '(空)'} candidates=[${candidates.join(', ')}]`);
  for (const candidate of candidates) {
    // 1) 优先 source rc 文件（.zshrc / .bashrc）
    const rcFile = rcFileForShell(candidate);
    if (rcFile) {
      try {
        const output = execSyncImpl(`"${candidate}" -c 'source ~/${rcFile} >/dev/null 2>&1; echo $PATH'`);
        const rcPath = output.trim();
        if (rcPath && rcPath.includes('/')) {
          const hasNvm = rcPath.includes('.nvm/versions/node');
          logFn?.(`[path-resolve] shell=${candidate} source ~/.${rcFile} OK, hasNvm=${hasNvm}, path=${rcPath.length > 200 ? rcPath.slice(0, 200) + '...' : rcPath}`);
          return { path: rcPath, usedShell: candidate };
        }
        logFn?.(`[path-resolve] shell=${candidate} source ~/.${rcFile} output invalid (empty or no '/'), trying -l fallback`);
      } catch (e) {
        logFn?.(`[path-resolve] shell=${candidate} source ~/.${rcFile} failed: ${String(e).slice(0, 120)}, trying -l fallback`);
      }
    }

    // 2) 回退到登录 shell -l -c（旧行为）
    try {
      const output = execSyncImpl(`"${candidate}" -l -c 'echo $PATH'`);
      const loginPath = output.trim();
      if (loginPath && loginPath.includes('/')) {
        const hasNvm = loginPath.includes('.nvm/versions/node');
        logFn?.(`[path-resolve] shell=${candidate} -l OK, hasNvm=${hasNvm}, loginPath=${loginPath.length > 200 ? loginPath.slice(0, 200) + '...' : loginPath}`);
        return { path: loginPath, usedShell: candidate };
      }
      logFn?.(`[path-resolve] shell=${candidate} -l output invalid (empty or no '/'), skipping`);
    } catch (e) {
      logFn?.(`[path-resolve] shell=${candidate} -l failed: ${String(e).slice(0, 120)}`);
    }
  }
  logFn?.(`[path-resolve] all candidates failed, fallback to host PATH`);
  return { path: fallbackPath, usedShell: null };
}

/**
 * 合并两条 PATH 并去重（保留 primary 的顺序优先）。
 *
 * 典型场景：primary 为登录 shell PATH（含 nvm 目录），secondary 为宿主进程 PATH；
 * 合并后登录 shell 目录优先，宿主独有的目录追加其后，去重防止重复搜索。
 *
 * @param primary    优先 PATH
 * @param secondary  补充 PATH
 * @param separator  分隔符（POSIX 为 ':'，Windows 为 ';'）
 * @returns 去重后的合并 PATH
 */
export function mergePath(primary: string, secondary: string, separator: string): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of primary.split(separator)) {
    if (entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  for (const entry of secondary.split(separator)) {
    if (entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result.join(separator);
}

/**
 * 在 PATH 的目录列表中查找可执行文件（POSIX 查找语义，用 ':' 分隔符 + posix.join）。
 *
 * 与 findInPath（Windows 版，';' 分隔 + win32.join）对称，供 macOS / Linux 分支使用。
 *
 * @param target     待查找的文件名（如 'dsh'）
 * @param envPath    环境变量 PATH 的字符串值（':' 分隔）
 * @param existsImpl 存在性校验（默认 node:fs.existsSync）
 * @returns 命中的完整路径，未命中返回 null
 */
export function findInPathPosix(
  target: string,
  envPath: string | undefined,
  existsImpl: (p: string) => boolean = existsSync,
): string | null {
  if (envPath === undefined) return null;
  for (const dir of envPath.split(':')) {
    if (dir === '') continue;
    const candidate = posixPath.join(dir, target);
    if (existsImpl(candidate)) return candidate;
  }
  return null;
}

/**
 * 由 dsh.cmd 的绝对路径推导 npm shim 的真实入口 bin.js 路径。
 *
 * npm 在 Windows 上生成的 shim（如 `dsh.cmd`）实际是把调用转发到同目录下的
 * `node_modules/<scope>/<pkg>/lib/bin.js`。本函数把 shim 所在目录替换为该真实入口
 * 的绝对路径，供后续"用 node 直接执行 bin.js"启动服务时使用。
 *
 * @param dshCmdPath dsh.cmd 的绝对路径（或 shim 所在任意文件路径，取 dirname）
 * @returns 推导出的 bin.js 绝对路径
 */
export function binJsFromShim(dshCmdPath: string): string {
  // 用 path.win32：shim 是 Windows 路径，须始终以反斜杠拼接（与运行平台无关）
  return win32Path.join(win32Path.dirname(dshCmdPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/** Windows 下"node 直跑 bin.js"的启动参数 */
export interface WindowsDshInvocation {
  /** 实际 spawn 的命令（node 可执行文件绝对路径） */
  command: string;
  /** 需排在 'web ...' 之前的参数前缀（即 bin.js 绝对路径） */
  argsPrefix: string[];
}

/**
 * 构造 Windows 下"node 直跑 bin.js"的启动参数。
 *
 * 背景：Windows 上 `spawn('dsh.cmd')` 会因 .cmd 是批处理 shim 而在 Node v24 下同步抛
 * EINVAL，改用 `node <bin.js>` 直跑真实入口即可绕过。本函数返回 { command: execPath,
 * argsPrefix: [binJsPath] }，调用方将其作为 spawn(command, [...argsPrefix, 'web', ...])。
 *
 * @param dshCmdPath dsh.cmd（或直接 bin.js）的绝对路径；bin.js 路径由其 dirname 推导
 * @param execPath   node 可执行文件绝对路径（生产为 process.execPath）
 * @returns Windows 下 node 直跑 bin.js 的启动参数
 */
export function windowsDshInvocation(dshCmdPath: string, execPath: string): WindowsDshInvocation {
  return { command: execPath, argsPrefix: [binJsFromShim(dshCmdPath)] };
}

/**
 * 解析 Windows 下执行 bin.js 所用的 node 可执行文件绝对路径。
 *
 * 背景（Windows 实测根因，HMR 崩溃 `--expose-internals is required for HMR service`）：
 * VS Code 扩展宿主是 Electron 进程，process.execPath 指向 Code.exe——用它 spawn 时
 * bin.js 会跑在 Electron 运行时里：webserver 等纯 JS 部分能起来，但 dsh 的
 * loader/HMR 依赖系统 Node 的内部特性（--expose-internals 或 node-addon-require-builtin
 * 原生模块，其二进制按系统 Node ABI 编译），Electron 运行时里两者都不可用 →
 * HMR 插件启动失败 → 整个 boot 崩溃 → 面板显示「服务已断开」。
 * 因此 Electron 环境绝不使用 execPath，必须解析系统 PATH 里的 node.exe。
 *
 * 解析顺序（与 npm 生成的 dsh.cmd shim 语义对齐）：
 * 1. shim 目录旁的 node.exe（部分安装布局把 node 放在 npm bin 目录旁边）；
 * 2. 系统 PATH 里的 node.exe（常规安装：C:\Program Files\nodejs）；
 * 3. 非 Electron 环境：execPath 本身就是真实 node（直接 node 运行/单测场景）兜底；
 * 4. 全部失败：抛 code=NODE_NOT_FOUND（Electron 环境绝不能把 Code.exe 当 node 用）。
 *
 * @param shimPath   dsh.cmd（或用户配置的 bin.js）的绝对路径
 * @param env        运行环境注入（execPath / path / electronVersion）
 * @param existsImpl 存在性校验（默认 node:fs.existsSync；单测可注入假实现）
 * @returns node.exe 绝对路径
 * @throws code=NODE_NOT_FOUND 所有候选都不可用时
 */
export function resolveWindowsNodeExecutable(
  shimPath: string,
  env: RunnerEnv,
  existsImpl: (p: string) => boolean = existsSync,
): string {
  // Electron 判定：注入值优先；未注入时读真实 process.versions（扩展宿主里是 Electron 版本号）。
  // 双保险：execPath 的文件名以 code 开头（Code.exe/code.exe，VS Code 主程序）也视为 Electron——
  // 即使 versions.electron 检测意外失效，也绝不把 Code.exe 当 node 用。
  const isElectron =
    (typeof env.electronVersion === 'string' && env.electronVersion !== '') ||
    (typeof (process.versions as { electron?: string }).electron === 'string' &&
      (process.versions as { electron?: string }).electron !== '') ||
    /^code(\.exe)?$/i.test(win32Path.basename(env.execPath ?? process.execPath ?? ''));
  const pathEnv = env.path ?? process.env.PATH ?? '';

  // 1) shim 目录旁的 node.exe（npm shim 的 %dp0%\node.exe 语义；仅绝对路径才有可靠 dirname）
  if (win32Path.isAbsolute(shimPath)) {
    const besideShim = win32Path.join(win32Path.dirname(shimPath), 'node.exe');
    if (existsImpl(besideShim)) return besideShim;
  }

  // 2) 系统 PATH 里的 node.exe（常规安装布局）
  const inPath = findInPath('node.exe', pathEnv, existsImpl);
  if (inPath) return inPath;

  // 3) 非 Electron 环境：execPath 本身就是真实 node，兜底使用
  const execPath = env.execPath ?? process.execPath;
  if (!isElectron && execPath) return execPath;

  // 4) 全部失败：明确报「未找到 node.exe」，绝不把 Electron 的 Code.exe 当 node 用
  throw Object.assign(
    new Error(`node.exe not found in PATH (dsh shim at ${shimPath})`),
    { code: 'NODE_NOT_FOUND' },
  );
}

/**
 * 0 号信号存活探测：判断 pid 是否仍有对应进程。
 * - kill 成功 → 存活；
 * - ESRCH → 进程不存在；
 * - EPERM → 进程存在但无权向其发信号（按存活处理——进程在，只是本扩展杀不动它）；
 * - 其余异常（如平台限制）保守按存活处理（宁可无法强停，也不误报「已退出」）。
 * pid 非法（非正整数）直接 false。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * 停止一个外部进程（非本扩展 spawn，如另一窗口自启的 dsh web）：SIGTERM → 宽限 → SIGKILL，
 * 随后短暂等待内核回收端口（与 stopChild 相同的收尾节奏）。
 *
 * 与 stopChild 的差异：**只杀单个 pid，绝不 kill(-pid) 进程组**——外部进程组不归本扩展
 * 管理，组信号可能波及无关进程组（且当 pid 不是组首时 -pid 会指向别的组）。
 * 进程已不存在时 SIGTERM 抛 ESRCH → 视为成功幂等返回；SIGKILL 阶段抛错（进程已在
 * SIGTERM 后退出）同样忽略。EPERM 等真实失败向上抛出，由调用方提示用户。
 *
 * 平台差异：Windows 上 process.kill 仅支持有限的信号集，SIGTERM/SIGKILL 均为强制终止
 * 语义（与 stopChild 的处理一致），故无需平台分支；探测阶段的 kill(pid, 0) 两平台通用。
 *
 * @param pid     目标进程 pid
 * @param graceMs SIGTERM 到 SIGKILL 的宽限期（默认 3000，与 stopChild 一致）
 */
export async function stopExternalProcess(pid: number, graceMs = 3000): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return; // 已退出：视为成功
    throw err; // EPERM 等：真实失败，向上抛
  }
  if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* SIGTERM 已生效（进程已退出），忽略 */
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/** 进程管理接口 */
export interface ProcessRunner {
  /** 启动 dsh web 子进程（命令名按平台选择） */
  startDsh(opts: StartOptions): ChildProcessLike;
  /** 优雅停止：先 SIGTERM，宽限期后 SIGKILL */
  stopChild(child: ChildProcessLike): Promise<void>;
  /** 最近一次启动的子进程（测试钩子；生产代码可忽略） */
  lastChild: ChildProcessLike | null;
  /** 最近一次启动的实际命令与参数（供 manager 写「启动命令」日志，便于问题排查） */
  lastStart?: { command: string; args: string[] } | null;
}

/**
 * 创建进程管理器。
 * @param spawnImpl 注入的 spawn（默认 node:child_process.spawn）
 * @param platform  平台名（默认 process.platform）
 * @param graceMs   SIGTERM 到 SIGKILL 的宽限期（默认 3000）
 * @param existsImpl 存在性校验（默认 node:fs.existsSync；单测注入假实现以便控制 cwd / bin.js 查找结果）
 * @param env       运行环境注入（execPath / path；默认 process.execPath / process.env.PATH，工厂内取，保持既有调用不破）
 */
export function createProcessRunner(
  spawnImpl: SpawnFn = spawn as unknown as SpawnFn,
  platform: string = process.platform,
  graceMs = 3000,
  existsImpl: (p: string) => boolean = existsSync,
  env: RunnerEnv = { execPath: process.execPath, path: process.env.PATH ?? '', shell: process.env.SHELL },
  execSyncImpl: ExecSyncFn = defaultExecSync,
  readdirImpl: (dir: string) => string[] = (dir) => readdirSync(dir),
): ProcessRunner {
  let lastChild: ChildProcessLike | null = null;
  let lastStart: { command: string; args: string[] } | null = null;
  let cachedResolve: ResolveResult | null = null;

  return {
    startDsh({ host, port, extraArgs, cwd, executablePath, openInBrowser }) {
      // 基础参数（web 子命令 + host/port + 用户额外参数），两种平台共用
      const webArgs = ['web', '--host', host, '--port', String(port), ...extraArgs];
      // 默认不让 dsh 弹浏览器（嵌入面板场景无需浏览器）：除非用户打开 openInBrowser 开关
      if (openInBrowser !== true) webArgs.push('--no-open');
      // 工作目录容错：过滤掉 Windows 上的 UNC / 不存在 / 相对路径，避免 spawn 抛 EINVAL
      const sanitizedCwd = sanitizeCwd(cwd, platform, existsImpl);
      const spawnOptions: SpawnOptions = {
        // POSIX 下脱离父进程组；Windows 不 detached（由父进程退出钩子负责清理）
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // cwd 仅在显式传入时指定，避免覆盖 spawn 自身对缺省 cwd 的处理
        ...(sanitizedCwd === undefined ? {} : { cwd: sanitizedCwd }),
      };

      let child: ChildProcessLike;
      let command: string;
      let spawnArgs: string[];
      if (platform === 'win32') {
        // Windows：.cmd 是批处理 shim，Node v24 直接 spawn 会同步抛 EINVAL，
        // 故改为用 node 直接执行 shim 指向的真实入口 bin.js，绕过 .cmd shim。
        const pathEnv = env.path ?? process.env.PATH ?? '';

        // 1) 确定 dsh.cmd 的绝对路径：显式 executablePath 优先；否则在 PATH 里找 dsh.cmd
        let shimPath: string | null;
        if (executablePath && executablePath.length > 0) {
          shimPath = executablePath;
        } else {
          shimPath = findInPath('dsh.cmd', pathEnv, existsImpl);
          // 找不到 dsh.cmd → 保持"未找到 dsh"语义（code ENOENT），manager 的 ENOENT 分支照常工作
          if (shimPath === null) {
            throw Object.assign(new Error('dsh.cmd not found in PATH'), { code: 'ENOENT' });
          }
        }

        // 2) 若 executablePath 直接指向 bin.js（以 .js 结尾），则 argsPrefix 就用该 js 本身；
        //    否则由 shim 的 dirname 推导 bin.js 绝对路径。
        const argsPrefix = shimPath.endsWith('.js')
          ? [shimPath]
          : [binJsFromShim(shimPath)];

        // 3) 解析执行 bin.js 所用的 node.exe：Electron 环境下 execPath 是 Code.exe 不可用，
        //    必须解析系统 PATH 里的 node.exe（详见 resolveWindowsNodeExecutable 注释）。
        const nodeExecutable = resolveWindowsNodeExecutable(shimPath, env, existsImpl);

        // 4) spawn(node, [binJs, 'web', --host, --port, ...extraArgs], options)
        command = nodeExecutable;
        spawnArgs = [...argsPrefix, ...webArgs];
        child = spawnImpl(command, spawnArgs, spawnOptions);
      } else {
        if (executablePath && executablePath.length > 0) {
          command = executablePath;
        } else {
          const hostPath = env.path ?? process.env.PATH ?? '';
          if (cachedResolve === null) {
            cachedResolve = resolveLoginShellPath(env.shell ?? process.env.SHELL, execSyncImpl, hostPath);
          }
          const merged = mergePath(cachedResolve.path, hostPath, ':');
          const found = findInPathPosix('dsh', merged, existsImpl);
          if (found) {
            command = found;
          } else {
            const scanned = scanCommonDshLocations(existsImpl, readdirImpl, env.homeDir ?? homedir());
            command = scanned ?? 'dsh';
          }
        }
        spawnArgs = webArgs;
        child = spawnImpl(command, spawnArgs, spawnOptions);
      }

      lastChild = child;
      lastStart = { command, args: spawnArgs };
      return child;
    },

    async stopChild(child) {
      if (child.pid === undefined) return;
      child.kill('SIGTERM');
      // Unix 上 detached 子进程在独立进程组，额外向整组发信号防残留子进程（dsh web 可 spawn 子进程）
      if (platform !== 'win32' && child.pid > 0) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 进程组可能已退出 */ }
      }
      await new Promise((resolve) => setTimeout(resolve, graceMs));
      child.kill('SIGKILL');
      if (platform !== 'win32' && child.pid > 0) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出，忽略 */ }
      }
      // 等待端口释放：SIGKILL 后内核需回收 socket，短暂等待避免紧接的 restart 端口冲突
      await new Promise((resolve) => setTimeout(resolve, 200));
    },

    get lastChild() {
      return lastChild;
    },

    get lastStart() {
      return lastStart;
    },
  };
}
