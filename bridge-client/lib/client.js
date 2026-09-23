// bridge-client/lib/client.js — DSH 页面内桥接 bundle（浏览器端，工厂注册）
// 重要说明：本文件是"模板"，工厂体内的核心逻辑占位标记会在构建时（scripts/build.mjs）
// 被 core.js 的纯逻辑内容替换，输出到 out/bridge-client/lib/client.js。
// 这样做的原因：DSH 的 client bundle 通过普通 <script> 加载，工厂的 require 只解析
// 包名 / 平台种子词，不支持相对路径 require('./core.js')；ESM import 在普通 script 中
// 同样不可用。因此把 core.js 内联进工厂，保证"生产运行的逻辑 = 单测验证的逻辑"同一份源码。
// 分工：core.js 保持纯函数、无 DOM、无 window 引用；本文件只做 DOM 事件绑定与 postMessage。
// 额外职责（Task 复制修复 v0.2.4）：VS Code 在 macOS 上会吞掉嵌套 iframe 里的
// Cmd+C / Cmd+V / Cmd+A 等标准快捷键与右键菜单（microsoft/vscode#129178 / #180234），
// 因此握手成功后由本文件捕获 keydown/contextmenu：keydown 用 document.execCommand
// 模拟标准编辑命令（复制/粘贴/剪切/全选/撤销/重做），失败时经剪贴板桥接兜底；
// contextmenu 弹出自定义右键菜单，不再依赖 VS Code 的原生菜单。
window.__ModuleLoader__.load({
  // id 必须等于 package.json 的 name（节点侧以此作为图条目 id 与 URL 路径）
  id: "dsh-vscode-bridge",
  // factory 体在 materialize 阶段执行（shell 启动时为每个插件行触发）
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    /*__CORE_INLINE__*/
    // —— 幂等安装保护：防止本模块被重复 materialize（如 HMR 热重载/重复注入）——
    // 每次执行都会向 window 注册 keydown/contextmenu 等监听器，重复执行会让监听器
    // 叠加，一次按键被处理多次 → 快捷键 cmd+1/cmd+2/cmd+3 偶发连续触发两次。
    if (window.__dshVscodeBridgeInstalled === true) {
      console.warn("[dsh-vscode-bridge] client.js 已安装，跳过重复注册（防快捷键双发）");
      return module.exports;
    }
    window.__dshVscodeBridgeInstalled = true;
    // —— 验证标记：证明本 bundle 已在页面内 materialize 并执行（供 Task 0/9 回归用） ——
    window.__dshVscodeBridgeReady = true;
    console.log("[dsh-vscode-bridge] client.js executed");
    // —— 握手状态 ——
    let bridgeToken = ""; // 父页面下发的握手 token；未握手前为空，不激活任何拦截
    let bridgeWorkspaceId = ""; // 工作区同步后下发的 workspaceId；未同步前为空
    let bridgeWorkspacePath = ""; // 工作区同步后下发的绝对路径；用于在界面下拉里匹配工作区项

    // —— 工作区界面切换（防御式）：打开工作区下拉→按目录名匹配工作区项→点击，让界面激活当前工作区。
    // 全程 try/catch + 找不到就静默放弃，绝不抛异常、不影响前端。 ——
    function activateWorkspaceInUi() {
      try {
        const p = String(bridgeWorkspacePath || "").trim();
        const targetName = p.replace(/^.*[\\/]/g, "").trim();
        const targets = [targetName, p].filter(Boolean);
        if (targets.length === 0) return;
        const btn = document.querySelector('[aria-label="选择工作区"]') || document.querySelector('.pXSMma_workspace');
        if (!btn) return;
        const openMenu = () => { if (btn.getAttribute("aria-expanded") !== "true") btn.click(); };
        openMenu();
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          try {
            openMenu(); // 每轮确保下拉仍展开（避免被其它交互关闭后漏匹配）
            const itemBtns = document.querySelectorAll('button[role="menuitem"]');
            for (const b of itemBtns) {
              const lbl = b.querySelector('[class*="_itemLabel"]') || b;
              const t = String(lbl.textContent || "").trim();
              if (targets.some((s) => t === s || t.includes(s))) { b.click(); clearInterval(timer); return; }
            }
            if (tries >= 50) clearInterval(timer); // 约 5s 上限
          } catch { clearInterval(timer); }
        }, 100);
      } catch { /* 静默失败，绝不抛异常 */ }
    }


    // —— 桥接快捷键映射（v0.3.2）：握手时随 bridgeHello 下发 { 组合键: VS Code 命令 id } ——
    // 背景：VS Code 只把快捷键转发给顶层 webview，嵌套 iframe 内的 Cmd+1 / Cmd+Esc / Cmd+` 等
    // 组合键全部被吞掉（与 Cmd+C/V 同源问题）。扩展侧按 dsh.bridge.shortcuts 配置生成该映射，
    // 页面侧只读「键集合」决定拦截哪些组合键：命中 → 转发扩展宿主执行对应 VS Code 命令；
    // 未命中 → 放行给 DSH 页面自身（不干涉页面自己的快捷键）。
    let bridgeShortcuts = {};

    // —— 快捷键转发去抖状态（防双发）——
    let lastForwardedCombo = "";
    let lastForwardedAt = 0;

    function hasShortcut(combo) {
      return (
        bridgeShortcuts !== null &&
        typeof bridgeShortcuts === "object" &&
        Object.prototype.hasOwnProperty.call(bridgeShortcuts, combo)
      );
    }

    // 桥接包版本（与插件版本统一，随包发布；安装器按「版本不一致或 client.js 内容不一致」强制重装）
    const BRIDGE_VERSION = "0.3.26";

    // —— 剪贴板写桥接：VS Code webview 对跨源 iframe 的 navigator.clipboard.writeText 有权限拦截 ——
    // 背景：即使 iframe 声明 allow="clipboard-write"，VS Code（Electron）仍会拒绝写入
    // （microsoft/vscode#182642），DSH 的 execCommand('copy') 回退在内嵌场景也不可靠。
    // 因此握手成功后接管 writeText：文本经父页面转发给扩展宿主，由 vscode.env.clipboard 写系统剪贴板。
    let copyRequestSeq = 0;
    const copyPending = new Map();

    function copyViaBridge(text) {
      return new Promise((resolve, reject) => {
        const requestId = "copy-" + (++copyRequestSeq) + "-" + Date.now();
        const timer = setTimeout(() => {
          copyPending.delete(requestId);
          reject(new Error("dsh-vscode-bridge copyText timeout"));
        }, 5000);
        copyPending.set(requestId, {
          resolve: (ok) => {
            clearTimeout(timer);
            if (ok) resolve(); else reject(new Error("dsh-vscode-bridge copyText failed"));
          },
        });
        parent.postMessage(buildCopyTextMessage(text, requestId), "*");
      });
    }

    function installClipboardBridge() {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") return;
      const originalWriteText = clipboard.writeText.bind(clipboard);
      const bridgedWriteText = function (text) {
        // 未握手（普通浏览器 / 桥接禁用）走原生 API；已握手走扩展宿主，绕开 VS Code 权限拦截。
        if (bridgeToken === "") return originalWriteText(text);
        return copyViaBridge(String(text));
      };
      // 先 defineProperty（可覆盖 configurable 的实例自有属性），失败再退化为直接赋值。
      try {
        Object.defineProperty(clipboard, "writeText", { configurable: true, writable: true, value: bridgedWriteText });
      } catch {
        try {
          clipboard.writeText = bridgedWriteText;
        } catch {
          // 剪贴板对象完全不可改写时放弃接管：DSH 仍会走原生 API 与其 execCommand 回退。
        }
      }
    }
    installClipboardBridge();

    // —— 剪贴板读桥接：供 Cmd+V 粘贴兜底 ——
    // VS Code 对 iframe 内的 execCommand('paste') 不一定放行，因此扩展宿主直接读系统剪贴板
    // （vscode.env.clipboard.readText 无 webview 权限限制），把文本回传后插入焦点可编辑元素。
    let readRequestSeq = 0;
    const readPending = new Map();

    function readViaBridge() {
      return new Promise((resolve, reject) => {
        const requestId = "read-" + (++readRequestSeq) + "-" + Date.now();
        const timer = setTimeout(() => {
          readPending.delete(requestId);
          reject(new Error("dsh-vscode-bridge readText timeout"));
        }, 5000);
        readPending.set(requestId, {
          resolve: (ok, text) => {
            clearTimeout(timer);
            if (ok) resolve(text); else reject(new Error("dsh-vscode-bridge readText failed"));
          },
        });
        parent.postMessage(buildReadTextMessage(requestId), "*");
      });
    }

    // —— 标准编辑命令仿真（修复 VS Code 吞掉 iframe 内 Cmd+C/V/A/X/Z 的问题） ——
    // 原理：VS Code 只在顶层 webview 转发快捷键（setIgnoreMenuShortcuts + 命令回投），
    // 嵌套 iframe 收不到命令；但 iframe 内的 keydown 事件仍可达，于是这里捕获按键后
    // 自行调用 document.execCommand 模拟（Flutter DevTools 已在同类场景验证有效），
    // 失败时再用剪贴板桥接兜底，保证复制/粘贴在 macOS 上可用。

    // 读取当前选区文本（复制/剪切及右键菜单可用性判断用）。
    // 注意：Chromium 中 textarea/input 聚焦时的选区不体现在 window.getSelection()，
    // 因此除文档选区外，还要读聚焦可编辑元素内的选区，避免复制兜底/菜单置灰失效。
    function readSelectionText() {
      let text = "";
      try {
        const sel = window.getSelection();
        text = sel && sel.rangeCount ? sel.toString() : "";
      } catch {
        text = "";
      }
      if (text) return text;
      // 文档选区为空：尝试从聚焦的 textarea/input 读其内部选区
      try {
        const el = focusedEditable();
        if (el && typeof el.value === "string" && typeof el.selectionStart === "number") {
          text = el.value.slice(el.selectionStart, el.selectionEnd);
        }
      } catch {
        text = "";
      }
      return text;
    }

    // 执行页面级编辑命令；成功返回 true，失败（不支持/被拒）返回 false
    function tryExecCommand(cmd) {
      try {
        return document.execCommand(cmd);
      } catch {
        return false;
      }
    }

    // 当前焦点是否在可编辑元素（textarea / 可输入 input / contenteditable）
    function focusedEditable() {
      const el = document.activeElement;
      return isEditableElement(el) ? el : null;
    }

    // 用原生 setter 写入可编辑元素的值并触发 input 事件（兼容 React 受控组件，
    // 直接赋值 el.value 不会让 React onChange 感知状态变化）
    function writeEditableValue(el, value) {
      const proto =
        el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : el.tagName === "INPUT"
            ? HTMLInputElement.prototype
            : null;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      // 通知 React/原生监听器：input 事件会携带新值触发 onChange
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 把文本插入焦点可编辑元素（粘贴/剪切的兜底写入路径）
    function insertTextIntoFocused(el, text) {
      // contenteditable 用 execCommand 插入，自动处理光标/撤销栈
      if (isEditableElement(el) && el.isContentEditable) {
        try {
          document.execCommand("insertText", false, text);
          return true;
        } catch {
          return false;
        }
      }
      // textarea / input：手动替换选区并触发 input 事件
      try {
        const next = computeInsertedValue(el.value, el.selectionStart, el.selectionEnd, text);
        writeEditableValue(el, next);
        const pos = (el.selectionStart ?? 0) + text.length;
        try {
          el.setSelectionRange(pos, pos);
        } catch {
          // 非文本型元素可能不支持 setSelectionRange，忽略
        }
        return true;
      } catch {
        return false;
      }
    }

    // —— 撤销/重做（Cmd/Ctrl+Z、Cmd+Shift+Z / Ctrl+Y） ——
    // 原则：撤销/重做一律交给「页面自身」处理，桥接绝不本地模拟。
    // 背景：DSH 输入框（React 受控 textarea）自带 draft 事务级撤销系统（keydown 里
    // Cmd/Ctrl+Z/Y → keyboard.undo()/redo()），且浏览器对普通可编辑元素有原生撤销。
    // 桥接若在捕获阶段拦截 Cmd+Z 会遮蔽页面自身的撤销（此前 issue #6 的手动快照栈
    // 方案即因此失效：事件根本到不了 DSH 的 keydown 处理器）。因此：
    //  - 快捷键 Cmd/Ctrl+Z / Cmd+Shift+Z / Ctrl+Y：放行原事件（不 preventDefault）；
    //  - 右键菜单「撤销/重做」：向「右键瞬间的焦点可编辑元素」派发合成 Cmd/Ctrl+Z
    //    （重做带 Shift），由页面（DSH keyboard.undo/redo 或浏览器原生）执行。合成事件
    //    （untrusted）不会触发浏览器默认动作，不会造成双重撤销。
    // 注意：点击菜单按钮会抢走焦点（mousedown 聚焦），此时 document.activeElement 已
    // 不是输入框——因此必须在弹出菜单时记录当时的编辑焦点（menuContextEditable），
    // 派发仍以它为 target（合成 keydown 从输入框冒泡到 React root，触发其 onKeyDown）。
    let menuContextEditable = null; // 右键弹出菜单瞬间的焦点可编辑元素（撤销/重做派发目标）

    function dispatchUndoKey(redo) {
      // 优先「右键瞬间的编辑焦点」（点击菜单按钮后焦点已被按钮抢走）；
      // 元素已脱离文档或从未记录时，回退当前焦点可编辑元素
      const el =
        menuContextEditable !== null && menuContextEditable.isConnected !== false
          ? menuContextEditable
          : focusedEditable() || null;
      if (el !== null && typeof el.focus === "function") {
        try { el.focus(); } catch { /* 焦点失败不阻塞后续派发 */ }
      }
      const target = el !== null ? el : document.activeElement || null;
      if (target === null || typeof target.dispatchEvent !== "function") {
        tryExecCommand(redo ? "redo" : "undo"); // 无派发目标：execCommand 最后兜底
        return;
      }
      try {
        const init = {
          key: "z", code: "KeyZ", bubbles: true, cancelable: true,
          metaKey: true, ctrlKey: true, shiftKey: redo === true,
        };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
      } catch {
        // 极老环境无 KeyboardEvent 构造：execCommand 兜底
        tryExecCommand(redo ? "redo" : "undo");
      }
    }

    // 执行一条被仿真的编辑命令（异步，粘贴/复制兜底需要桥接往返）
    async function handleEditCommand(cmd) {
      switch (cmd) {
        case "copy": {
          // 优先 execCommand（立即且不移动选区）；失败则把选区文本经桥接写入系统剪贴板
          if (tryExecCommand("copy")) return;
          const text = readSelectionText();
          if (!text) return;
          try {
            await copyViaBridge(text);
          } catch {
            // 写剪贴板失败：静默放弃（与没有选区时按 Cmd+C 行为一致）
          }
          break;
        }
        case "cut": {
          if (tryExecCommand("cut")) return;
          const el = focusedEditable();
          if (!el) return;
          const text = readSelectionText();
          // 剪贴板内容取 textarea 选区（readSelectionText 的 window.getSelection 在
          // 输入框内可能读不到），因此优先直接从元素选区读值
          const elText =
            typeof el.value === "string" && typeof el.selectionStart === "number"
              ? el.value.slice(el.selectionStart, el.selectionEnd)
              : text;
          if (!elText) return;
          try {
            await copyViaBridge(elText);
          } catch {
            return;
          }
          // 删除选区并同步 React 状态
          insertTextIntoFocused(el, "");
          break;
        }
        case "paste": {
          // 优先 execCommand('paste')：成功后浏览器会自行派发 paste 事件，
          // DSH 的输入控件（含富文本/代码编辑器）能按原生逻辑处理
          if (tryExecCommand("paste")) return;
          // 兜底：经桥接读取系统剪贴板，手动写入焦点可编辑元素
          const el = focusedEditable();
          if (!el) return;
          let text = null;
          try {
            text = await readViaBridge();
          } catch {
            return;
          }
          if (typeof text !== "string" || text === "") return;
          insertTextIntoFocused(el, text);
          break;
        }
        case "selectAll":
          tryExecCommand("selectAll");
          break;
        case "undo":
        case "redo":
          // 撤销/重做：不本地模拟（React 受控输入的原生撤销栈为空、快照栈会遮蔽
          // DSH 自带撤销），交给页面自身执行——向焦点可编辑元素派发合成组合键
          dispatchUndoKey(cmd === "redo");
          break;
      }
    }

    // —— 自定义右键菜单（VS Code 不向 iframe 上层弹原生菜单，此处自绘） ——
    // 菜单样式采用中性深色（带阴影与圆角），在浅/深色主题下都清晰可辨。
    const MENU_CSS =
      "#dsh-bridge-menu{position:fixed;z-index:2147483647;min-width:160px;margin:0;padding:4px;" +
      "background:#2d2d30;color:#cccccc;border:1px solid #454545;border-radius:6px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.35);font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "user-select:none;display:none;}" +
      "#dsh-bridge-menu button{display:block;width:100%;text-align:left;padding:5px 10px;" +
      "background:transparent;border:none;color:inherit;font:inherit;border-radius:4px;cursor:pointer;}" +
      "#dsh-bridge-menu button:hover:not(:disabled){background:#094771;color:#fff;}" +
      "#dsh-bridge-menu button:disabled{opacity:.38;cursor:default;}" +
      "#dsh-bridge-menu .dsh-bridge-sep{height:1px;background:#454545;margin:4px 8px;}" +
      "#dsh-bridge-menu .dsh-bridge-ok{color:#89d185;}" +
      "#dsh-bridge-menu button:focus{outline:none;}";
    let menuEl = null;
    let menuCopyBtn = null;
    let menuPasteBtn = null;
    let menuCutBtn = null;
    let menuUndoBtn = null;
    let menuRedoBtn = null;

    // 按当前焦点/选区状态刷新菜单项的可用性
    function updateMenuEnabled() {
      const editable = focusedEditable();
      const hasSelection = readSelectionText() !== "";
      menuCopyBtn.disabled = !hasSelection;
      menuCutBtn.disabled = !(editable && hasSelection);
      menuPasteBtn.disabled = !editable;
      menuUndoBtn.disabled = !editable;
      menuRedoBtn.disabled = !editable;
    }

    // 菜单项点击统一入口：隐藏菜单后执行对应编辑命令
    function menuAction(cmd) {
      hideMenu();
      void handleEditCommand(cmd);
    }

    // 懒创建菜单 DOM（首次右键时注入样式与按钮）
    function ensureMenu() {
      if (menuEl) return menuEl;
      const style = document.createElement("style");
      style.textContent = MENU_CSS;
      document.head.append(style);
      menuEl = document.createElement("div");
      menuEl.id = "dsh-bridge-menu";
      menuEl.setAttribute("role", "menu");
      const mkBtn = (label, cmd) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.setAttribute("role", "menuitem");
        b.addEventListener("click", () => menuAction(cmd));
        return b;
      };
      const sep = () => {
        const s = document.createElement("div");
        s.className = "dsh-bridge-sep";
        return s;
      };
      // 复制/粘贴/剪切/全选 + 撤销/重做（顺序与系统菜单惯例一致）
      menuCopyBtn = mkBtn("复制", "copy");
      menuPasteBtn = mkBtn("粘贴", "paste");
      menuCutBtn = mkBtn("剪切", "cut");
      const menuSelectAllBtn = mkBtn("全选", "selectAll");
      menuUndoBtn = mkBtn("撤销", "undo");
      menuRedoBtn = mkBtn("重做", "redo");
      menuEl.append(menuCopyBtn, menuPasteBtn, menuCutBtn, menuSelectAllBtn, sep(), menuUndoBtn, menuRedoBtn);
      document.body.append(menuEl);
      // 菜单自身点击不冒泡到"关闭菜单"的全局监听
      menuEl.addEventListener("pointerdown", (e) => e.stopPropagation());
      return menuEl;
    }

    // 在指定视口坐标显示菜单（自动翻转避免溢出窗口）
    function showMenuAt(x, y) {
      const menu = ensureMenu();
      // 记录右键瞬间的焦点可编辑元素：菜单按钮点击（mousedown 聚焦）会抢走焦点，
      // 撤销/重做派发必须回到「右键时正在编辑的元素」才能到达 DSH 的 keydown 处理器
      menuContextEditable = focusedEditable();
      updateMenuEnabled();
      menu.style.display = "block";
      const rect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x;
      let top = y;
      if (left + rect.width > vw - 4) left = Math.max(4, vw - rect.width - 4);
      if (top + rect.height > vh - 4) top = Math.max(4, top - rect.height - 8);
      menu.style.left = left + "px";
      menu.style.top = top + "px";
    }

    // 隐藏自定义右键菜单
    function hideMenu() {
      if (menuEl) menuEl.style.display = "none";
    }

    // —— DOM 拦截：外链与文件路径点击 → postMessage 转发给父页面（扩展） ——
    // 读属性一律防御式：元素缺方法/属性时当作空串，不抛异常、不误拦其它点击。
    const readAttr = (el, name) => {
      try { return typeof el.getAttribute === "function" ? el.getAttribute(name) || "" : ""; } catch { return ""; }
    };
    function bindLinkInterception() {
      document.addEventListener("click", (e) => {
        if (bridgeToken === "") return; // 未握手（普通浏览器打开）不激活
        const target = e.target;
        if (!target || typeof target.closest !== "function") return;
        // 外链：DSH 前端渲染为 <a target="_blank">，白名单校验后转发系统浏览器打开
        const anchor = target.closest("a");
        if (anchor && isAllowedExternalUrl(anchor.href)) {
          e.preventDefault();
          e.stopPropagation();
          parent.postMessage(buildOpenExternalMessage(anchor.href), "*");
          return;
        }
        // —— DSH 原生同款防误触守卫（dsh-client-ui-primitives/lib/index.js:5883）——
        // 原生 onClick 首行即 `if (event.detail > 1 || (event.detail !== 0 && getSelection()?.isCollapsed === false)) return;`
        // ——双击/多击、以及「文档里存在未折叠选区时的单击」都不打开文件。桥接在捕获阶段
        // 先于 DOM onClick 执行，若不照抄该守卫，反而会比原生更容易误打开文件（拖选误触）。
        // 命中守卫时直接放行：不 preventDefault、不 stopPropagation，由原生走它的「直接 return」。
        if (isDuplicateOrSelectionClick(e, typeof document.getSelection === "function" ? document.getSelection() : null)) return;
        // —— DSH「改动」卡片（[data-changed-files]）里的文件行 ——
        // 该行点击**不发任何 RPC/HTTP**：onClick: openReview(index) → openChangesReview →
        // ctx.sidebarRight.openResource("dsh-resource://changes-review/…") → placeResource 只改前端 store
        // （diff 内容等侧栏 tab 挂载后才 GET），传输层无从接管，只能在捕获阶段拦。
        // 用户需求：不要求开真 diff，解析出路径用编辑器打开该文件即可 → 复用 bridgeOpenFile 消息（宿主侧零改动）。
        const changedRow = target.closest("[data-changed-files] button");
        if (changedRow) {
          const describedBy = readAttr(changedRow, "aria-describedby");
          // React useId 生成的 id 形如 ":r5q:-0"，含冒号，不能直接当 CSS 选择器 → 必须用 getElementById
          let describedPath = "";
          if (describedBy !== "" && typeof document.getElementById === "function") {
            const descEl = document.getElementById(describedBy);
            if (descEl) describedPath = descEl.textContent || "";
          }
          const firstSpan = typeof changedRow.querySelector === "function" ? changedRow.querySelector("span") : null;
          const path = resolveChangedRowClick({
            inChangedCard: true,
            describedBy,
            describedPath,
            rowText: firstSpan ? firstSpan.textContent || "" : "",
          });
          if (path !== "") {
            e.preventDefault();
            e.stopPropagation();
            parent.postMessage(buildOpenFileMessage(path), "*");
            return;
          }
        }
        // 文件路径点击：DSH 各版本的「打开文件」入口（模型回复内路径 fileMention、@文件
        // 引用芯片、产物文件卡片、工具调用行 fileLink）都统一在这里接管。
        // 识别不写死在本文件：DOM 形态随 DSH 改版反复变化（0.1.7 起类名被 CSS Modules
        // 哈希成 `_fileMention_1jct6_85`、卡片改为 data-* 标记），故由 core.js 的
        // resolveFileClickPath 按「类名子串 + data-ref-chip + 路径形态」判定，纯逻辑可单测。
        let fileBtn = target.closest("button");
        // 产物卡片（[data-presented-file]）的可点区域是覆盖整卡的 button；
        // 若 DSH 后续把 pointer-events 挪到子节点上，点这里回退到卡内带 title 的按钮。
        if (!fileBtn) {
          const card = target.closest("[data-presented-file]");
          fileBtn = card && typeof card.querySelector === "function" ? card.querySelector("button[title]") : null;
        }
        if (fileBtn) {
          const path = resolveFileClickPath({
            className: readAttr(fileBtn, "class"),
            title: readAttr(fileBtn, "title"),
            text: fileBtn.textContent || "",
            refChip: readAttr(fileBtn, "data-ref-chip"),
          });
          if (path !== "") {
            e.preventDefault();
            e.stopPropagation();
            // openFile 消息只发 path；不带 cwd（工作区同步已移除，会话 cwd 不再维护），
            // 相对路径由扩展侧以工作区根目录解析兜底。
            parent.postMessage(buildOpenFileMessage(path), "*");
            return;
          }
        }
        // 工具调用行（DSH ToolCall）：容器带 data-tool 属性，文件链接按钮（无 title/aria-label）
        // 文本形如「read · <路径>」或直接「<路径>」（相对会话 cwd 或 ~ 缩写），点击后由 DSH 打开该文件。
        // 转发扩展宿主在当前窗口打开。
        // 识别分两层：
        //  ① 文本路径形态（extractToolLinkPath：去「工具名 · 」前缀、要求含路径分隔符）——
        //     覆盖子目录/绝对/~ 路径（read 行通常命中）；
        //  ② 折叠行结构（按钮位于 [data-disclosure-row] 行内）——覆盖相对化后只剩 basename
        //     的根目录文件（edit/write 行，如「Edit · README.md」文本无分隔符）。
        //     ToolRow 用 expandOnRowClick 时 chevron 渲染为 span，行内按钮只有 fileLink；
        //     展开区（bodyWrap）的 inspect/复制等按钮在行外，天然被排除。
        const toolRow = target.closest("[data-tool]");
        if (toolRow && target.closest("button")) {
          const btn = target.closest("button");
          const text = (btn.textContent || "").trim();
          const path = extractToolLinkPath(text);
          const inFoldRow = text !== "" && btn.closest("[data-disclosure-row]") !== null;
          if (path !== "" || inFoldRow) {
            e.preventDefault();
            e.stopPropagation();
            parent.postMessage(buildOpenFileMessage(path !== "" ? path : text), "*");
            return;
          }
        }
      }, true); // 捕获阶段：先于 DSH 自身处理器
    }

    // —— keydown 拦截：标准编辑快捷键本地仿真 + 桥接快捷键转发（VS Code 吞掉 iframe 内快捷键的修复） ——
    function onKeyDown(e) {
      // 无修饰键的 Esc 仅用于收起自定义右键菜单，任何状态下都响应；
      // 不 preventDefault：把 Esc 继续交给 DSH 页面自身处理（如关闭弹窗）。
      // 注意：Cmd+Esc 等带修饰键的 Esc 不在此列（v0.3.2 起可经快捷键映射转发给扩展宿主）。
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        hideMenu();
        return;
      }
      if (bridgeToken === "") return; // 未握手（普通浏览器）不干涉原生行为
      // ① 标准编辑命令（Cmd/Ctrl+C/V/A/X/Z、Shift+Insert）：本地仿真（execCommand + 剪贴板桥接兜底）
      const cmd = getShortcutCommand(e);
      if (cmd) {
        // 撤销/重做（Cmd/Ctrl+Z、Cmd+Shift+Z）：放行给页面自身处理——
        // DSH 输入框自带 draft 事务级撤销系统（keydown 里 z/y → keyboard.undo/redo），
        // 拦截会遮蔽它（曾导致 Cmd+Z 无效）；其它可编辑元素由浏览器原生撤销处理。
        if (cmd === "undo" || cmd === "redo") {
          hideMenu();
          return; // 不 preventDefault / 不 stopPropagation
        }
        // 捕获阶段拦截：阻止事件继续传播，避免 DSH 自身处理器或 VS Code 二次处理产生冲突
        e.preventDefault();
        e.stopPropagation();
        hideMenu();
        void handleEditCommand(cmd);
        return;
      }
      // ② 桥接快捷键映射（dsh.bridge.shortcuts）：命中 → 转发扩展宿主执行对应 VS Code 命令。
      //    自动重复（按住不放）不转发，避免 toggle 类命令来回横跳；未命中的组合放行给页面。
      const combo = getShortcutCombo(e);
      if (combo !== null && e.repeat !== true && hasShortcut(combo)) {
        // 防双发：同一组合键 300ms 内再次出现（监听器叠加导致同一事件被处理两次，
        // 或 OS 重复键竞态）只转发一次；preventDefault 保持一致（事件已被接管）。
        const now = Date.now();
        if (combo === lastForwardedCombo && now - lastForwardedAt < 300) {
          e.preventDefault();
          e.stopPropagation();
          console.warn(`[dsh-vscode-bridge] shortcut ${combo} 300ms 内重复触发，已忽略（防双发）`);
          return;
        }
        lastForwardedCombo = combo;
        lastForwardedAt = now;
        e.preventDefault();
        e.stopPropagation();
        hideMenu();
        parent.postMessage(buildShortcutMessage(combo, e.key || "", e.code || ""), "*");
      }
    }

    // —— contextmenu 拦截：弹出自定义右键菜单（VS Code 不向 iframe 弹原生菜单） ——
    function onContextMenu(e) {
      if (bridgeToken === "") return; // 未握手（普通浏览器）保留原生右键菜单
      e.preventDefault();
      e.stopPropagation();
      showMenuAt(e.clientX, e.clientY);
    }

    // —— 接收父页面消息：握手 + 剪贴板回执 ——
    function onParentMessage(e) {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      // 握手：父页面下发 { kind: 'bridgeHello', token }，校验非空后回执 bridgeAck
      if (d.kind === "bridgeHello" && typeof d.token === "string" && d.token !== "") {
        bridgeToken = d.token;
        imageFallbackEnabled = d.imageFallback === true; // v0.3.0：非视觉模型图片降级开关（随 hello 下发）
        // v0.3.2：快捷键桥接映射随 hello 下发（{ 组合键: 命令 id }），决定 keydown 拦截哪些组合键
        if (d.shortcuts && typeof d.shortcuts === "object") bridgeShortcuts = d.shortcuts;
        // 诊断日志：页面可据此确认握手成功与降级开关状态（排查“图片上传不生效”用）
        console.log("[dsh-vscode-bridge] handshake ok, v" + BRIDGE_VERSION + ", imageFallback=" + imageFallbackEnabled + ", shortcuts=" + Object.keys(bridgeShortcuts).length);
        // 附件图片捕获已由工厂期常驻绑定（bindImageCapture），此处仅刷新开关即可生效
        // 回执统一用 core.js 的 buildSyncWorkspaceAck 构造，形状与工作区同步回执一致
        // （{ kind: 'bridgeAck', ok }，不带 token 字段）；顶层 webview 靠 origin + source
        // 校验消息来源，按 { kind: 'bridgeAck', ok } 解析，避免同 kind 两种形状。
        // 回执携带桥接版本：扩展侧日志据此直接确认页面里跑的是哪个版本的桥接代码
        parent.postMessage(buildSyncWorkspaceAck(true, undefined, BRIDGE_VERSION), "*");
        return;
      }
      // 剪贴板写回执：resolve / reject 对应的 writeText Promise
      if (d.kind === "copyTextAck" && typeof d.requestId === "string" && typeof d.ok === "boolean") {
        const pending = copyPending.get(d.requestId);
        if (pending) {
          copyPending.delete(d.requestId);
          pending.resolve(d.ok);
        }
        return;
      }
      // 剪贴板读回执：resolve / reject 对应的 readText Promise
      if (d.kind === "readTextAck" && typeof d.requestId === "string" && typeof d.ok === "boolean") {
        const pending = readPending.get(d.requestId);
        if (pending) {
          readPending.delete(d.requestId);
          pending.resolve(d.ok, d.ok && typeof d.text === "string" ? d.text : "");
        }
        return;
      }
      // 工作区同步：握手成功后父页面下发 workspaceId(+path)，存入供 session.create 使用；并尝试在界面里切到该工作区
      if (d.kind === "bridgeSyncWorkspace" && typeof d.workspaceId === "string" && d.workspaceId !== "") {
        bridgeWorkspaceId = d.workspaceId;
        bridgeWorkspacePath = typeof d.workspacePath === "string" ? d.workspacePath : "";
        console.log("[dsh-vscode-bridge] bridgeSyncWorkspace received @ " + Date.now() + " id=" + bridgeWorkspaceId + " path=" + bridgeWorkspacePath);
        activateWorkspaceInUi();
        return;
      }
    }


    // —— v0.3.0 图片自由上传：捕获图片字节 + 发送被拒(模型无视觉)自动降级为路径转发 ——
    // 全程仅在该标识为 true（父页面握手时随 bridgeHello 下发 dsh.image.fallback=true）时生效；
    // 未握手或降级关闭时，本段落不改变任何原生行为（与 v0.2.4 保持一致）。
    let imageFallbackEnabled = false; // 是否允许非视觉模型图片降级
    const imageCache = new Map(); // key(imageCacheKey) -> { name, b64, mime }（当前待用的捕获，用后即消费移除）
    let fallbackResendInFlight = false; // 幂等：一个被拒只触发一次重发
    let lastSeenSessionId = ""; // 最近一次对话(session) id，用于会话切换时判定上一对话终止
    let imgNameSeq = 0; // 图片文件名全局递增序号：保证同一毫秒内落盘的多批图片也不重名（防覆盖）

    // —— 临时图片「模型看完即删」生命周期 ——
    // 模型在回合内通过图像工具按路径读取文件，文件必须存活到读取完成。因此每条消息的
    // 临时图按「批次」管理：① 同会话发出下一条消息时立即删除（模型已读完上一条并给出回答）；
    // ② 若不再发消息，TTL（默认 45 秒，测试可经 window.__dshBridgeImageTtlMs 覆盖）兜底自动删——
    //    模型回合内通常数秒即完成图片读取，45 秒既覆盖读取又贴近"看完即删"；
    // ③ 会话新建/删除/切换、页面卸载、扩展停用、手动命令等既有触发全部保留。
    const IMAGE_TTL_MS =
      typeof window.__dshBridgeImageTtlMs === "number" && window.__dshBridgeImageTtlMs > 0
        ? window.__dshBridgeImageTtlMs
        : 45000;
    const pendingBatches = []; // { paths: string[], timer }：已落盘、尚未删除的临时图批次

    // 删除一个批次：从待删表移除（幂等）、清定时器、向扩展宿主发 deleteImages 并从落盘表摘除
    function deleteBatch(batch) {
      const idx = pendingBatches.indexOf(batch);
      if (idx < 0) return;
      pendingBatches.splice(idx, 1);
      if (batch.timer) { clearTimeout(batch.timer); batch.timer = null; }
      if (batch.paths.length === 0) return;
      parent.postMessage(buildDeleteImagesRequest("imgused-" + Date.now(), batch.paths), "*");
      console.log("[dsh-vscode-bridge] image fallback: 临时图片已用完，删除 " + batch.paths.length + " 张: " + batch.paths.join(", "));
    }

    // 立即删除全部待删批次（下一条消息/会话结束/页面卸载等场景）
    function flushAllBatches(reason) {
      if (pendingBatches.length === 0) return;
      const count = pendingBatches.reduce((n, b) => n + b.paths.length, 0);
      for (const batch of [...pendingBatches]) deleteBatch(batch);
      console.log("[dsh-vscode-bridge] image fallback: " + reason + "，立即删除已用完的临时图片 " + count + " 张");
    }

    // 对话终止（新建/删除/切换会话）→ 立即删除已落盘临时图片并清偿缓存。
    // clearCaptures=true 仅用于明确的「新建/删除会话」：此刻尚未进入新会话的输入，
    // 缓存的旧字节不会再被使用；会话切换(仅 prompt 观测)不清 imageCache，
    // 避免误删当前消息刚捕获、正要用于降级的图片。
    function handleConversationEnd(reason, clearCaptures) {
      flushAllBatches("会话" + reason);
      if (clearCaptures && imageCache.size > 0) imageCache.clear();
    }

    // 字节数组 → base64（页面内 btoa 可用；仅用于桥接通道传输，不影响 DSH 原生附件）
    function bytesToBase64(bytes) {
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }

    // 附件捕获入口：图片类型 + 有指纹 + 未缓存，才把字节缓存起来
    function captureImageFile(file) {
      if (!imageFallbackEnabled) return; // 降级关闭不捕获
      if (!file || typeof file.arrayBuffer !== "function") return;
      if (typeof file.type !== "string" || !file.type.toLowerCase().startsWith("image/")) return;
      const key = imageCacheKey(file);
      if (!key || imageCache.has(key)) return; // 同指纹去重
      file.arrayBuffer()
        .then((buf) => { if (imageCache.has(key)) return; imageCache.set(key, { name: file.name, b64: bytesToBase64(new Uint8Array(buf)), mime: file.type }); })
        .catch(() => {});
    }

    // DOM 附件捕获：change(文件选择)/drop(拖拽)/paste(粘贴) 三路，捕获阶段先于 DSH 处理器
    // 注：本函数在握手成功时由 hello 分支调用（绑定一次即常驻，内部用开关过滤）
    function bindImageCapture() {
      if (bindImageCapture.bound) return; bindImageCapture.bound = true;
      document.addEventListener("change", (e) => {
        const t = e.target;
        if (t && t.files) { for (const f of Array.from(t.files)) captureImageFile(f); }
      }, true);
      document.addEventListener("drop", (e) => {
        if (e.dataTransfer && e.dataTransfer.files) { for (const f of Array.from(e.dataTransfer.files)) captureImageFile(f); }
      }, true);
      document.addEventListener("paste", (e) => {
        if (e.clipboardData && e.clipboardData.items) {
          for (const it of Array.from(e.clipboardData.items)) {
            if (it.kind === "file") { const f = it.getAsFile(); if (f) captureImageFile(f); }
          }
        }
      }, true);
    }

    // 经桥接把一张图片落盘到扩展宿主侧（工作区根），成功返回绝对路径，失败/超时返回 null
    function saveImageViaBridge(b64, name, requestId) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 5000);
        function onAck(e) {
          const parsed = parseSaveImageAck(e.data, requestId);
          if (!parsed) return;
          clearTimeout(timer);
          window.removeEventListener("message", onAck);
          resolve(parsed.ok && parsed.path ? parsed.path : null);
        }
        window.addEventListener("message", onAck);
        parent.postMessage(buildSaveImageRequest(requestId, name, b64, undefined), "*");
      });
    }

    // 图片被拒后：只把「本条消息实际包含的图片」（按消息顺序）落盘并组装
    // 「原文 + 图片一/二…：路径」内容 → 以新 rpcId 重发 → 用后从缓存消费移除。
    // 返回重发响应（调用方据此认为发送成功，DSH 不再弹"不支持图像输入"报错）；
    // 任何一步失败或无法落盘时返回 null（调用方回退原生被拒响应，绝不吞用户消息）。
    async function handlePromptImageRejected(parsed, url, init, origFetch) {
      try {
        const payload = unwrapRpcPayload(parsed);
        // 按消息内的顺序把图片块映射到已捕获缓存（匹配 name/data），只取本条消息实际用到的图片
        const used = matchCapturedImages(payload.content,
          Array.from(imageCache.entries()).map(([key, v]) => ({ key, ...v })));
        const pointerLines = [];
        const savedPaths = [];
        for (let i = 0; i < used.length; i++) {
          const entry = used[i];
          const ext = "." + (entry.mime ? entry.mime.split("/")[1].toLowerCase() : "png");
          const name = imageCacheFilename(String(Date.now()) + "-" + (imgNameSeq++), i, ext);
          if (!name) continue; // 扩展名不在白名单：跳过该张
          const p = await saveImageViaBridge(entry.b64, name, "img-" + Date.now() + "-" + i);
          if (p) { savedPaths.push(p); pointerLines.push(buildImagePointerLine(p, i + 1)); }
        }
        if (savedPaths.length === 0) {
          console.warn("[dsh-vscode-bridge] image fallback: 没有可落盘的图片缓存（未打开工作区?），保持原生报错");
          return null; // 无可用落盘：不作降级
        }
        // 消费：本条消息已用到的图片从缓存移除，避免后续消息继续重复引用
        for (const entry of used) {
          if (entry && typeof entry.key === "string") imageCache.delete(entry.key);
        }
        const content = buildTextOnlyContent(payload.content, pointerLines);
        const resendBody = buildTextResendRequest(parsed, content);
        // 重发时剥离原请求的 signal：避免复用可能已中止/中止中的 AbortSignal 导致重发被中途取消
        const { signal: _signal, ...initNoSignal } = init || {};
        const resp = await origFetch(url, { ...initNoSignal, body: JSON.stringify(resendBody) });
        // 登记本批临时图：模型在回合内读取；下一条消息发出时立即删除，TTL 兜底自动删
        const batch = { paths: savedPaths.slice(), timer: null };
        batch.timer = setTimeout(() => deleteBatch(batch), IMAGE_TTL_MS);
        pendingBatches.push(batch);
        console.log("[dsh-vscode-bridge] image fallback: 已把图片改为地址随消息重发（" + savedPaths.length + " 张）: " + savedPaths.join(", ") + "（模型读完后即删）");
        return resp;
      } catch (err) {
        // 降级全程失败：返回 null，由调用方回退原生被拒响应（绝不吞用户消息）
        console.error("[dsh-vscode-bridge] image fallback failed:", err);
        return null;
      } finally {
        fallbackResendInFlight = false;
      }
    }

    // 拦截 RPC 传输：① 宿主打开文件（统一接管）；② prompt RPC 的图片降级。
    // DSH 的 ApiClient.doFetch 即 globalThis.fetch，本包装是页面上所有 RPC 的必经之路。
    function interceptPromptFetch() {
      const origFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        // —— 前置拦截：DSH 请求宿主打开文件 ——
        // DOM 拦截之外的兜底网：无论 UI 元素形态怎么改版，只要 DSH 仍经 RPC 让宿主打开文件，
        // 就在这里接管——转发扩展宿主在当前窗口打开（showTextDocument），并伪造 server-response
        // 成功响应让 DSH 无感（rpcId 回显 + result.ok/opened:true）；后端不被调用 → 系统默认应用不弹出。
        // 端点与「哪些动作该放行」的判定在 core.js.extractOpenPathRequest（纯逻辑、可单测）：
        //   dsh 0.1.7+ 走 typert RPC，端点为 **斜杠** 形式 `session/openWorkspacePath`，
        //   参数在 `payload.args.request`（args 按参数 wire 名索引的普通对象，非位置数组）；
        //   旧版（≤0.1.0-rc.6）点号 `host.openPath` + `payload.path` 保留兼容。
        // 未握手（普通浏览器）不干涉。
        if (bridgeToken !== "" && init && init.method === "POST" && typeof init.body === "string" && init.body !== "") {
          try {
            const parsed = JSON.parse(init.body);
            const openPath = extractOpenPathRequest(parsed);
            if (openPath !== "") {
              parent.postMessage(buildOpenFileMessage(openPath), "*");
              console.log("[dsh-vscode-bridge] openPath 接管：转发扩展宿主打开 " + openPath);
              return new Response(JSON.stringify({
                type: "server-response",
                rpcId: typeof parsed.rpcId === "string" ? parsed.rpcId : "rpc-id",
                result: { ok: true, value: { opened: true } },
              }), { status: 200, headers: { "content-type": "application/json" } });
            }
          } catch { /* 非 JSON/形状不符：放行 */ }
        }
        // 工作区同步（必须在 origFetch 之前覆盖）：DSH 前端 session.create 总会带全局最近工作区的
        // workspaceId；多窗口共享同一 3080 时，须强制覆盖为本窗口工作区，否则新会话仍落旧工作区。
        if (init && init.method === "POST" && typeof init.body === "string" && init.body !== "" && init.body.indexOf('"session.create"') !== -1) {
          try {
            const origWs = (init.body.match(/"workspaceId":"[^"]*"/) || [null])[0];
            if (bridgeWorkspaceId !== "") {
              if (init.body.indexOf('"workspaceId"') !== -1) {
                init.body = init.body.replace(/"workspaceId":"[^"]*"/g, '"workspaceId":"' + bridgeWorkspaceId + '"');
              } else {
                const patchIdx = init.body.indexOf('"session.create"');
                const insertAfter = init.body.indexOf('"payload"', patchIdx);
                const bracePos = insertAfter !== -1 ? init.body.indexOf('{', insertAfter) : -1;
                if (bracePos !== -1) {
                  init.body = init.body.slice(0, bracePos + 1) + '"workspaceId":"' + bridgeWorkspaceId + '",' + init.body.slice(bracePos + 1);
                }
              }
            }
            console.log("[dsh-vscode-bridge] session.create @ " + Date.now() + " bridgeWs=" + (bridgeWorkspaceId || "none") + " ws=" + (origWs || "none"));
          } catch { /* 覆盖失败不阻断 session.create */ }
        }
        const res = await origFetch(input, init);
        try {
          if (!imageFallbackEnabled || bridgeToken === "") return res;
          if (!init || init.method !== "POST" || typeof init.body !== "string" || init.body === "") return res;
          const parsed = JSON.parse(init.body);
          // DSH 线格式：请求体为 { type, method, rpcId, payload }，业务 content 在 payload 下（payload 透传形态也兼容）
          const payload = unwrapRpcPayload(parsed);
          // —— 对话生命周期：新建/删除会话或 prompt 观测到会话 id 变更 → 上一对话终止，清理临时图片 ——
          const method = parsed && typeof parsed.method === "string" ? parsed.method : "";
          const sessionId = payload && typeof payload.sessionId === "string" ? payload.sessionId : "";
          if (method === "session.create") {
            handleConversationEnd("新建", true);
          }
          else if (method === "session.delete") handleConversationEnd("删除", true);
          else if (sessionId !== "" && lastSeenSessionId !== "" && sessionId !== lastSeenSessionId) {
            handleConversationEnd("切换", false); // 保留当前消息刚捕获的图片（不清 imageCache）
          }
          if (sessionId !== "") lastSeenSessionId = sessionId;
          // 同会话继续发送消息：上一条消息的临时图模型已读完并已回答，立即删除（TTL 无需等待）
          if (method === "session.prompt" && sessionId !== "") flushAllBatches("下一条消息");
          if (!payload || !Array.isArray(payload.content) || !isPromptWithImages(payload.content)) return res;
          const clone = res.clone();
          let respJson = null;
          try { respJson = await clone.json(); } catch {}
          if (!detectModelReject(respJson)) return res;
          console.log("[dsh-vscode-bridge] image fallback: 模型不支持图片，落盘并改为地址重发");
          if (fallbackResendInFlight) { console.log("[dsh-vscode-bridge] image fallback: 已有进行中的降级，保持原生响应"); return res; }
          // input 多为 URL 实例（.href）；resolveFetchUrl 兼容 string/URL/Request 三种
          const u = resolveFetchUrl(input);
          if (u === "") { console.warn("[dsh-vscode-bridge] image fallback: 无法解析请求 URL，保持原生报错"); return res; }
          fallbackResendInFlight = true;
          const patched = await handlePromptImageRejected(parsed, u, init, origFetch);
          if (!patched) return res; // 降级失败/无法落盘：回退原生被拒响应（不吞错误）
          // 用「原请求身份(rpcId)」把重发响应交回调用方：DSH 按发送成功处理
          console.log("[dsh-vscode-bridge] image fallback: 已用重发成功响应顶替被拒响应");
          return typeof parsed.rpcId === "string"
            ? await rewriteRpcId(patched, parsed.rpcId)
            : patched;
        } catch {}
        return res;
      };
    }

    // 页面卸载清理：删除本次已由本页落盘的缓存图片（避免长期占用工作区存储）
    function bindPageCleanup() {
      window.addEventListener("pagehide", () => {
        flushAllBatches("页面卸载");
      });
    }

    // —— 入口：立即可绑定的拦截先挂载；图片捕获在握手后才绑定 ——
    bindLinkInterception();
    bindImageCapture(); // 附件图片捕获常驻挂载（未握手/关闭时经 imageFallbackEnabled 过滤，零干扰）
    interceptPromptFetch(); // fetch 拦截常驻挂载（内部用开关过滤，未握手/关闭时零干扰）
    bindPageCleanup();
    window.addEventListener("message", onParentMessage);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    // 点击菜单外任意处／滚动／窗口失焦时收起自定义菜单
    document.addEventListener("pointerdown", (e) => {
      if (menuEl && !menuEl.contains(e.target)) hideMenu();
    }, true);
    window.addEventListener("blur", hideMenu);
    window.addEventListener("scroll", hideMenu, true);
    // cordis 插件约定：apply 挂载点（本桥接无需额外挂载，保留占位以符合插件契约）
    exports.apply = () => {};
    return module.exports;
  }
});