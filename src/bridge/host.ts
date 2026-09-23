// src/bridge/host.ts — 桥接消息处理：外链打开 / 文件跳转
// 职责：把 webview 顶层转发来的桥接消息（bridgeOpenExternal / bridgeOpenFile）落地为
// VS Code 动作（打开外部浏览器 / 打开文本文档），并做协议白名单与路径解析的纵深防御。
// 依赖注入设计：生产侧接 vscode API（openExternal / showTextDocument），测试侧注入假实现，
// 保证纯逻辑可被 node:test 直接验证。
import { isAbsolute, resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { PanelMessage } from '../panel/html';

/** 图片缓存文件名白名单正则：前缀（与 core.js 的 imageCacheFilename 一致）+ 时间戳/序号 + 白名单扩展名 */
const IMAGE_CACHE_NAME_RE = /^dsh-imgcache-[A-Za-z0-9._:-]+-\d+\.(png|jpe?g|gif|webp)$/i;

/**
 * 已落盘图片注册表：仅允许删除「本扩展写过的」缓存文件。
 * 这是纵深防御——即使页面被攻破/伪造 deleteImages 消息的任意路径，也无法删除工作区外的文件。
 * 默认使用模块级共享注册表（主/次面板共享）；测试可注入独立注册表。
 */
export interface ImageRegistry {
  has(p: string): boolean;
  add(p: string): void;
  delete(p: string): void;
  /** 当前登记的全部路径（供全量清理迭代；返回副本，不暴露内部 Set） */
  all(): string[];
}
export function createImageRegistry(): ImageRegistry {
  const set = new Set<string>();
  return {
    has: (p) => set.has(p),
    add: (p) => set.add(p),
    delete: (p) => set.delete(p),
    all: () => [...set],
  };
}
const sharedImageRegistry = createImageRegistry();

/** 图片文件写入依赖（生产接 node:fs/promises 的 writeFile/unlink） */
export interface ImageFileDeps {
  writeFile(path: string, dataB64: string): Thenable<void>;
  rmFile(path: string): Thenable<void>;
}

/**
 * 安全落盘图片缓存：仅接受绝对 cwd + 白名单文件名（无路径穿越），写入 join(cwd, name)。
 * 成功返回 { ok: true, path } 并登记到注册表；失败返回原因（不抛异常，由调用方回 ack）。
 */
export async function saveImageToCwd(
  deps: ImageFileDeps,
  req: { cwd?: string; name: string; dataB64: string },
  registry: ImageRegistry = sharedImageRegistry,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (typeof req.cwd !== 'string' || req.cwd === '' || !isAbsolute(req.cwd)) {
    return { ok: false, error: 'invalid cwd' };
  }
  // 文件名必须是普通名称（无路径分隔符/穿越）、符合白名单
  if (typeof req.name !== 'string' || basename(req.name) !== req.name || !IMAGE_CACHE_NAME_RE.test(req.name)) {
    return { ok: false, error: 'invalid filename' };
  }
  const target = join(req.cwd, req.name);
  // 防御：产物必须是 cwd 内的精确拼接（join 结果）
  if (target !== resolve(req.cwd, req.name)) {
    return { ok: false, error: 'path mismatch' };
  }
  if (typeof req.dataB64 !== 'string' || req.dataB64 === '') {
    return { ok: false, error: 'empty data' };
  }
  try {
    await deps.writeFile(target, req.dataB64);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  registry.add(target);
  return { ok: true, path: target };
}

/**
 * 删除图片缓存：只删除注册表中「本扩展曾写过的」路径，其余一律忽略。
 * 单个文件删除失败不中断其余；返回 { ok: true }（尽力而为，不因个别失败而整体报错）。
 */
export async function deleteImageFiles(
  deps: ImageFileDeps,
  req: { paths: string[] },
  registry: ImageRegistry = sharedImageRegistry,
): Promise<{ ok: boolean; error?: string }> {
  const list = Array.isArray(req.paths) ? req.paths : [];
  for (const p of list) {
    if (typeof p !== 'string' || !registry.has(p)) continue;
    try {
      await deps.rmFile(p);
    } catch {
      // 删除失败（文件已被移走/权限）尽力而为，不中断其余
    } finally {
      registry.delete(p);
    }
  }
  return { ok: true };
}

/**
 * 全量清理图片缓存（扩展停用/服务停止时的兜底）：删除注册表中所有已写路径并清空注册表。
 * 补充 pagehide 清理之外的生命周期缺口（关闭 VS Code/停用扩展时页面不一定会触发 pagehide）。
 */
export async function cleanupAllImageCaches(
  deps: ImageFileDeps,
  registry: ImageRegistry = sharedImageRegistry,
): Promise<void> {
  for (const p of registry.all()) {
    try {
      await deps.rmFile(p);
    } catch {
      // 忽略个别删除失败
    }
    registry.delete(p);
  }
}

/**
 * 扫描并清理「工作区根目录』中残留的图片降级临时文件（孤儿清理，不依赖注册表）。
 * 背景：dsh-imgcache-* 由扩展按白名单命名落盘到工作区根；若 VS Code/扩展重启，
 * 内存注册表（sharedImageRegistry）丢失，旧文件会成为「无人追踪的孤儿」——
 * cleanupAllImageCaches/deleteImageFiles 都按注册表删除，找不到它们。故在扩展激活
 * 与手动清理命令时按目录扫描，只删除符合 IMAGE_CACHE_NAME_RE（本扩展专属命名空间）的文件。
 * @param readDir 列出目录条目（生产接 node:fs/promises.readdir）
 * @param rmFile 删除文件（生产接 node:fs/promises.unlink）
 * @param roots 要扫描的工作区根目录；缺失/非绝对路径跳过
 * @returns 删除的文件数
 */
export async function cleanupStaleImageCaches(
  readDir: (dir: string) => Promise<string[]>,
  rmFile: (path: string) => Promise<void>,
  roots: string[],
): Promise<number> {
  let removed = 0;
  for (const root of roots) {
    if (typeof root !== 'string' || root === '' || !isAbsolute(root)) continue;
    let names: string[];
    try {
      names = await readDir(root);
    } catch {
      continue; // 目录不可读（不存在/权限）跳过
    }
    for (const n of names) {
      if (typeof n === 'string' && IMAGE_CACHE_NAME_RE.test(n)) {
        try {
          await rmFile(join(root, n));
          removed += 1;
        } catch {
          // 单个删除失败（文件已被移走/权限）尽力而为
        }
      }
    }
  }
  return removed;
}

/** 桥接消息处理依赖（生产接 vscode API，测试注入假实现） */
export interface BridgeMessageDeps {
  /** 打开外部链接（生产接 vscode.env.openExternal，返回是否成功） */
  openExternal(url: string): Thenable<boolean>;
  /** 打开文本文档（生产接 vscode.window.showTextDocument） */
  openTextDocument(path: string): Thenable<void>;
  /** 弹用户可见提示（生产接 vscode.window.showWarningMessage，测试注入假实现以断言） */
  showWarning(msg: string): void;
  /** 工作区根目录（相对路径解析的兜底基准，生产由扩展入口注入） */
  workspaceRoot?: string;
  /** VS Code 各工作区根（多根工作区逐个；相对路径的兜底候选，v0.3.25） */
  vscodeWorkspaceRoots?: () => readonly string[];
  /** DSH 各会话 cwd（扩展侧经 `session/list` 探测，按由新到旧；相对路径的首选基准，v0.3.25） */
  dshSessionCwds?: () => readonly string[];
  /** DSH 工作区注册表里的工作区路径（最后的宽网兜底，v0.3.25） */
  dshWorkspacePaths?: () => readonly string[];
  /** 文件存在性判定（生产接 fs.existsSync）：让相对路径「取第一个真实存在的文件」（v0.3.25） */
  exists?: (path: string) => boolean;
  /** 写入图片缓存文件（生产接 node:fs/promises，产物 base64）——v0.3.0 图片降级用 */
  writeFile?: (path: string, dataB64: string) => Thenable<void>;
  /** 删除图片缓存文件（生产接 node:fs/promises）——v0.3.0 会话结束清理用 */
  rmFile?: (path: string) => Thenable<void>;
  /** 回执消息投递（生产接 webview.postMessage）——v0.3.0 saveImage/deleteImages 回执 */
  reply?: (msg: PanelMessage) => Thenable<void>;
}

/**
 * 提取错误摘要：优先取 Error.message，其余类型做保守的字符串化，兜底空串。
 * 用于把打开失败原因并入用户提示，避免把内部错误对象原样展示。
 */
function errSummary(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === null || err === undefined) return '';
  return String(err);
}

/**
 * 相对路径解析的候选基准与存在性判定（v0.3.25 多基准）。
 *
 * 背景：桥接转发的相对路径由 DSH 前端产出，其语义基准是**该会话的 cwd**
 * （DSH 原生 `openFile` → `fileAddressFor(sessionId, cwd, path)`），而扩展此前只有
 * 「VS Code 工作区根」这一个 base——当用户把 DSH 会话开在 A 仓库、却在 B 仓库的
 * VS Code 窗口里用面板（跨仓库 / 多个 DSH 工作空间）时，相对路径会被拼到错误的仓库根，
 * 报 `Unable to resolve nonexistent file`。
 */
export interface ResolvePathOptions {
  /** DSH 各会话的 cwd 候选（由扩展侧经 `session/list` 探测，按由新到旧；首选基准） */
  sessionCwds?: readonly (string | undefined)[] | undefined;
  /** VS Code 各工作区根（多根工作区逐个；兜底基准） */
  workspaceRoots?: readonly (string | undefined)[] | undefined;
  /**
   * DSH 工作区注册表（`$DSH_HOME/storages/workspace.json`）里的全部工作区路径。
   * 排在 VS Code 工作区根**之后**作最后的宽网兜底：它可能包含与本次会话无关的历史工作区，
   * 靠前会「抢走」用户在 VS Code 窗口里本来就能命中的同名文件（如各仓库都有的 README.md）。
   */
  dshWorkspacePaths?: readonly (string | undefined)[] | undefined;
  /**
   * 文件存在性判定（生产接 `fs.existsSync`）。
   * 缺省时不做存在性筛选，沿用旧语义「取第一个基准」；提供时按候选顺序取**第一个真实存在**的文件。
   */
  exists?: ((path: string) => boolean) | undefined;
}

/** 路径解析结果：abs 可打开；invalid 危险协议/无基准；not-found 多基准全落空（携带试过的基准） */
export type ResolveBridgePathResult =
  | { kind: 'abs'; path: string }
  | { kind: 'invalid' }
  | { kind: 'not-found'; tried: string[] };

/**
 * 解析文件路径：绝对路径直接采用；相对路径按多候选基准依次尝试，取第一个真实存在的文件。
 *
 * 候选顺序（即优先级）：桥接消息自带的会话 cwd → DSH 各会话 cwd（由新到旧）→ 旧的工作区根参数
 * → VS Code 各工作区根（多根逐个）→ DSH 工作区注册表路径（最后的宽网兜底）。
 * ~ 开头（DSH 工具行路径显示的主目录缩写）展开为主目录后再走绝对路径判定。
 * 安全规则：形似 URL 的协议串（如 https://、javascript:）一律拒绝，但 Windows 盘符（C:\ 或 C:/）不是协议，需要放行。
 */
export function resolveBridgePath(
  raw: string,
  sessionCwd: string | undefined,
  workspaceRoot: string | undefined,
  options: ResolvePathOptions = {},
): ResolveBridgePathResult {
  // 路径形似 URL 一律拒绝（协议串）；Windows 盘符不属于协议，予以放行
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    return { kind: 'invalid' };
  }
  // ~ 主目录缩写（DSH 工具行路径显示用）：~/x → <homedir>/x；单独的 ~ 视为主目录本身
  let expanded = raw;
  if (expanded === '~') expanded = homedir();
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = join(homedir(), expanded.slice(2));
  // 绝对路径直接采用（跨平台：Windows 盘符与 POSIX / 开头都算绝对）
  if (isAbsolute(expanded)) return { kind: 'abs', path: expanded };
  // 相对路径：收集去重后的候选基准（顺序即优先级：会话 cwd 优先于工作区根）
  const bases: string[] = [];
  const pushBase = (b: string | undefined): void => {
    if (typeof b === 'string' && b !== '' && !bases.includes(b)) bases.push(b);
  };
  pushBase(sessionCwd);
  for (const b of options.sessionCwds ?? []) pushBase(b);
  pushBase(workspaceRoot);
  for (const b of options.workspaceRoots ?? []) pushBase(b);
  for (const b of options.dshWorkspacePaths ?? []) pushBase(b);
  const first = bases[0];
  if (first === undefined) return { kind: 'invalid' };
  // 无存在性判定：无法筛选，沿用「取第一个基准」的旧语义（既有调用方与单测行为不变）
  if (options.exists === undefined) return { kind: 'abs', path: resolve(first, expanded) };
  // 多基准逐个探测：命中第一个真实存在的文件即用（DSH 原生语义基准是会话 cwd，故 cwd 排在最前）
  for (const base of bases) {
    const candidate = resolve(base, expanded);
    try {
      if (options.exists(candidate)) return { kind: 'abs', path: candidate };
    } catch {
      // 单个基准的存在性判定异常（权限/非法路径）：跳过该基准，继续尝试下一个
    }
  }
  return { kind: 'not-found', tried: bases };
}

/**
 * 处理桥接消息：外链打开走协议白名单，文件跳转走路径解析。
 */
export async function handleBridgeMessage(msg: PanelMessage, deps: BridgeMessageDeps): Promise<void> {
  if (msg.type === 'bridgeOpenExternal') {
    // 协议白名单：仅 http/https（与桥接侧白名单双重校验，纵深防御）
    if (/^https?:\/\//i.test(msg.url)) {
      try {
        await deps.openExternal(msg.url);
      } catch (err) {
        // 打开外链可能失败（如无默认浏览器），捕获后给用户可见反馈而非未处理拒绝
        deps.showWarning(`无法打开链接：${msg.url}（${errSummary(err)}）`);
      }
    }
    return;
  }
  if (msg.type === 'bridgeOpenFile') {
    const r = resolveBridgePath(msg.path, msg.cwd, deps.workspaceRoot, {
      sessionCwds: deps.dshSessionCwds?.(),
      workspaceRoots: deps.vscodeWorkspaceRoots?.(),
      dshWorkspacePaths: deps.dshWorkspacePaths?.(),
      exists: deps.exists,
    });
    if (r.kind === 'abs') {
      try {
        // 打开文档可能因文件不存在/无权限等失败，捕获后给用户可见反馈而非未处理拒绝
        await deps.openTextDocument(r.path);
      } catch (err) {
        // 文案内联固定提示（本模块纯逻辑，直接断言，与 Task 7 的 i18n 无关）
        deps.showWarning(`无法打开文件：${r.path}（${errSummary(err)}）`);
      }
    } else if (r.kind === 'not-found') {
      // 所有候选基准（DSH 会话 cwd → VS Code 各工作区根）下都没有这个文件：
      // 给出可见、可读的提示（原始相对路径 + 试过哪些基准），而不是把 VS Code 原生
      // 「Unable to resolve nonexistent file」这种无上下文的报错丢给用户。
      deps.showWarning(
        [
          `找不到文件：${msg.path}（相对路径）`,
          '已按以下基准目录逐个查找，均无此文件：',
          ...r.tried.map((b) => `· ${b}`),
        ].join('\n'),
      );
    } else {
      // 路径无法解析（危险协议或缺少基准目录）：仅弹提示，不打断面板与桥接流程
      deps.showWarning(`无法解析路径：${msg.path}`);
    }
    return;
  }
  if (msg.type === 'bridgeSaveImage') {
    // 图片缓存落盘：白名单校验 + 路径安全由 saveImageToCwd 保证；回执 success/路径给 iframe
    // cwd 兜底：客户端通常不传会话 cwd（DSH 无轻量接口可取），回退到工作区根目录（=dsh 会话 cwd 的常用值）
    const r = await saveImageToCwd(
      { writeFile: deps.writeFile ?? (async () => {}), rmFile: deps.rmFile ?? (async () => {}) },
      { cwd: msg.sessionCwd ?? deps.workspaceRoot, name: msg.name, dataB64: msg.dataB64 },
    );
    await deps.reply?.({
      type: 'bridgeSaveImageAck',
      requestId: msg.requestId,
      ok: r.ok,
      ...(r.path === undefined ? {} : { path: r.path }),
    });
    return;
  }
  if (msg.type === 'bridgeDeleteImages') {
    // 会话结束清理：只删除注册表中的本扩展缓存文件
    const r = await deleteImageFiles(
      { writeFile: deps.writeFile ?? (async () => {}), rmFile: deps.rmFile ?? (async () => {}) },
      { paths: msg.paths },
    );
    await deps.reply?.({ type: 'bridgeDeleteImagesAck', requestId: msg.requestId, ok: r.ok });
    return;
  }
}