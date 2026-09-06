# DSH for VS Code 🐳

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/Fengze233.dsh-vscode-panel?label=Marketplace&color=4D6BFE)](https://marketplace.visualstudio.com/items?itemName=Fengze233.dsh-vscode-panel)
[![GitHub stars](https://img.shields.io/github/stars/Fengze233/dsh-vscode?style=social)](https://github.com/Fengze233/dsh-vscode)
[![DSH 社区插件](https://img.shields.io/badge/DSH%20Plugin-dsh--plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.91-blue)](https://code.visualstudio.com/)

**中文** | [English](README.md)

在 VS Code 中直接使用 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的网页界面：点击侧边栏图标即可内嵌打开 DSH，自动启动/复用 `dsh web` 服务，代码与 AI 界面同屏，无需再切换终端和浏览器。

## 📸 界面截图

![DSH for VS Code 界面截图](docs/screenshots/overview.png)

## 🎬 演示视频

[![如何在 VSCode 中使用 DeepSeek Harness？用 DSH！！（Bilibili）](docs/screenshots/video-cover.jpg)](https://www.bilibili.com/video/BV1p8bD6dE18)

*B 站 59 秒演示视频：[BV1p8bD6dE18](https://www.bilibili.com/video/BV1p8bD6dE18)*

---

## ✨ 特性

- 🖱️ **一键打开**：左侧活动栏有一个 DSH 鲸鱼图标，点击即在侧栏内嵌显示 DSH 网页；
- 🚀 **服务自动管理**：自动探测端口——已有 `dsh web` 直接复用，没有则后台静默启动，就绪后自动加载；
- 🔄 **状态实时同步**：状态栏四态指示（运行中绿 / 启动中黄 / 失败红 / 已停止灰），点击状态栏可开关面板；
- 🛟 **异常兜底**：端口被占、`dsh` 未安装、启动超时、服务崩溃/失联均有对应提示页与一键重连，绝不白屏；配置端口被其他程序占用时自动改用第一个空闲端口（仅本次会话临时生效）；
- 🌐 **双语界面**：文案跟随 VS Code 显示语言——中文环境显示中文，其余语言一律英文；
- 📋 **复制/粘贴/右键开箱即用**：修复 VS Code 内嵌环境下（尤其是 macOS）聊天内容无法 `Cmd+C` 复制、`Cmd+V` 粘贴、右键无菜单的问题——面板内置标准编辑快捷键仿真与右键菜单（复制/粘贴/剪切/全选/撤销/重做），普通浏览器打开与原有功能完全不受影响；
- 🧹 **退出清理**：关闭窗口自动停止插件自启的服务，不留僵尸进程；手动启动的服务永不干预；
- 🔒 **安全边界**：只连接回环地址（127.0.0.1 / localhost / [::1]），不读取凭据。
- 🌐 **SSH Remote 支持（可选）**：远程连接时可在远端运行 dsh，并经 VS Code 隧道在面板中打开（`dsh.remote.enabled`，默认关闭）；
- 🖼️ **对话框自由上传图片**：模型无视觉能力也能发送图片——图片缓存到工作区并以文件路径引用随消息发出，让模型调用图像工具查看（面板关闭时清理；可用 `dsh.image.fallback` 关闭）；
- 🪟 **不再误弹浏览器**：启动 `dsh web` 默认追加 `--no-open`（需弹浏览器时用 `dsh.openInBrowser` 恢复）。

## 📥 安装

**方式一：商店安装（推荐）**

VS Code 扩展面板搜索 `DSH`（发布者 Fengze233），或命令行执行：

```bash
code --install-extension Fengze233.dsh-vscode-panel
```

商店页面：<https://marketplace.visualstudio.com/items?itemName=Fengze233.dsh-vscode-panel>

**方式二：下载 .vsix 安装包**

1. 前往 [Releases](https://github.com/Fengze233/dsh-vscode/releases) 下载最新 `dsh-vscode.vsix`；
2. VS Code 中按 `Ctrl+Shift+P` → 执行 `Extensions: Install from VSIX...` → 选择下载的文件；
3. 重载窗口（`Developer: Reload Window`）。

**方式三：从源码构建**

```bash
git clone https://github.com/Fengze233/dsh-vscode.git
cd dsh-vscode
npm install
npm run package        # 产出 dsh-vscode.vsix，再按方式二安装
```

**前置要求**：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh` 命令并位于 PATH 中（插件会自动检测；未安装时会给出提示）。

## 🚀 使用

1. 安装后，**左侧活动栏**出现一个 DSH 鲸鱼图标；
2. 点击该图标：插件自动启动（或复用）`dsh web`，并在侧边栏内嵌显示 DSH 网页；
   - 若 `dsh.port` 被其他程序占用，插件会自动改用第一个空闲端口（仅本次会话临时生效，设置不变，弹窗告知临时端口）；
3. 面板标题栏按钮：`在浏览器中打开` `重启服务` `停止服务` `复制网址` `查看日志`；
4. 底部状态栏显示服务状态，点击可开关面板。

### 命令面板（`DSH:` 开头）

| 命令 | 说明 |
|---|---|
| `DSH: 打开面板` | 打开 DSH 面板 |
| `DSH: 在浏览器中打开` | 在系统浏览器打开 DSH 页面 |
| `DSH: 重启服务` | 重启插件管理的服务 |
| `DSH: 停止服务` | 停止插件启动的服务 |
| `DSH: 复制网址` | 复制 DSH 页面地址 |
| `DSH: 查看日志` | 打开插件日志输出通道 |
| `DSH: 复制日志` | 把完整日志（环境信息 + 服务日志）复制到剪贴板，用于问题报告 |
| `DSH: 重试桥接安装` | 重新安装桥接并重启服务 |
| `DSH: 卸载桥接` | 移除桥接包并还原 `cordis.patch.yml` |

## 🔗 桥接与联动

安装后，插件会在你的 DSH 用户目录安装本扩展的桥接包（经 DSH 官方客户端插件扩展点安装），让面板与 VS Code 联动。启用后获得三项能力：

- 🔗 **外链跳转**：面板内点击外链，在系统默认浏览器中打开（而非被困在 iframe 内）；
- 📂 **文件跳转**：点击面板内任意文件路径（模型回复中的路径、产物列表、工具调用行如 `read · test/bridge/a.ts` / `Edit · README.md`）统一在当前 VS Code 窗口打开。**双层兜底**：入口元素 DOM 拦截 + RPC 层统一接管（DSH 所有打开文件操作最终汇聚的 `host.openPath` 请求被桥接截获并改写为扩展宿主打开，后端系统默认应用不弹出，DSH 页面无感）——今后 DSH 新增任何形态的文件入口都会被自动兜住；
- 📋 **剪贴板复制**：面板内 DSH 的复制按钮（如代码块复制）改由扩展宿主写入系统剪贴板，绕开 VS Code 对 webview 内跨源 iframe 的剪贴板权限拦截。
- ↩️ **撤销/重做（macOS Cmd+Z / Cmd+Shift+Z，Windows Ctrl+Z / Ctrl+Y）**：DSH 输入框自带 draft 事务级撤销系统，桥接对撤销/重做**放行不拦截**（快捷键事件直达页面处理，浏览器原生撤销对普通输入框照常生效）；右键菜单的「撤销/重做」改为向焦点输入框派发对应组合键，同样由页面自身执行。
- ⌨️ **任意快捷键转发（v0.3.2）**：面板内被 VS Code 吞掉的组合键（如 `Cmd+1`、`Cmd+Esc`）按 `dsh.bridge.shortcuts` 映射转发给扩展宿主执行对应 VS Code 命令。默认内置 `Cmd+1/2/3`（切换辅助栏/面板/侧边栏，与作者 keybindings 一致）、`Cmd+Esc`（最大化面板）；可在设置里自由覆盖或新增任意组合键（如 `"alt+1": "workbench.view.explorer"`、`"cmd+`": "workbench.action.terminal.toggleTerminal"`）；编辑类快捷键（Cmd/Ctrl+C/V/A/X/Z）仍由页面内本地仿真优先（复制/粘贴/剪切/全选；撤销/重做放行页面自身处理）。

### 安装与卸载机制（透明披露）

为让 DSH 网页能与 VS Code 通信，插件会：

1. 在你的 DSH 用户目录（`$DSH_HOME/profiles/web`，默认 `~/.dsh/profiles/web`）安装本扩展的桥接包 `dsh-vscode-bridge`（经 DSH 官方客户端插件扩展点安装）；
2. 在 `cordis.patch.yml` 中写入一段带 `# dsh-vscode-bridge: begin` / `# dsh-vscode-bridge: end` 标记的 `insert:` 条目，把桥接包注册为 DSH 的官方 client 插件（只写用户目录，绝不触碰 DSH 安装目录）。

如需移除，两种方式任选：
   - **卸载插件**：VS Code 卸载本扩展时会自动执行 `uninstall` 钩子，同样按标记精确删除条目并删除桥接目录（尽力而为，不影响卸载流程）；
   - **仅移除桥接**：执行命令 `DSH: 卸载桥接`，效果相同。

> 版本说明：桥接包版本与插件版本**始终一致**（二者一同随插件包发布到商城），安装器按「版本不一致 → 强制重装」保证逻辑更新触达。

### 桥接相关设置（`dsh.*`）

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.bridge.enabled` | `true` | 是否启用桥接（关闭后不安装、不注入、不弹警告，三项联动不可用） |
| `dsh.workspaceRootIndex` | `0` | 多根工作区时，用第几个根目录作为 `dsh web` 进程工作目录（越界回退第一个） |
| `dsh.bridge.silenceWarning` | `false` | 抑制桥接降级警告（例如在面板之外打开 DSH 页面时） |
| `dsh.bridge.shortcuts` | 见右 | 快捷键转发映射 `{ 组合键: VS Code 命令 }`（v0.3.2）。键写法：修饰键 `cmd`/`ctrl`/`alt`/`shift` + 按键（`a`-`z`、`0`-`9`、`` ` ``、`escape`、`f1`-`f24` 等），如 `"cmd+1"`；覆盖默认并支持新增任意组合，修改后面板自动重渲染生效 |

### 降级行为

桥接仅在面板内生效。若桥接未生效（例如你在浏览器里单独打开 DSH 页面、或安装失败），面板**完全可用**，只有上述三项联动不可用；插件启动时会弹一次警告，可选择「重试安装」或「不再提示」。

## 🆕 v0.3.0 新特性

- **SSH Remote**：开启 `dsh.remote.enabled` 后，插件在远端宿主运行、在远端启动/复用 `dsh`，并经 VS Code 隧道在本地面板展示——本地窗口保持干净，远端服务仍只监听 `127.0.0.1`。
- **非视觉模型也能发图（无感直发）**：在对话框里自由上传图片；当当前模型无图像输入能力时，图片保存到你的工作区，消息以「原文 + `图片：<绝对路径>`」直接发出——不报错、不弹提示，模型据此调用图像识别工具查看并正常回答；仅对支持视觉的模型才会以原生方式上传图片。
- **不再自动弹浏览器**：`dsh web` 以 `--no-open` 启动，插件不再弹出浏览器窗口；需要时可用 `dsh.openInBrowser` 恢复。

## ⚙️ 设置（`dsh.*`）

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.port` | `3080` | 期望端口（探测与启动共用） |
| `dsh.host` | `127.0.0.1` | 服务地址（仅允许回环地址） |
| `dsh.autoStart` | `true` | 服务未运行时自动启动 |
| `dsh.stopOnExit` | `true` | 关闭最后一个窗口时停止插件自启的服务 |
| `dsh.extraArgs` | `[]` | 启动 `dsh web` 时附加的参数 |
| `dsh.executablePath` | `""` | dsh 可执行文件绝对路径（Windows 为 dsh.cmd）；留空则从 PATH 查找 |
| `dsh.openInBrowser` | `false` | 服务启动后在默认浏览器中打开 DSH 页面（关闭时向 `dsh web` 传递 `--no-open`） |
| `dsh.remote.enabled` | `false` | 启用远程场景（SSH Remote / WSL / Dev Containers / Codespaces）：在远端运行 dsh，经 VS Code 隧道在面板中打开（默认关闭；开启后需重载窗口生效） |
| `dsh.image.fallback` | `true` | 当前模型无视觉能力时，把上传图片以文件路径形式随消息发送而不报错（文件缓存在会话工作目录，面板关闭时清理） |

## 🌍 多语言

界面文案跟随 VS Code 显示语言（`Configure Display Language`）：`zh-*` → 简体中文，其余语言 → 英文。

## 🧑‍💻 开发

环境要求：Node.js ≥ 22、VS Code ≥ 1.91。

```bash
npm install
npm run test          # 161 个单元/集成测试（含真实 dsh web 全流程）
npm run compile       # 构建 out/extension.js
npm run watch         # 监听构建
npm run typecheck     # 类型检查
npm run package       # 打包 .vsix
```

调试：VS Code 打开本目录，按 `F5` 启动 Extension Development Host。

```
src/
├── extension.ts          # 入口：装配与命令注册
├── i18n.ts               # 动态文案字典（zh-* 中文 / 其余英文）
├── config.ts             # 设置读取与规范化（loopback 白名单校验）
├── service/
│   ├── detect.ts         # 端口探测（识别 DSH 标记）
│   ├── process.ts        # 跨平台子进程封装（dsh / dsh.cmd）
│   └── manager.ts        # 服务管理器状态机（核心）
├── bridge/               # 桥接：安装器、握手宿主、消息处理、状态评估
├── panel/
│   ├── html.ts           # 面板占位页模板（CSP 最小权限）
│   └── provider.ts       # WebviewViewProvider（iframe + 占位页）
├── workspaceRoot.ts      # 多根工作区解析
└── statusbar.ts          # 状态栏控制器
```

## 🧭 已知限制

- 欢迎页"DSH 入门"卡片的彩色图标来自 Marketplace 画廊数据，仅在商店上架后显示（卡片功能本身不受影响）；
- SSH Remote：远端也需安装本插件（VS Code 会引导）；隧道会出现在「端口(Ports)」视图，用户可手动关闭，插件在下次就绪时自动重建。
- 图片降级：缓存文件放在**工作区根目录**——**需先打开一个工作区文件夹**（未打开文件夹时无法落盘缓存，也就不做降级）。**临时图“模型看完即删”**：同会话发出下一条消息时立即删除上一批（模型已读完并回答）；若不再发消息，约 2 分钟后自动删除兜底；会话新建/删除/切换、面板关闭/页面卸载与扩展停用也都会清理（尽力而为）。扩展激活时会自动扫描清理上次会话遗留的 `dsh-imgcache-*` 孤儿；也可随时运行命令 **`DSH: 清理图片缓存`** 一键清除。
- **复测如何确认桥接已更新**：在 DSH 面板 DevTools（开发者工具）Console 中应看到 `[dsh-vscode-bridge] handshake ok, **v0.3.2**, imageFallback=true` 与传图发送后的 `image fallback: 已把图片改为地址随消息重发（N 张）: …` 日志；若仍显示旧版本，说明旧桥接未重装——请重启 DSH 服务（新 vsix 随附桥接版本 `0.3.2`，安装器会在版本不一致时强制重装）。
- `--no-open` 默认传给 `dsh web`；若在 `dsh.extraArgs` 或 `dsh.openInBrowser` 显式选择弹浏览器，则按你的选择执行。

## 🌐 社区

本项目是 DeepSeek Harness 社区插件（话题：[`dsh-plugin`](https://github.com/topics/dsh-plugin)）。

- DSH 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 问题反馈：<https://github.com/Fengze233/dsh-vscode/issues>
- DSH 社区讨论：<https://github.com/deepseek-ai/deepseek-harness/discussions>

## 📄 License

[MIT](./LICENSE) © 2026 Fengze233
