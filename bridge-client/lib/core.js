// bridge-client/lib/core.js — 桥接纯逻辑（无 DOM、无 window，可在 node 环境单测）
// 说明：本文件是唯一实现与单测目标；生产环境在构建时（scripts/build.mjs）把它
// 内联进 client.js 工厂，保证"生产运行的逻辑 = 单测验证的逻辑"同一份源码。

// 外链协议白名单：只允许 http/https，杜绝 javascript:/file: 等危险协议
export function isAllowedExternalUrl(url) {
  // 非字符串或空串一律拒绝
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    // 用 URL 解析取协议；无效 URL 会抛错，落入 catch 返回 false
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// 构造"打开外链"消息（父页面 → 扩展 → 系统浏览器）
export function buildOpenExternalMessage(url) {
  return { kind: 'openExternal', url };
}

// 构造"打开文件"消息（cwd 为会话工作目录，可选；无 cwd 时省略该字段）
export function buildOpenFileMessage(path, cwd) {
  return cwd === undefined ? { kind: 'openFile', path } : { kind: 'openFile', path, cwd };
}

// 构造"工作区同步回执"消息（bridgeAck，path 可选；version 为桥接包版本，供扩展侧日志识别代码版本）
export function buildSyncWorkspaceAck(ok, path, version) {
  const base = path === undefined ? { kind: 'bridgeAck', ok } : { kind: 'bridgeAck', ok, path };
  return version === undefined ? base : { ...base, version };
}

// 构造"复制文本"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板）
export function buildCopyTextMessage(text, requestId) {
  return { kind: 'copyText', text, requestId };
}

// 构造"复制文本回执"消息（父页面 → iframe 页面，用于 resolve/reject writeText 的 Promise）
export function buildCopyTextAck(requestId, ok) {
  return { kind: 'copyTextAck', requestId, ok };
}

// 校验来自父页面的消息 token（握手防伪）：必须是对象且携带匹配的非空 token
export function isBridgeMessage(data, token) {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof data.token === 'string' &&
    data.token === token &&
    data.token !== ''
  );
}

// 握手 token 字段名（父页面发来的消息里携带）
export const HANDSHAKE_TOKEN_KEY = 'token';

/**
 * 从键盘事件判定"标准编辑快捷键"命令。
 *
 * 背景：VS Code 在 macOS 上会调用 setIgnoreMenuShortcuts(true) 并只在顶层 webview
 * 转发快捷键，导致嵌套 iframe（本桥接所在的 DSH 页面）里的 Cmd+C / Cmd+V / Cmd+A 等
 * 被吞掉（microsoft/vscode#129178 / #180234，官方至今未修复）。但 iframe 内的 JS 仍能
 * 收到 keydown 事件，因此这里把"按键 → 编辑命令"的判定抽成纯函数，
 * 由 client.js 捕获后自行模拟对应行为。
 *
 * @param {{ key?: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean }} e
 *   键盘事件的关键字段（兼容真实 KeyboardEvent 与测试桩，多余字段忽略）
 * @returns {null | 'copy' | 'paste' | 'cut' | 'selectAll' | 'undo' | 'redo'}
 *   命中的编辑命令；未命中返回 null（调用方应放行原事件）
 */
export function getShortcutCommand(e) {
  if (!e || typeof e !== 'object') return null;
  // 主修饰键：mac 用 meta（⌘），Windows/Linux 用 ctrl，两者都识别以兼容两种平台
  const hasMod = e.ctrlKey === true || e.metaKey === true;
  // Windows 上 Shift+Insert 是经典的粘贴组合，一并支持
  if (!hasMod) {
    return e.shiftKey === true && e.key === 'Insert' ? 'paste' : null;
  }
  // 键名统一小写以兼容 'c' 与 'C'（Shift+字母时 key 为大写）
  const k = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  switch (k) {
    case 'c':
      return 'copy';
    case 'v':
      return 'paste';
    case 'x':
      return 'cut';
    case 'a':
      return 'selectAll';
    case 'z':
      // Cmd+Shift+Z 是重做（mac 惯例；Windows 上 Ctrl+Y 也能重做，暂不额外处理）
      return e.shiftKey === true ? 'redo' : 'undo';
    default:
      return null;
  }
}

// —— 桥接快捷键转发（v0.3.2）：把 iframe 内被 VS Code 吞掉的任意组合键转发给扩展宿主执行 ——
// 背景：VS Code 只把快捷键转发给顶层 webview，嵌套 iframe（本桥接所在的 DSH 页面）内的
// 组合键（Cmd+1、Cmd+Esc、Cmd+` 等）全部被吞掉；但 iframe 的 keydown 仍可达，因此这里
// 把「按键事件 → 规范组合键字符串」抽成纯函数，由 client.js 在捕获阶段判定、命中扩展侧
// 配置的映射（dsh.bridge.shortcuts）后转发给父页面 → 扩展宿主 → vscode.commands.executeCommand。
// 规范写法（与 VS Code keybinding 语法相近）：修饰键 cmd/ctrl/alt/shift + '+' + 按键名。

/** 修饰键别名（canonicalizeCombo 归一化用） */
const SHORTCUT_MODIFIER_ALIASES = { meta: 'cmd', control: 'ctrl', option: 'alt' };
/** 按键别名（canonicalizeCombo 归一化用；与 getShortcutCombo 产出的规范名一致） */
const SHORTCUT_KEY_ALIASES = {
  esc: 'escape',
  backtick: '`',
  backquote: '`',
  return: 'enter',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};
/** 具名按键白名单（canonicalizeCombo 校验用） */
const SHORTCUT_NAMED_KEYS = new Set([
  'escape', 'enter', 'tab', 'space', 'backspace', 'delete', 'insert', 'home', 'end',
  'pageup', 'pagedown', 'capslock', 'up', 'down', 'left', 'right',
]);
/** 修饰键规范顺序（输出固定：cmd/ctrl/alt/shift，便于与配置键比对） */
const SHORTCUT_MOD_ORDER = ['cmd', 'ctrl', 'alt', 'shift'];

/**
 * 把键盘事件归一为「规范组合键字符串」（如 'cmd+1'、'ctrl+shift+f'、'cmd+`'）。
 *
 * 按键名优先取 e.code（布局无关：中文输入法下 ⌘+` 的 key 可能是 '·' 但 code 恒为
 * 'Backquote'）；无 code（测试桩/旧浏览器）时回退 e.key 小写。
 * 无任何修饰键的按键返回 null（普通输入/页面自身快捷键，不参与转发）。
 *
 * @param {{ key?: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean }} e
 * @returns {null | string} 规范组合键；无修饰键或输入非法返回 null
 */
export function getShortcutCombo(e) {
  if (!e || typeof e !== 'object') return null;
  const mods = [];
  if (e.metaKey === true) mods.push('cmd');
  if (e.ctrlKey === true) mods.push('ctrl');
  if (e.altKey === true) mods.push('alt');
  if (e.shiftKey === true) mods.push('shift');
  if (mods.length === 0) return null; // 无修饰键：普通按键，不转发
  const key = shortcutKeyName(e);
  if (key === null) return null;
  return mods.join('+') + '+' + key;
}

/** 按键 → 规范按键名（e.code 优先，布局无关；无 code 回退 e.key） */
function shortcutKeyName(e) {
  const code = typeof e.code === 'string' ? e.code : '';
  if (code !== '') {
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1].toLowerCase();
    const digit = /^Digit([0-9])$/.exec(code);
    if (digit) return digit[1];
    const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
    if (fn) return 'f' + fn[1];
    const byCode = {
      Backquote: '`', Escape: 'escape', Enter: 'enter', Tab: 'tab', Space: 'space',
      Backspace: 'backspace', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
      PageUp: 'pageup', PageDown: 'pagedown', ArrowLeft: 'left', ArrowRight: 'right',
      ArrowUp: 'up', ArrowDown: 'down', Minus: '-', Equal: '=', BracketLeft: '[',
      BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',',
      Period: '.', Slash: '/',
    };
    if (Object.prototype.hasOwnProperty.call(byCode, code)) return byCode[code];
    return code.toLowerCase(); // 其它 code（Numpad 等）按小写原样
  }
  const key = typeof e.key === 'string' && e.key !== '' ? e.key : '';
  if (key === '') return null;
  return key.toLowerCase();
}

/**
 * 把用户配置的组合键写法归一为规范形式（'CMD + Esc' → 'cmd+escape'）。
 * 规则：+ 分隔、去空格、小写、修饰键/按键别名归一；必须含 ≥1 个修饰键且恰好 1 个按键。
 * 非法输入（无修饰键、多余按键、未知键名、非字符串）返回 null，调用方应丢弃该条目。
 */
export function canonicalizeCombo(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split('+').map((p) => p.trim().toLowerCase()).filter((p) => p !== '');
  if (parts.length < 2) return null; // 至少一个修饰键 + 一个按键
  const mods = [];
  let key = null;
  for (const p of parts) {
    if (p === 'cmd' || p === 'ctrl' || p === 'alt' || p === 'shift') {
      mods.push(p);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(SHORTCUT_MODIFIER_ALIASES, p)) {
      mods.push(SHORTCUT_MODIFIER_ALIASES[p]);
      continue;
    }
    if (key !== null) return null; // 出现第二个按键：非法
    if (p.length === 1 && p !== '+') {
      key = p; // 单字符按键（字母/数字/标点）
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(SHORTCUT_KEY_ALIASES, p)) {
      key = SHORTCUT_KEY_ALIASES[p];
      continue;
    }
    if (SHORTCUT_NAMED_KEYS.has(p)) {
      key = p;
      continue;
    }
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) {
      key = p;
      continue;
    }
    return null; // 未知按键名
  }
  if (mods.length === 0 || key === null) return null;
  const ordered = SHORTCUT_MOD_ORDER.filter((m) => mods.includes(m)); // 去重 + 固定顺序
  return ordered.join('+') + '+' + key;
}

/**
 * 规范化快捷键映射对象：{ 组合键写法: VS Code 命令 id } → { 规范组合键: 命令 id }。
 * 非法组合键 / 非字符串命令被丢弃；非对象输入返回空对象（调用方决定回退默认）。
 */
export function normalizeShortcutMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const combo = canonicalizeCombo(k);
    if (combo === null || typeof v !== 'string' || v.trim() === '') continue;
    out[combo] = v.trim();
  }
  return out;
}

/** 构造「快捷键」上行消息（iframe 页面 → 父页面 → 扩展宿主执行 VS Code 命令） */
export function buildShortcutMessage(combo, key, code) {
  return {
    kind: 'shortcut',
    combo,
    key: typeof key === 'string' ? key : '',
    code: typeof code === 'string' ? code : '',
  };
}

/**
 * 从 DSH 工具调用行（ToolRow）的文件链接按钮文本中提取路径。
 *
 * 背景：agent 工具调用（read/write/edit 等）在对话里渲染为可点击的 fileLink 按钮
 * （无 title/aria-label，文本形如「read · <路径>」或直接「<路径>」），onClick 走
 * host.openPath（系统默认打开）。按钮文本里的路径可能相对会话 cwd（DSH 做了相对化
 * 显示）或带 ~ 主目录缩写，且可能带可选的「工具名 · 」前缀。
 *
 * 规则：去掉可选前缀与包裹引号，要求含路径分隔符（/ 或 \）才视为路径——
 * 无分隔符的文本（如 callId 摘要）不处理，避免误拦工具行的其它按钮。
 *
 * @param {unknown} text 按钮文本
 * @returns {string} 提取出的路径；不是路径形态返回 ''（调用方应放行原事件）
 */
export function extractToolLinkPath(text) {
  if (typeof text !== 'string') return '';
  let s = text.trim();
  // 去掉可选的「工具名 · 」前缀（工具名：字母开头，含字母数字下划线连字符）
  s = s.replace(/^[A-Za-z][A-Za-z0-9_-]*\s*·\s*/, '');
  // 去掉包裹引号（'、"、`）
  s = s.trim().replace(/^['"`]+|['"`]+$/g, '').trim();
  // 必须含路径分隔符才算路径形态（相对路径 src/a.ts、绝对 /a、盘符 C:\a、~ 缩写 ~/a）
  if (s === '' || (!s.includes('/') && !s.includes('\\'))) return '';
  return s;
}

/**
 * 判定一个元素是否为"可编辑元素"（可接收粘贴/剪切/打字的目标）。
 *
 * @param {object|null} el DOM 元素
 * @returns {boolean} true 表示 textarea / 可输入 input / contenteditable
 */
export function isEditableElement(el) {
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    // 真实 DOM 的 input.type 属性默认为 'text'，但为兼容测试桩与旧浏览器，
    // 空字符串 type 一律按 text 处理
    const type = typeof el.type === 'string' && el.type !== '' ? el.type.toLowerCase() : 'text';
    // 仅把能接收键盘文本输入的 type 视为可编辑（checkbox/button/range 等排除）
    return ['text', 'search', 'url', 'tel', 'password', 'number', 'email'].includes(type);
  }
  return el.isContentEditable === true;
}

/**
 * 计算在字符串的 [start, end) 区间插入 text 后的新值（纯函数，供可编辑元素兜底写入）。
 *
 * @param {string|undefined|null} value 原值（textarea.value 等）
 * @param {number} start 选区起点（selectionStart）
 * @param {number} end 选区终点（selectionEnd）
 * @param {string} text 待插入文本
 * @returns {string} 插入后的完整新值
 */
export function computeInsertedValue(value, start, end, text) {
  const v = typeof value === 'string' ? value : String(value ?? '');
  // 越界/负值/顺序异常都归一到合法区间，避免 slice 结果错乱
  const s = Math.max(0, Math.min(Number.isFinite(start) ? start : v.length, v.length));
  const e = Math.max(s, Math.min(Number.isFinite(end) ? end : v.length, v.length));
  return v.slice(0, s) + text + v.slice(e);
}

// 构造"读取剪贴板"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板读取，供粘贴兜底）
export function buildReadTextMessage(requestId) {
  return { kind: 'readText', requestId };
}

// 构造"读取剪贴板回执"消息（父页面 → iframe 页面，resolve/reject readText 的 Promise）
// ok=true 且 text 非空才视为成功；空文本/失败一律回执 ok=false（无可粘贴内容）
export function buildReadTextAck(requestId, ok, text) {
  return ok === true && typeof text === 'string' && text !== ''
    ? { kind: 'readTextAck', requestId, ok: true, text }
    : { kind: 'readTextAck', requestId, ok: false };
}
// —— v0.3.0 图片缓存降级：saveImage / deleteImages 消息与缓存文件名 ——
// 图片缓存文件的扩展名白名单（仅这些结尾才允许由扩展宿主落盘/删除，防任意文件写入/删除）
export const IMAGE_CACHE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/**
 * 生成图片缓存文件名（不含目录，目录由扩展侧拼接）：dsh-imgcache-<ts>-<i><ext>。
 * 扩展名不在白名单（或缺少点号）时返回 null（调用方不得落盘）。
 */
export function imageCacheFilename(timestamp, index, ext) {
  if (typeof ext !== 'string' || !IMAGE_CACHE_EXTENSIONS.includes(ext.toLowerCase())) return null;
  const t = typeof timestamp === 'string' && timestamp !== '' ? timestamp : String(Date.now());
  const i = Number.isFinite(index) ? index : 0;
  return 'dsh-imgcache-' + t + '-' + i + ext.toLowerCase();
}

// 构造「保存图片」上行消息（iframe 页面 → 父页面 → 扩展宿主落盘）
export function buildSaveImageRequest(requestId, name, dataB64, sessionCwd) {
  return { kind: 'saveImage', requestId, name, dataB64, sessionCwd };
}

/**
 * 解析「保存图片」回执：仅接受与期望 requestId 一致的 saveImageAck。
 * 返回 { ok, path? }；形状不合法或 requestId 不匹配返回 null。
 */
export function parseSaveImageAck(data, expectedRequestId) {
  if (
    data && typeof data === 'object' && data.kind === 'saveImageAck' &&
    data.requestId === expectedRequestId && typeof data.ok === 'boolean'
  ) {
    return typeof data.path === 'string' ? { ok: data.ok, path: data.path } : { ok: data.ok };
  }
  return null;
}

// 构造「删除图片缓存」上行消息（iframe 页面 → 父页面 → 扩展宿主删除）
export function buildDeleteImagesRequest(requestId, paths) {
  return { kind: 'deleteImages', requestId, paths: Array.isArray(paths) ? paths : [] };
}

/**
 * 解析「删除图片缓存」回执：仅接受与期望 requestId 一致的 deleteImagesAck。
 */
export function parseDeleteImagesAck(data, expectedRequestId) {
  if (
    data && typeof data === 'object' && data.kind === 'deleteImagesAck' &&
    data.requestId === expectedRequestId && typeof data.ok === 'boolean'
  ) {
    return { ok: data.ok };
  }
  return null;
}

// —— v0.3.0 图片自由上传降级：模型拒绝判定 / 内容重构 / 指纹 / 指针行 ——
/**
 * 判定一次 prompt RPC 响应是否为「模型不支持图像输入」而被拒。
 * 兼容三种形状：wire 包 ({ result:{ ok:false, error } })、flat ({ ok:false, error })、
 * 裸错误 ({ code, details })，便于单测与线上解析复用。
 */
export function detectModelReject(data) {
  if (!data || typeof data !== 'object') return false;
  const result = data.result && typeof data.result === 'object' ? data.result : data;
  const error = result.error && typeof result.error === 'object'
    ? result.error
    : data.error && typeof data.error === 'object'
      ? data.error
      : data;
  if (error.code !== 'attachment-error') return false;
  return !!(error.details && typeof error.details === 'object' && error.details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES');
}

/** 内容块数组是否含图片块（v0.3.0 判定是否需要走降级） */
export function isPromptWithImages(content) {
  return Array.isArray(content) && content.some((b) => b && typeof b === 'object' && b.type === 'image');
}

/** 提取内容块中的全部图片块（保持消息内的出现顺序，即用户上传/发送顺序） */
export function imageBlocksOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && typeof b === 'object' && b.type === 'image');
}

/**
 * 把「本条消息的图片块」按顺序映射到已捕获缓存，返回有序子集。
 * 只引用本条消息实际包含的图片，不再重复引用全部历史缓存（修复"一直重复引用
 * 根目录临时图片"）。匹配优先级：① 文件名相同；② base64 数据相同；③ 按序取
 * 首个未占用（尽力而为兜底）。entries 为 { key?, name?, b64?, mime? } 数组。
 */
export function matchCapturedImages(content, entries) {
  const blocks = imageBlocksOf(content);
  const remaining = Array.isArray(entries) ? [...entries] : [];
  const used = [];
  for (const block of blocks) {
    let hit = null;
    const name = typeof block.name === 'string' && block.name !== '' ? block.name : '';
    const data = typeof block.data === 'string' ? block.data.trim() : '';
    if (name) hit = remaining.find((e) => e && e.name === name) || null;
    if (!hit && data) hit = remaining.find((e) => e && typeof e.b64 === 'string' && e.b64.trim() === data) || null;
    if (!hit) hit = remaining[0] || null; // 兜底：按序取第一个未占用
    if (hit) {
      used.push(hit);
      remaining.splice(remaining.indexOf(hit), 1);
    }
  }
  return used;
}

/** 提取内容块中的全部文本（按顺序拼接，空行分隔） */
export function extractPromptText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** 中文数字 1..10（超出用阿拉伯数字兜底），用于图片按上传/发送顺序标注：图片一、图片二… */
export function zhOrdinal(n) {
  const ZH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const i = Math.floor(Number(n));
  return i >= 1 && i <= 10 ? ZH[i - 1] : String(i);
}

/**
 * 构造图片地址行：图片已落盘到 path，把 path 作为「地址」随消息发给模型，
 * 由模型自行判断/选择图像识别工具查看。n 为 1 起序号（图片一、图片二…），
 * 使多图按上传/发送顺序被明确标注；不传序号时保持'图片：<路径>'简写。
 */
export function buildImagePointerLine(path, n) {
  return n === undefined || n === null ? '图片：' + path : '图片' + zhOrdinal(n) + '：' + path;
}

/**
 * 构造纯文本内容块数组：原文本 + 图片指针行。
 * 无图片指针时保持原文本不变（形状不变），有指针时拼接到文本之后。
 */
export function buildTextOnlyContent(content, pointerLines) {
  const text = extractPromptText(content);
  const pointers = (Array.isArray(pointerLines) ? pointerLines : []).filter((l) => typeof l === 'string' && l !== '');
  const joined = pointers.length === 0 ? text : text === '' ? pointers.join('\n') : text + '\n\n' + pointers.join('\n');
  return [{ type: 'text', text: joined }];
}


/**
 * 文件指纹（去重键）：name:size:lastModified；关键字段缺失返回 null。
 * 用于附件捕获时对同一文件去重，避免重复落盘。
 */
export function imageCacheKey(fileLike) {
  if (!fileLike || typeof fileLike !== 'object') return null;
  const name = typeof fileLike.name === 'string' ? fileLike.name : '';
  const size = typeof fileLike.size === 'number' ? fileLike.size : 0;
  const lm = typeof fileLike.lastModified === 'number' ? fileLike.lastModified : 0;
  return name === '' ? null : name + ':' + size + ':' + lm;
}

/**
 * 解包 RPC 请求体 → 业务 payload。
 * DSH 的 fetch 请求体是 { rpcId, payload }（RpcRequest），content 等业务字段在 payload 下；
 * 兼容「直传 payload」的测试形态。v0.3.0 图片降级的拦截/重发都要经它对齐线格式。
 */
export function unwrapRpcPayload(body) {
  if (body && typeof body === 'object' && body.payload && typeof body.payload === 'object') return body.payload;
  return body;
}

/**
 * 以纯文本内容重构 RPC 请求：保留 DSH 线格式的 type/method（client-request/session.prompt，
 * 否则服务器会以 bad-request 拒绝重发），换新 rpcId（与已拒请求不撞车），
 * payload 保留原 sessionId/mode/clientTimeZone 等并把 content 替换为纯文本内容。
 */
export function buildTextResendRequest(originalBody, content) {
  const payload = unwrapRpcPayload(originalBody);
  const src = originalBody && typeof originalBody === 'object' ? originalBody : {};
  return {
    ...(typeof src.type === 'string' ? { type: src.type } : {}),
    rpcId: 'vsc-fb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    ...(typeof src.method === 'string' ? { method: src.method } : {}),
    payload: { ...payload, content },
  };
}

/**
 * 从 fetch 的 input 提取 URL 字符串（兼容 string / URL 实例(href) / Request 实例(url) 三种形态）。
 * 取不到返回 ''，调用方据此放弃重发，避免向非法地址发起无意义请求。
 * 背景：DSH 的 postJson 传入的是 new URL(...) 实例（只有 .href，没有 .url），
 * 若按 Request 的 .url 抽取会得到空串导致重发静默失败。
 */
export function resolveFetchUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    if (typeof input.href === 'string' && input.href !== '') return input.href; // URL 实例
    if (typeof input.url === 'string' && input.url !== '') return input.url;   // Request 实例
  }
  return '';
}

/**
 * 把 RPC 响应重新打包为「携带指定 rpcId」的新 Response。
 * 图片降级重发会使用新 rpcId（避免与服务端已处理请求撞车），而重发响应需要以
 * 「原请求的 rpcId」交回给 DSH 调用方，保持请求-响应关联一致。响应体不是可解析
 * 的 JSON（或没有 rpcId 字段）时原样返回，不做改写（不向 DSH 造假形状）。
 */
export async function rewriteRpcId(response, rpcId) {
  if (!response || typeof response.clone !== 'function' || typeof response.json !== 'function') return response;
  let json;
  try {
    json = await response.clone().json();
  } catch {
    return response;
  }
  if (!json || typeof json !== 'object' || typeof json.rpcId !== 'string') return response;
  return new Response(JSON.stringify({ ...json, rpcId }), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
  });
}

