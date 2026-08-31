// src/panel/provider.ts — 侧边栏面板：iframe 与占位页切换
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { ServiceManager } from '../service/manager';
import { handleBridgeMessage } from '../bridge/host';
import { isRemoteName } from '../remote';
import { t } from '../i18n';
import {
  loadingPage,
  errorPage,
  disconnectedPage,
  stoppedPage,
  readyPage,
  remoteDisabledPage,
  type PanelMessage,
  type PageCtx,
} from './html';

export class DshPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  /** 曾处于 ready：用于区分"服务断开"与"手动停止"两种占位页 */
  private wasConnected = false;
  /** 面板是否已首次打开过（用于一次性回调） */
  private openedOnce = false;
  /** 桥接握手 token：一次性防伪凭据，用密码学随机数（不可预测） */
  private readonly bridgeToken = randomUUID();
  /** 解析后的本地可达 URL（远程=隧道 URL、本地=原 URL；仅 ready 且远程启用时被设置） */
  private pendingExternalUrl: string | null = null;
  /** 渲染代数：递增使进行中的异步 URL 解析过期，防止乱序覆盖 */
  private renderGen = 0;

  /**
   * @param manager 服务管理器（面板与服务状态联动）
   * @param onFirstOpen 面板首次打开时调用一次的回调（用于引导提示，由入口注入）
   * @param onBridgeAck 桥接握手回执回调（Task 7 评估桥接状态时注入；可选）
   * @param workspaceRoot 工作区根目录注入函数（openFile 相对路径解析的兜底基准；可选，默认无根）
   * @param bridgeEnabled 桥接是否启用的 getter（Task 7 由 dsh.bridge.enabled 配置驱动；默认启用，
   *   disabled 时不注入握手脚本，避免向未安装桥接的 DSH 页面发送无意义的握手）
   * @param remoteEnabled 是否启用远程（SSH Remote 等）的 getter（v0.3.0，默认关闭）
   * @param resolveExternalUrl URL→本地可达 URL 解析器（远程走 asExternalUri 隧道；默认原样返回）
   * @param imageFallback 是否启用非视觉模型图片降级（v0.3.0，默认开）
   * @param shortcuts 桥接快捷键映射 getter（v0.3.2：组合键 → VS Code 命令 id，随握手下发 iframe）
   */
  constructor(
    private manager: ServiceManager,
    private onFirstOpen?: () => void,
    private onBridgeAck?: (ok: boolean, version?: string) => void,
    private workspaceRoot: () => string | undefined = () => undefined,
    private bridgeEnabled: () => boolean = () => true,
    private remoteEnabled: () => boolean = () => false,
    private resolveExternalUrl: (url: string) => Promise<string> = async (u) => u,
    private imageFallback: () => boolean = () => true,
    private shortcuts: () => Record<string, string> = () => ({}),
  ) {
    // 订阅状态变化，重绘面板（iframe 与占位页由状态驱动，无白屏路径）
    manager.onChange(() => void this.handleStateChange());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // enableScripts 允许占位页的内联按钮脚本（nonce 放行）运行。
    // 注意：retainContextWhenHidden 不在这里设置——它不是 WebviewOptions 字段，
    // 由 Task 10 注册视图时通过第三参数传入（隐藏面板时保留 iframe 会话）。
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: PanelMessage) => this.onMessage(msg));
    if (!this.openedOnce) {
      this.openedOnce = true;
      this.onFirstOpen?.(); // 首次打开：触发一次性引导（如"移到右侧栏"提示）
    }
    this.render();
    // 远程窗口且未启用远程支持：仅显示占位页，绝不在此窗口启动远端 dsh 服务。
    if (this.remoteWindowDisabled()) return;
    // 面板打开即确保服务运行：复用已有或自动启动。
    void this.manager.ensureRunning();
  }

  /**
   * 当前窗口是否处于「远程但未启用」状态：远程窗口（remoteName 非空）且 dsh.remote.enabled=false。
   * 该状态下不拉起远端服务、不建隧道，仅展示引导占位页。
   */
  private remoteWindowDisabled(): boolean {
    return isRemoteName(vscode.env.remoteName) && !this.remoteEnabled();
  }

  /** 当前展示用的本地可达 URL（供「复制网址」命令使用；未解析时返回 null 由调用方回退原 URL） */
  getDisplayUrl(): string | null {
    return this.pendingExternalUrl;
  }

  /** 处理面板内按钮消息（全部转交给 manager 或对应命令） */
  private onMessage(msg: PanelMessage): void {
    switch (msg.type) {
      case 'retry':
      case 'reconnect':
        void this.manager.ensureRunning();
        break;
      case 'restart':
        void this.manager.restart();
        break;
      case 'stop':
        this.wasConnected = false;
        void this.manager.stop();
        break;
      case 'openExternal':
        void vscode.commands.executeCommand('dsh.openExternal');
        break;
      case 'copyUrl':
        void vscode.commands.executeCommand('dsh.copyUrl');
        break;
      case 'showLogs':
        void vscode.commands.executeCommand('dsh.showLogs');
        break;
      case 'openSettings':
        // 远程未启用占位页的「打开设置」按钮：聚焦 dsh.remote.enabled 设置
        void vscode.commands.executeCommand('workbench.action.openSettings', 'dsh.remote.enabled');
        break;
      case 'bridgeCopyText':
        // 桥接剪贴板消息：VS Code 会拦截跨源 iframe 的原生 clipboard API，
        // 这里由扩展宿主写系统剪贴板，并回执给 iframe 收尾其 writeText Promise。
        void this.copyTextToClipboard(msg);
        break;
      case 'bridgeReadText':
        // 剪贴板读取：扩展宿主读系统剪贴板（无 webview 权限限制），
        // 回执给 iframe 供其 Cmd+V 粘贴兜底使用。
        void this.readTextFromClipboard(msg);
        break;
      case 'bridgeOpenExternal':
      case 'bridgeOpenFile':
      case 'bridgeSaveImage':
      case 'bridgeDeleteImages':
        // 桥接消息统一走 host 的 handleBridgeMessage（外链/文件/图片落盘与删除，白名单与路径安全在 host 层）
        void handleBridgeMessage(msg, this.bridgeDeps());
        break;
      case 'bridgeAck':
        // 握手回执：通知注入的回调（Task 7 据此评估桥接状态；version 供日志确认桥接代码版本）
        this.onBridgeAck?.(msg.ok, msg.version);
        break;
      case 'bridgeShortcut': {
        // 快捷键桥接（v0.3.2）：iframe 内命中的组合键 → 按 dsh.bridge.shortcuts 映射执行 VS Code 命令。
        // 命令 id 只来自本扩展配置（绝不接受页面侧直传命令），未知命令仅记日志不打断操作。
        const cmd = this.shortcuts()[msg.combo];
        if (typeof cmd === 'string' && cmd !== '') {
          void vscode.commands.executeCommand(cmd).then(undefined, (err) => {
            console.warn(`[dsh] shortcut ${msg.combo} -> command ${cmd} failed: ${String(err)}`);
          });
        } else {
          console.warn(`[dsh] shortcut ${msg.combo} has no mapping`);
        }
        break;
      }
    }
  }

  /** 配置变更后重渲染（快捷键映射变化时由入口调用；iframe 随重渲染重载并重新握手） */
  refresh(): void {
    this.render();
  }

  /** 桥接落盘/删除依赖：图片缓存写文件/删文件（node:fs/promises）与回执投递（webview.postMessage） */
  private bridgeDeps(): Parameters<typeof handleBridgeMessage>[1] {
    return {
      openExternal: (u) => vscode.env.openExternal(vscode.Uri.parse(u)),
      // showTextDocument 返回 TextEditor，而依赖约定返回 Thenable<void>：用 async 包装丢弃返回值
      openTextDocument: async (p) => {
        await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false });
      },
      // 用户提示统一走 vscode.window.showWarningMessage（host 层不 import vscode，保持纯逻辑可单测）
      showWarning: (m) => void vscode.window.showWarningMessage(m),
      workspaceRoot: this.workspaceRoot(), // 工作区根目录：openFile 相对路径解析的兜底基准
      // 图片缓存：以 base64 写入（node:fs/promises 支持 base64 编码字符串）；删除用 unlink
      writeFile: async (p, b64) => {
        await nodeFs.writeFile(p, Buffer.from(b64, 'base64'));
      },
      rmFile: async (p) => {
        await nodeFs.unlink(p);
      },
      // 回执：由顶层握手脚本转发回 iframe（saveImageAck / deleteImagesAck）
      reply: async (m) => {
        await this.view?.webview.postMessage(m);
      },
    };
  }

  /** 剪贴板桥接：扩展宿主写系统剪贴板，完成后回执给 webview（由顶层脚本转发给 iframe） */
  private async copyTextToClipboard(msg: Extract<PanelMessage, { type: 'bridgeCopyText' }>): Promise<void> {
    let ok = false;
    try {
      await vscode.env.clipboard.writeText(msg.text);
      ok = true;
    } catch {
      // 写剪贴板失败：回执 ok=false，iframe 侧会 reject writeText，
      // DSH 会继续走自己的 execCommand('copy') 回退路径。
    }
    try {
      await this.view?.webview.postMessage({ type: 'bridgeCopyTextAck', requestId: msg.requestId, ok });
    } catch {
      // 面板可能已隐藏/销毁，回执发不出去也不影响扩展其它功能。
    }
  }

  /** 剪贴板桥接：扩展宿主读系统剪贴板，完成后回执给 webview（由顶层脚本转发给 iframe） */
  private async readTextFromClipboard(msg: Extract<PanelMessage, { type: 'bridgeReadText' }>): Promise<void> {
    let ok = false;
    let text: string | undefined;
    try {
      // 读取失败或内容为空时都回执 ok=false，iframe 侧放弃本次粘贴
      text = await vscode.env.clipboard.readText();
      ok = typeof text === 'string' && text !== '';
    } catch {
      // 读剪贴板失败（如系统无剪贴板权限）：回执 ok=false，iframe 侧静默放弃
    }
    try {
      await this.view?.webview.postMessage({
        type: 'bridgeReadTextAck',
        requestId: msg.requestId,
        ok,
        text,
      });
    } catch {
      // 面板可能已隐藏/销毁，回执发不出去也不影响扩展其它功能。
    }
  }

  /**
   * 状态变化处理：远程且启用时异步解析隧道 URL（防乱序后落地），
   * 其余情况直接渲染（远程未启用会由 render 短路为占位页）。
   */
  private async handleStateChange(): Promise<void> {
    const s = this.manager.getSnapshot();
    if (s.state === 'ready' && isRemoteName(vscode.env.remoteName) && this.remoteEnabled()) {
      const gen = ++this.renderGen;
      // 面板嵌入用地址：新版 dsh 优先代理地址（webview 无 Cookie 也能访问）；本地原样
      const raw = s.embedUrl ?? s.url ?? this.rawUrl();
      const resolved = await this.resolveExternalUrl(raw);
      if (gen !== this.renderGen) return; // 期间状态又变，丢弃过期结果
      this.pendingExternalUrl = resolved;
    } else {
      ++this.renderGen; // 使进行中的解析过期
      this.pendingExternalUrl = null;
    }
    this.render();
  }

  /** 未解析兜底的目标地址（manager 配置的 host/port） */
  private rawUrl(): string {
    const { host, port } = this.manager.getTarget();
    return `http://${host}:${port}/`;
  }

  /** 按服务状态渲染对应页面 */
  private render(): void {
    const v = this.view;
    if (!v) return;
    const nonce = Math.random().toString(36).slice(2);
    const { host, port } = this.manager.getTarget();
    const ctx: PageCtx = { nonce, cspSource: v.webview.cspSource, frameHosts: [`http://${host}:${port}`] };
    const s = this.manager.getSnapshot();
    let html: string;
    // 远程窗口且未启用：任何状态都只展示引导占位页，不触碰远端服务。
    if (this.remoteWindowDisabled()) {
      html = remoteDisabledPage(t, ctx);
    } else {
      switch (s.state) {
        case 'ready':
          this.wasConnected = true;
          // iframe/CSP 使用解析后的本地可达 URL（远程=隧道；本地=代理地址或原地址）。
          // frameHosts 以实际 iframe 地址的 origin 为准，保证 CSP 放行（代理端口与 dsh 端口不同）。
          {
            const displayUrl = this.pendingExternalUrl ?? s.embedUrl ?? s.url ?? this.rawUrl();
            const frameOrigin =
              this.pendingExternalUrl !== null
                ? new URL(this.pendingExternalUrl).origin
                : s.embedUrl !== null
                  ? new URL(s.embedUrl).origin
                  : null;
            if (frameOrigin !== null) ctx.frameHosts = [frameOrigin];
            html = readyPage(displayUrl, ctx, {
              token: this.bridgeToken,
              enabled: this.bridgeEnabled(), // 由 dsh.bridge.enabled 配置驱动（Task 7 接入）
              imageFallback: this.imageFallback(), // v0.3.0：降级开关随握手消息带给桥接客户端
              shortcuts: this.shortcuts(), // v0.3.2：快捷键映射随握手消息带给桥接客户端（拦截哪些组合键）
            });
          }
          break;
        case 'failed':
          html = errorPage(t, ctx, s.error ? t(s.error, s.errorVars) : t('err.loadFailed'));
          break;
        case 'idle':
          html = this.wasConnected ? disconnectedPage(t, ctx) : stoppedPage(t, ctx);
          break;
        default:
          // detecting / starting / waiting / stopping：统一加载中动画页
          html = loadingPage(t, ctx);
      }
    }
    v.webview.html = html;
  }
}
