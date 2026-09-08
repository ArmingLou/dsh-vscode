// src/panel/html.ts — 面板占位页模板（纯函数、无逻辑、不依赖 vscode）
import type { MsgKey } from '../i18n';

/** 翻译函数签名（把 i18n.t 传入模板） */
export type T = (key: MsgKey, vars?: Record<string, string | number>) => string;

/** 面板内按钮发回扩展的消息类型（含桥接跳转与握手回执三类） */
export type PanelMessage =
  | { type: 'retry' }
  | { type: 'reconnect' }
  | { type: 'openExternal' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'copyUrl' }
  | { type: 'showLogs' }
  | { type: 'bridgeOpenExternal'; url: string }
  | { type: 'bridgeOpenFile'; path: string; cwd?: string }
  | { type: 'bridgeCopyText'; text: string; requestId: string }
  | { type: 'bridgeReadText'; requestId: string }
  | { type: 'bridgeReadTextAck'; requestId: string; ok: boolean; text?: string }
  | { type: 'bridgeAck'; ok: boolean; version?: string }
  | { type: 'openSettings' }
  | { type: 'bridgeSaveImage'; requestId: string; name: string; dataB64: string; sessionCwd?: string }
  | { type: 'bridgeSaveImageAck'; requestId: string; ok: boolean; path?: string }
  | { type: 'bridgeDeleteImages'; requestId: string; paths: string[] }
  | { type: 'bridgeDeleteImagesAck'; requestId: string; ok: boolean }
  | { type: 'bridgeSyncWorkspace'; workspaceId: string }
  | { type: 'bridgeShortcut'; combo: string; key?: string; code?: string }
  | { type: 'reloadPage' }
  | { type: 'retryBridgeInstall' };

/** 渲染上下文 */
export interface PageCtx {
  /** 内联脚本的 CSP nonce */
  nonce: string;
  /** webview.cspSource（本地资源来源） */
  cspSource: string;
  /** 允许加载 iframe 的目标地址（DSH 服务地址） */
  frameHosts: string[];
}

/** CSP：最小权限——只放行目标 iframe 与带 nonce 的内联脚本 */
function csp(ctx: PageCtx): string {
  return [
    "default-src 'none'",
    `frame-src ${ctx.frameHosts.join(' ')}`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${ctx.nonce}'`,
    `img-src ${ctx.cspSource} data:`,
  ].join('; ');
}

/** 通用样式（使用 VS Code 主题变量，自动适配浅色/深色主题） */
const STYLE = `
body { margin: 0; padding: 0; height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
body.frame-body { display: block; }
.center { text-align: center; max-width: 90%; }
p { margin: 8px 0 16px; opacity: 0.9; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; margin: 4px; cursor: pointer; border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground); }
.spinner { width: 28px; height: 28px; border: 3px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; margin: 0 auto 12px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
iframe.frame { position: fixed; inset: 0; width: 100%; height: 100%; border: none; }
/* 页面加载异常提示条：悬浮在 iframe 底部（默认隐藏，扩展侧握手失败/超时后 postMessage 显示） */
.trouble-bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 8px; padding: 6px 10px; z-index: 10; font-size: 12px; background: var(--vscode-notifications-background, var(--vscode-editorWidget-background)); border-top: 1px solid var(--vscode-widget-border, color-mix(in srgb, currentColor 25%, transparent)); color: var(--vscode-foreground); }
.trouble-bar[hidden] { display: none; }
.trouble-bar .trouble-text { flex: 1; min-width: 0; opacity: 0.95; }
.trouble-bar button { padding: 3px 10px; margin: 0; }
`;

/** 按钮点击 → postMessage 的内联脚本（nonce 放行） */
const BUTTON_SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  vscode.postMessage({ type: btn.dataset.action });
});
`;

/**
 * 页面加载异常提示条控制脚本（与 BUTTON_SCRIPT 共用其声明的 vscode 变量）。
 * 扩展侧在握手超时/失败后 postMessage {type:'setBridgeTrouble',trouble}，
 * 此处切换底部提示条显隐（纯 DOM 操作，不重载 iframe、不打断已加载的 DSH 页面）。
 */
const TROUBLE_BAR_SCRIPT = `
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'setBridgeTrouble') return;
  const bar = document.getElementById('trouble-bar');
  if (bar) bar.hidden = !d.trouble;
});
`;

/** 页面加载异常提示条（初始隐藏；按钮走 BUTTON_SCRIPT 的 data-action → postMessage） */
function troubleBar(t: T): string {
  return `<div id="trouble-bar" class="trouble-bar" hidden>
<span class="trouble-text">${t('panel.troubleHint')}</span>
<button data-action="reloadPage">${t('panel.troubleReload')}</button>
<button data-action="retryBridgeInstall">${t('panel.troubleRetryBridge')}</button>
</div>`;
}

/**
 * 桥接握手脚本（内联，nonce 放行，紧随 BUTTON_SCRIPT 之后、共用其声明的 vscode）。
 * 职责：
 *  - 上行：向 iframe 下发 { kind:'bridgeHello', token } 握手消息，接收其 bridgeAck 回执，
 *    并把 iframe 上行消息（openExternal / openFile / copyText）转发给扩展侧处理；
 *  - 下行：把扩展侧的剪贴板回执 { type:'bridgeCopyTextAck' } 转发回 iframe，
 *    供 DSH 页面内的 writeText Promise 收尾（VS Code 会拦截跨源 iframe 的原生剪贴板 API）。
 * 安全约束：上行仅接收「目标 origin」且「source 为 iframe 内容窗口」的消息，防止其它站点伪造。
 * @param token 握手防伪凭据（与桥接侧 isBridgeMessage 校验的一致）
 * @param allowedOrigin 允许的消息来源 origin（由 DSH 页面地址推导，如 http://127.0.0.1:3080）
 * @param imageFallback 非视觉模型图片降级开关（随 hello 下发）
 * @param shortcuts 桥接快捷键映射（v0.3.2：组合键 → VS Code 命令 id，随 hello 下发供 iframe 拦截）
 */
function bridgeHandshakeScript(
  token: string,
  allowedOrigin: string,
  imageFallback: boolean,
  shortcuts: Record<string, string>,
): string {
  // 快捷键映射含反引号键（'cmd+`'）：JSON 内嵌进外层模板字符串会提前终止模板字面量，
  // 因此把反引号与 ${ 转义为 \uXXXX 序列（浏览器解析后还原，语义不变）
  const shortcutsJson = JSON.stringify(shortcuts).replaceAll('`', '\\u0060').replaceAll('${', '\\u0024{');
  return `
// dsh-bridge-handshake：DSH 页面桥接握手与消息路由（上行转发 + 剪贴板回执下行转发）
const iframeEl = document.getElementById('dsh-frame');
if (iframeEl) {
  const iframeSrc = iframeEl.src;
  // 握手 token 与允许的 DSH 页面 origin
  const TOKEN = ${JSON.stringify(token)};
  const ALLOWED_ORIGIN = ${JSON.stringify(allowedOrigin)};
  const IMAGE_FALLBACK = ${JSON.stringify(imageFallback)}; // v0.3.0：非视觉模型图片降级开关
  const SHORTCUTS = ${shortcutsJson}; // v0.3.2：桥接快捷键映射（组合键 → VS Code 命令 id）
  let bridgeAcked = false;
  window.addEventListener('message', (e) => {
    const d = e.data;
    // —— 下行：扩展宿主回执（vscode.webview.postMessage 投递），转发给 iframe ——
    if (d && d.type === 'bridgeCopyTextAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({ kind: 'copyTextAck', requestId: d.requestId, ok: d.ok }, iframeSrc);
      return;
    }
    // 剪贴板读取回执：转发给 iframe，供其 resolve 粘贴兜底的 readText Promise
    if (d && d.type === 'bridgeReadTextAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({
        kind: 'readTextAck',
        requestId: d.requestId,
        ok: d.ok,
        text: typeof d.text === 'string' ? d.text : undefined,
      }, iframeSrc);
      return;
    }
    // 保存图片回执：转发给 iframe，resolve 其 saveImage Promise（ok + 落盘绝对路径）
    if (d && d.type === 'bridgeSaveImageAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({
        kind: 'saveImageAck',
        requestId: d.requestId,
        ok: d.ok,
        ...(typeof d.path === 'string' ? { path: d.path } : {}),
      }, iframeSrc);
      return;
    }
    // 删除图片回执：转发给 iframe，resolve 其 deleteImages Promise
    if (d && d.type === 'bridgeDeleteImagesAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({ kind: 'deleteImagesAck', requestId: d.requestId, ok: d.ok }, iframeSrc);
      return;
    }
    // 工作区同步：扩展侧 syncWorkspace 完成后下发 workspaceId，转发给 iframe 供 session.create 使用
    if (d && d.type === 'bridgeSyncWorkspace' && typeof d.workspaceId === 'string') {
      iframeEl.contentWindow.postMessage({ kind: 'bridgeSyncWorkspace', workspaceId: d.workspaceId }, iframeSrc);
      return;
    }
    // —— 上行：iframe 发来的消息，origin + source 双重校验 ——
    if (e.origin !== ALLOWED_ORIGIN || e.source !== iframeEl.contentWindow) return;
    // 握手回执：统一形状 { kind:'bridgeAck', ok }（不带 token 字段），只读 ok
    if (d && d.kind === 'bridgeAck') {
      bridgeAcked = true;
      vscode.postMessage({
        type: 'bridgeAck',
        ok: d.ok === true,
        ...(typeof d.version === 'string' ? { version: d.version } : {}),
      });
      return;
    }
    // 打开外链：转发给扩展 → vscode.env.openExternal
    if (d && d.kind === 'openExternal' && typeof d.url === 'string') { vscode.postMessage({ type: 'bridgeOpenExternal', url: d.url }); return; }
    // 打开文件：转发给扩展 → showTextDocument（携带可选 cwd）
    if (d && d.kind === 'openFile' && typeof d.path === 'string') {
      vscode.postMessage({ type: 'bridgeOpenFile', path: d.path, cwd: typeof d.cwd === 'string' ? d.cwd : undefined });
      return;
    }
    // 复制文本：转发给扩展 → vscode.env.clipboard.writeText（跨源 iframe 原生剪贴板 API 被 VS Code 拦截）
    if (d && d.kind === 'copyText' && typeof d.text === 'string' && typeof d.requestId === 'string') {
      vscode.postMessage({ type: 'bridgeCopyText', text: d.text, requestId: d.requestId });
      return;
    }
    // 保存图片：转发给扩展 → 扩展宿主落盘到会话 cwd（v0.3.0 图片降级）
    if (d && d.kind === 'saveImage' && typeof d.requestId === 'string' && typeof d.name === 'string' && typeof d.dataB64 === 'string') {
      vscode.postMessage({
        type: 'bridgeSaveImage',
        requestId: d.requestId,
        name: d.name,
        dataB64: d.dataB64,
        ...(typeof d.sessionCwd === 'string' ? { sessionCwd: d.sessionCwd } : {}),
      });
      return;
    }
    // 删除图片缓存：转发给扩展 → 扩展宿主删除文件（会话结束清理）
    if (d && d.kind === 'deleteImages' && typeof d.requestId === 'string' && Array.isArray(d.paths)) {
      vscode.postMessage({ type: 'bridgeDeleteImages', requestId: d.requestId, paths: d.paths });
      return;
    }
    // 读取剪贴板：转发给扩展 → vscode.env.clipboard.readText（Cmd+V 粘贴兜底）
    if (d && d.kind === 'readText' && typeof d.requestId === 'string') {
      vscode.postMessage({ type: 'bridgeReadText', requestId: d.requestId });
      return;
    }
    // 快捷键：转发给扩展 → 按 dsh.bridge.shortcuts 映射执行 VS Code 命令
    // （VS Code 吞掉 iframe 内 Cmd+1/Cmd+Esc/Cmd+反引号 等组合键的修复，v0.3.2）
    if (d && d.kind === 'shortcut' && typeof d.combo === 'string') {
      vscode.postMessage({
        type: 'bridgeShortcut',
        combo: d.combo,
        ...(typeof d.key === 'string' ? { key: d.key } : {}),
        ...(typeof d.code === 'string' ? { code: d.code } : {}),
      });
    }
  });
  // iframe 加载完成后下发握手消息（携带 token）。
  // DSH 的 client 插件 factory 可能在 load 之后才 materialize，握手消息会丢失，
  // 因此收到 bridgeAck 前每 250ms 重发一次，最多重试 3 秒。
  iframeEl.addEventListener('load', () => {
    let helloAttempts = 0;
    const sendHello = () => {
      if (!bridgeAcked && iframeEl.contentWindow) {
        iframeEl.contentWindow.postMessage({ kind: 'bridgeHello', token: TOKEN, imageFallback: IMAGE_FALLBACK, shortcuts: SHORTCUTS }, iframeSrc);
      }
    };
    sendHello();
    const helloRetry = setInterval(() => {
      helloAttempts += 1;
      if (bridgeAcked || helloAttempts > 12) { clearInterval(helloRetry); return; }
      sendHello();
    }, 250);
  });
}`;
}

/** HTML 转义（防御性，消息来自 i18n 但转义不费事） */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 页面外壳：公共骨架 + BUTTON_SCRIPT，可选追加额外内联脚本（如桥接握手脚本）。
 * @param extraScripts 追加在 BUTTON_SCRIPT 之后、</body> 之前的内联脚本（含 <script> 标签）
 */
function shell(ctx: PageCtx, title: string, bodyClass: string, body: string, extraScripts = ''): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(ctx)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body class="${bodyClass}">${body}
<script nonce="${ctx.nonce}">${BUTTON_SCRIPT}</script>${extraScripts}
</body>
</html>`;
}

/** 加载中占位页 */
export function loadingPage(t: T, ctx: PageCtx): string {
  return shell(ctx, t('panel.loading'), '', `<div class="center"><div class="spinner"></div><p>${t('panel.loading')}</p></div>`);
}

/** 新版 dsh 代理未就绪时的占位页：iframe 直连会 401（SameSite Cookie 不可达），显示连接中 + 浏览器打开按钮 */
export function connectingPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('panel.connecting'),
    '',
    `<div class="center"><div class="spinner"></div><p>${t('panel.connecting')}</p>
<button data-action="openExternal">${t('panel.openExternal')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 启动失败占位页：原因 + 重试 + 查看日志 */
export function errorPage(t: T, ctx: PageCtx, message: string): string {
  return shell(
    ctx,
    t('panel.errorTitle'),
    '',
    `<div class="center"><p>${t('panel.errorTitle')}</p><p>${escapeHtml(message)}</p>
<button data-action="retry">${t('panel.retry')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 服务断开占位页：重连 + 查看日志 */
export function disconnectedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('panel.disconnectedTitle'),
    '',
    `<div class="center"><p>${t('panel.disconnectedTitle')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/**
 * 用户手动断开占位页（「断开面板连接」工具栏按钮）：后端服务仍在运行，仅本面板的嵌入连接被断开。
 * 与 disconnectedPage 视觉/按钮对齐（重新连接 + 查看日志）；粘性由 provider 侧保证——
 * 任何重渲染路径在 detached 状态下一律渲染本页，只有用户点「重新连接」才恢复 iframe。
 */
export function detachedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('panel.detachedTitle'),
    '',
    `<div class="center"><p>${t('panel.detachedTitle')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 远程未启用占位页：远程窗口且 dsh.remote.enabled=false 时展示，引导用户开启并重载（v0.3.0） */
export function remoteDisabledPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('panel.remoteDisabled'),
    '',
    '<div class="center"><p>' + t('panel.remoteDisabled') + '</p>' +
    '<button data-action="openSettings">' + t('panel.openSettings') + '</button></div>',
  );
}

/** 手动停止后的占位页 */
export function stoppedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('status.stopped'),
    '',
    `<div class="center"><p>${t('status.stopped')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button></div>`,
  );
}

/**
 * 就绪页：全屏 iframe 加载真实 DSH 网页（无 sandbox，避免破坏页面自身功能）。
 * iframe 显式声明 allow="clipboard-write" 作为第一层修复；但 VS Code 对 webview 内跨源 iframe 的
 * 原生剪贴板 API 仍存在权限拦截（microsoft/vscode#182642），因此还需桥接脚本把 DSH 页面内的
 * writeText 转发给扩展宿主（vscode.env.clipboard）执行，才能真正写入系统剪贴板。
 * 桥接启用时注入握手脚本，让顶层 webview 与 DSH 页面 iframe 建立握手并转发跳转/剪贴板消息。
 * @param bridge 桥接配置（可选，向后兼容既有调用）：token 为握手凭据，enabled 为是否注入握手脚本
 */
export function readyPage(
  url: string,
  ctx: PageCtx,
  bridge?: { token: string; enabled: boolean; imageFallback?: boolean; shortcuts?: Record<string, string> },
  t?: T,
): string {
  // 桥接启用时注入握手脚本；未传入或 enabled=false 时保持向后兼容，不注入
  const extraScripts = bridge?.enabled
    ? `<script nonce="${ctx.nonce}">${bridgeHandshakeScript(
        bridge.token,
        new URL(url).origin,
        bridge.imageFallback === true,
        bridge.shortcuts ?? {},
      )}</script>`
    : '';
  // 提示条控制脚本始终注入（提示条本身始终渲染但默认隐藏，扩展侧可随时点亮）
  const troubleScript = `<script nonce="${ctx.nonce}">${TROUBLE_BAR_SCRIPT}</script>`;
  // 翻译函数未传入时提示条文案降级为英文原键（不影响 iframe 主体功能）
  const tt: T = t ?? ((key) => key);
  return shell(
    ctx,
    'DSH',
    'frame-body',
    `<iframe id="dsh-frame" class="frame" allow="clipboard-write" src="${url}"></iframe>${troubleBar(tt)}`,
    extraScripts + troubleScript,
  );
}
