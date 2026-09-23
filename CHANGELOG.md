## [0.3.26] - 2026-09-23

### 新增

- **聊天里 DSH「改动」卡片（`[data-changed-files]`）的文件行，点击改为在 VS Code 编辑器打开该文件**（用户明确：不需要在 VS Code 开真 diff，能解析出路径、用编辑器打开即可）。
  - **为什么只能 DOM 层拦**：该行点击**不发任何 RPC/HTTP** —— `button.row` 的 `onClick: openReview(index)` → `openChangesReview(...)` → `ctx.sidebarRight.openResource("dsh-resource://changes-review/…", { params: { index } })` → `placeResource` 只改前端 store（diff 内容要等侧栏 tab 挂载后才 GET `/api/changes.diff`）。传输层无请求可拦，必须在捕获阶段阻止 DSH 自己的 onClick。
  - **实现**：`core.js` 新增纯函数 `resolveChangedRowClick({ inChangedCard, describedBy, describedPath, rowText })`；`client.js` 的 `bindLinkInterception` 在文件链接分支**之前**加改动行分支，命中即 `preventDefault()+stopPropagation()` 并复用既有 `bridgeOpenFile` 消息 → **宿主侧零改动**（`handleBridgeMessage` → `resolveBridgePath` 多基准（DSH 会话 cwd → VS Code 各工作区根 → DSH 工作区注册表 + `exists` 兜底）→ `showTextDocument`）。
  - **路径取值优先级**：① 作用域必须在 `[data-changed-files]` 内（该 data-* 仅出现于聊天区卡片）→ ② 必须带非空白 `aria-describedby`（卡片 header「打开整轮 review」与底部折叠按钮都没有它，据此排除）→ ③ 取 `aria-describedby` 指向的隐藏 `span` 文本（DSH 用 `resolveWorkspacePath(cwd, file.path)` 渲染：cwd 已知时为**绝对路径**，缺失时退回**相对路径**，两种形态都支持）→ ④ 回退 row 首个子 `span` 文本（`file.display`）→ ⑤ 都不形似路径则返回 `''`（完全放行原事件）。注意 React `useId` 生成的 id 形如 `:r5q:-0`（含冒号），**不能当 CSS 选择器**，一律走 `getElementById`。
  - **有意的行为收紧**：改动行同样套用与文件链接一致的**多击/选区守卫** `isDuplicateOrSelectionClick`（`detail > 1` 或存在未折叠选区时不触发）。DSH 原生该行**没有**这层守卫，桥接加上它以避免双击/拖选收尾误开文件——属有意收紧，与既有文件链接行为保持一致。
  - **误拦面收窄（逐项有测试）**：卡片 header 按钮、折叠按钮（无 `aria-describedby`）、DSH 侧栏 review tab 内的文件行（不在 `[data-changed-files]` 作用域，语义是切换预览）、hover 预览 `span`（非 `button`）一律放行；不硬编码任何 CSS Modules 哈希类名（`hz8-rW_*` 随版本变），仅按 `data-*` / `aria-*` / 结构判定。

### 测试

- `test/bridge/core.test.ts` 新增 2 例：`resolveChangedRowClick` 的绝对/相对两形态、描述元素缺失时回退 row 文本、两者都不形似路径时不拦不抛错；以及误拦面（无 `aria-describedby` 的 header/折叠按钮、非卡片作用域、空白 `describedBy`）全部返回 `''`。
- `test/bridge/interceptor.test.ts` 新增 2 例（对**构建产物**、真实改动卡片 DOM 结构）：命中转发 `openFile` 且 `kind === 'openFile'`（复用既有消息）、`getElementById` 为 null 时回退、取不到路径时完全放行；header/侧栏行/hover span/未握手四种情形一律不拦。
- **反证**：临时移除 `client.js` 的改动行分支 → 新增的命中用例变红（`not ok 21`）；恢复后 22/22 绿。

## [0.3.25] - 2026-09-23

### 修复

- **修复 0.3.24 实机暴露的问题：点文件链接已到达 VS Code，但报 `Unable to resolve nonexistent file`（相对路径的解析基准选错）**。
  - **现象**：用户装 0.3.24 并 Reload 后点 `docs/global_free_app_configs_override_guide.md`，VS Code 提示 `无法打开文件：/Volumes/ssd/Documents/develop/third/dsh-vscode/docs/global_free_app_configs_override_guide.md（…Unable to resolve nonexistent file…）`——即 DOM 拦截层与转发链路已生效，但路径被拼到了**错误的仓库根**。
  - **根因**：`host.ts` 的 `resolveBridgePath` 对相对路径只赌**单一 base**（`base = sessionCwd ?? workspaceRoot`），而桥接消息从不携带 `cwd`（`client.js` 发 `openFile` 不带 cwd），于是永远退化为「VS Code 窗口工作区根」。但 DSH 前端产出的相对路径，其语义基准是**该会话的 cwd**（DSH 原生 `openFile` → `fileAddressFor(sessionId, cwd, path)`，见 `dsh-client-ui-chat/lib/client.js:12066`）。用户把 DSH 会话开在 A 仓库（`/Users/arming/Documents/develop/suansuan/suansuan`，该文件确实只存在于此处），却在 B 仓库（本扩展仓库）的 VS Code 窗口里用面板 → 相对路径被拼到 B 仓库根，必然不存在。
  - **修复（多基准 + 取第一个真实存在的文件）**：`resolveBridgePath` 收 `ResolvePathOptions { sessionCwds, workspaceRoots, exists }`，候选顺序为 **桥接消息自带 cwd → DSH 各会话 cwd（按 updatedAt 由新到旧）→ VS Code 各工作区根（多根逐个）→ DSH 工作区注册表里的全部工作区路径**，逐个与相对路径拼接后用 `fs.existsSync` 探测，**命中第一个真实存在的文件即打开**。未提供 `exists` 时保持旧语义（取第一个基准），既有调用方与单测行为不变。
  - **两个 DSH 侧基准来源**：① 首选 `session/list`（新 `DshApiClient.sessionCwds()`，扩展侧带 TTL 缓存 + 面板就绪后预热；参数按 0.1.7 线格式 `payload.args._request`，取 `items[].cwd` 按 `updatedAt` 倒序去重）；② 不依赖网络/鉴权的兜底——新增 `src/bridge/workspaceRegistry.ts` 解析 `$DSH_HOME/storages/workspace.json` 的 `tables.workspaces[*].path`（纯函数、防御式，形状不符返回空数组）。两来源任一失效都自动降级，不会打断点击链路。
  - **全不命中不再静默/裸报错**：多基准全部落空时弹可见提示，写明**原始相对路径**与**逐个试过的基准目录**，替代原先只有 VS Code 原生 `Unable to resolve nonexistent file` 的无上下文报错。

### 测试

- `test/bridge/host.test.ts` 新增 3 例：多基准按顺序取第一个真实存在的文件（会话 cwd 优先于工作区根、命中第二个工作区根、命中「另一个 DSH 工作区」的用户真实场景、全落空返回 `not-found` 并附试过的基础目录、无 `exists` 时保持旧语义、绝对路径/危险协议不受影响）；命中会话 cwd 时正常打开且无提示；全落空时提示包含原始路径与各基准。
- `test/bridge/workspaceRegistry.test.ts` 新增 3 例：按 0.1.7 实测形状提取路径、去重与非法项跳过、非 JSON/形状不符返回空数组、上限截断。
- **反证**：将 `resolveBridgePath` 临时回退为修复前的单基准实现 → 上述 3 个 `host.test.ts` 新用例全红（`应打开 DSH 会话 cwd 下的真实文件`）；恢复后全绿。
- **真实数据自测**：以用户实际路径（会话工作区 `/Users/arming/Documents/develop/suansuan/suansuan` + 真实 `fs.existsSync`）跑修复前后对比——修复前解析到本仓库根（不存在），修复后解析到 `…/suansuan/docs/global_free_app_configs_override_guide.md`（存在）。

## [0.3.24] - 2026-09-23

### 修复

- **修正 0.3.23 引入的 RPC 兜底层协议错误：0.1.7 的「宿主打开文件」端点是斜杠形态 `session/openWorkspacePath`，参数在 `payload.args.request`**（此前按点号 `session.openWorkspacePath` + `payload.path` 判定，在 0.1.7 上**永不命中**，RPC 兜底实为死代码）。
  - **复核依据（0.1.7 产物）**：端点恒为 `<namespace>/<method>`——`dsh-typert-registry/README.md`（Identity and validation：「`<namespace>/<method>` for endpoints」）、`dsh-api-gateway/lib/client.js:2039-2041`（`endpointOf = namespace + '/' + method`）、`dsh-api-gateway/lib/index.js:1219-1222`（`remoteRequest` 要求 `endpoint.split('/')` 恰为 2 段）；请求信封为 `{type:'client-request', rpcId, method: endpoint, payload:{args}}`（`dsh-client-connection/lib/client.js:1213-1221`、`dsh-api-gateway/lib/client.js:1788`）。
  - **参数位置**：`payload.args` **不是位置数组**，而是「按参数 wire 名索引的普通对象」（`prepareInvocation` 执行 `args[parameter.wire] = value`，`dsh-api-gateway/lib/client.js:1813-1842`；`remoteRequest` 亦要求 `payload.args` 是 plain object，数组会被 `isPlainObject` 拒绝）。`openWorkspacePath` 的参数 wire 名为 `request`（`dsh-api-remotes/lib/client.js:9951-9965` 描述符），故真实形态是 `payload.args.request = { path, action?, application? }`（请求 schema：`dsh-api-session-controller/lib/typert.host.js:516-520`）。**据此修正了审查意见中「取 `payload.args[0].path`」的说法**：实测应取 `payload.args.request.path`（仍防御性兼容 `args[0]`/摊平两种形态）。
  - **修复**：`core.js:extractOpenPathRequest` 认斜杠端点 `session/openWorkspacePath` 并解析 `payload.args.request`；`action:'reveal'` 与显式 `application` 放行语义照旧（判据改为该 request 对象），保留用户「离开编辑器」的显式意图；dsh ≤0.1.0-rc.6 的点号 `host.openPath` + `payload.path` 分支保留为旧版兼容（0.1.7 已无该端点：全仓无 `host.openPath`、无 `dsh-host-apiproxy`）。
- **补齐 DSH 原生同款的防误触守卫（多击 / 未折叠选区）**：DSH 原生文件链接 `onClick` 首行即 `if (event.detail > 1 || (event.detail !== 0 && getSelection()?.isCollapsed === false)) return;`（`dsh-client-ui-primitives/lib/index.js:5883`）——双击/多击、以及「文档里存在未折叠选区时的单击」（拖选收尾误触）都不打开文件。桥接在捕获阶段先于 DOM onClick 执行，此前不判这两个条件，反而比原生更容易误开文件；现由新增纯函数 `isDuplicateOrSelectionClick`（`core.js`）在 `client.js` 文件链接分支前统一守卫，命中即完全放行原事件（不 `preventDefault`/`stopPropagation`）。

### 文档

- `README.md` / `README.zh.md` 的「文件跳转 / File jumps」条目、`bridge-client/lib/client.js`（DOM 与 RPC 两处注释）、`bridge-client/lib/core.js` 的 `extractOpenPathRequest` 文档、`bridge-client/lib/core.d.ts` 声明，统一改为「0.1.7 为斜杠端点 `session/openWorkspacePath` + `payload.args.request`；点号 `host.openPath` 仅为 rc6 旧版兼容」，不再把 `host.openPath` 当作 0.1.7 的汇聚点。

### 测试

- `test/bridge/core.test.ts`：`extractOpenPathRequest` 用例**换成 0.1.7 真实请求体**（`{type:'client-request', rpcId, method:'session/openWorkspacePath', payload:{args:{request:{path}}}}`）——默认打开必命中、`action:'reveal'` 与显式 `application` 必放行；另断言点号 `session.openWorkspacePath` **不得**误判命中；rc6 点号 `host.openPath` 兼容用例独立成条；新增 `isDuplicateOrSelectionClick` 用例（多击、未折叠选区、折叠选区、`detail:0` 与缺字段）。
- `test/bridge/interceptor.test.ts`：新增原生守卫端到端用例（对构建产物派发 `detail:2`、以及未折叠选区下的 `detail:1`，断言不转发 `openFile` 且不 `preventDefault`/`stopPropagation`；恢复折叠选区后恢复接管）；`clickFile` 支持注入原生事件字段。

## [0.3.23] - 2026-09-23

### 修复

- **修复 dsh 升级到 0.1.7+ 后「点击聊天里的文件链接不再用 VS Code 编辑器打开」（回归）**：点击 markdown 文件链接、`@文件` 引用芯片、present 产物卡片，文件都落到 **DSH 自带侧栏预览**（`sidebarRight.openResource`），不再进编辑器。
  - **根因（两层同时失效）**：① **DOM 拦截按裸类名判定**——旧实现是 `btn.classList.contains('fileMention')`；dsh 0.1.7 起前端全部改用 CSS Modules，实际渲染为 `_fileMention_1jct6_85 _fileLink_1jct6_59`（`MarkdownFileLink`）/ `_fileMention_1jct6_85`（inline-code mention），`contains` 恒 false；同时 markdown 链接的 `title` 是**相对路径**（如 `src/a.ts`），旧的「title 为绝对路径」兜底也不命中 → DOM 层漏拦。② **RPC 兜底网整条断掉**——旧版汇聚点 `host.openPath` 在 0.1.7 中已被移除，打开文件改由 `session.openWorkspacePath` 承担。两层同时失效 → 点击回落到 DSH 原生 `openFile()` → 侧栏预览。
  - **修复**：DOM 判定收敛到 `core.js` 纯函数——`hasFileLinkClass`（类名子串匹配，兼容裸类名 `fileMention` 与 CSS Modules 哈希类名，含非下划线前缀形态如 `o3BgMG_fileLink`）+ `resolveFileClickPath`（「`data-ref-chip=file` 引用芯片 → 文件链接类名 → title 为绝对路径」三级判定，附行号锚点剥离与 `@`/目录/URL 形态排除）；RPC 兜底由 `extractOpenPathRequest` 接管。（注：本条最初把 0.1.7 的端点写成点号 `session.openWorkspacePath`，**该写法有误**——0.1.7 的 typert 端点是斜杠形态 `session/openWorkspacePath` 且参数在 `payload.args.request`；正确实现见 0.3.24。）
  - **防误拦**：非 `file` 的引用芯片（`folder`/`session`/`skill`）显式排除——它们同样是 `<button>` 且带 `fileMention` 类名，技能芯片 `title` 恰为 `/skill`，不排除会被当绝对路径误拦。
  - **兼容**：未握手（纯浏览器打开）时 `bridgeToken === ''` 直接放行，DSH 原生行为不变；旧版 dsh 的裸类名与无类名产物 chip（title 绝对路径）继续命中。

### 测试

- `test/bridge/core.test.ts` 新增 3 例：`hasFileLinkClass` 裸/哈希类名双向兼容与非文件类名不误判；`resolveFileClickPath` 覆盖新版哈希类名+相对路径、旧版裸类名、产物卡片、`@`芯片、非 file 芯片防误拦、行号锚点、普通按钮放行；`extractOpenPathRequest` 覆盖新旧 RPC 形态与 reveal/指定应用放行（该用例当时按点号形态自证，已在 0.3.24 换成真实请求体）。
- `test/bridge/interceptor.test.ts` 以真实 dsh 0.1.7 类名驱动**构建产物**端到端验证；并补齐 vm 沙箱缺失的 `URL` 全局（缺失会让 `isAllowedExternalUrl` 恒 false，外链用例假失败）。

## [0.3.22] - 2026-09-22

### 修复

- **修复 dsh 升级到 0.1.6+ 后插件「无法连接」——令牌交换的 `Location` 写法变化导致探测恒判 `foreign`**（用户实测：升级最新版 dsh 后面板连不上，日志刷屏 `[probe] 127.0.0.1:3080 → foreign（HTTP 303，响应体片段：）`）。
  - **根因**：dsh ≥0.1.6 的令牌交换重定向改为**目录相对根**——`dsh-client-connection` 源码为 `res.writeHead(303, { location: './' })`（早期版本是绝对根 `'/'`）。插件 `detect.ts` 按字面量比对 `location === '/'`，因此新版的合法 303 令牌交换被漏判，落入「非 OK 响应 → foreign」分支。
  - **故障链**：带令牌探测恒 `foreign` → `doStart` 的等待就绪循环永远等不到 `dsh` → 直到 `startTimeoutMs` 超时置 `err.startTimeout`，面板表现为连不上（此时子进程其实已正常启动、代理也已建立，只是「就绪判定」失败）。日志中「已捕获访问令牌 → 代理启动 → 之后一路 303 foreign 刷屏」正是该链路。
  - **修复**：新增 `isRootLocation(location, baseUrl)`，按「相对请求 URL 解析后 `pathname === '/'`」判定，兼容 `'/'`、`'./'` 与绝对写法；`/login`、`./login` 等子路径仍维持 `foreign` 语义不变。
- **修复纯空白令牌（如 `'   '`）被当作有效令牌**：`dsh.externalToken` 归一化前流入探测层时，空白串为真值 → 会拼进 `?token=` 且使「无令牌 401 → dsh-unauthenticated」判据失效 → 疑似 dsh 被误判 `foreign`。现在探测层统一把空串/纯空白归一化为「未提供令牌」（修复仓库中原本已红灯的该回归用例）。

### 测试

- `test/detect.test.ts` 新增 2 例：303 `Location: ./`（dsh ≥0.1.6）→ `dsh`；303 `Location: /login` 与 `./login` → 仍为 `foreign`。
- 实证：以真实 dsh `0.1.7-alpha.1` 做 A/B——修复前带令牌探测返回 `foreign（HTTP 303，响应体片段：）`（与用户日志逐字一致），修复后返回 `dsh`；真实 dsh 集成测试（启动/复用/停止/意外退出、多实例并发）全绿。

## [0.3.21] - 2026-09-14

### 修复

- **修复多窗口场景下「还有别的窗口在用，dsh 进程却被提前 kill」**（回归）。根因两条：
  1. **共享使用者注册表被自己写坏**：`pruneDeadUsers` 清理失效条目后把结果写回磁盘时，误把**当前窗口自己**也从共享注册表（`dsh.users@host:port`）里过滤掉，于是本窗口一退出就被判定为「最后一个使用者」而触发停止流程——实际还有其他窗口在登记使用；
  2. **共享实例被启动它的窗口拖着一起死**：共享 dsh 子进程的 stdout 继承自启动它的那个窗口，该窗口关闭后管道断裂（EPIPE），dsh 自身因写日志失败而自杀，剩下仍在使用的窗口随之失联。
- **stdio 保活加固**：新增 `stdioGuardEnv()`，为 spawn 的 dsh 子进程注入 `NODE_OPTIONS=--require $TMPDIR/dsh-vscode-stdio-guard.cjs`（stdout/stderr 写入失败时静默丢弃而不是让进程崩溃），使共享实例在启动方窗口关闭后继续存活。
- **新增回归用例**：`test/manager.test.ts` 覆盖「prune 后的写回不得删除自己」；`test/process.test.ts` 覆盖 `stdioGuardEnv()` 的环境变量注入与幂等。

## [0.3.9] - 2026-09-05

### 新增

- **无令牌复用其他终端/窗口启动的 dsh web 实例（会话 Cookie 持久化）**：配置端口被「新版 dsh 未认证（401）」占用时，不再直接换端口另起实例，而是先依次尝试复用，全部落空则弹出**强制三选一决策**（不再静默换端口）：
  1. **精确识别占用者**：探测新增「疑似 dsh 未认证」分类——无令牌收到 401 且响应体含 dsh 认证提示（`dsh web authentication required`）；其余非 OK 响应（含带令牌的 401，即令牌错误/过期）维持原「端口被其他程序占用」语义；
  2. **会话 Cookie 持久化复用**：代理令牌交换得到的会话 Cookie 自动持久化到用户级 globalState（按 `host:port` 分键，跨窗口/跨 VS Code 重启共享；dsh 的 Cookie 由机器级持久 secret 签名，跨实例有效）——启动时先以持久化 Cookie 探测（200 + `__DSH_BOOT__` 即复用，owned=false，不杀他人进程），Cookie 失效（探测仍 401）自动清除；健康探测同样携带 Cookie，会话失效即清除存储并回 idle；
  3. **强制三选一决策弹窗**（UX 变更，替代原「一次性引导 + 自动回退」）：Cookie 复用落空时弹 modal 强制决策，ESC/关闭立即重弹直到明确选择，等待期间不落任何回退——
     - **输入令牌重试**：粘贴该实例启动输出中带令牌的完整 URL（兼容整行启动日志，按 `dsh.externalToken` 同款规则归一化）或纯令牌；探测验证有效（303 令牌交换命中）即**写入 `dsh.externalToken` 设置（用户级）**并复用（owned=false，不换端口）；无效则提示「令牌无效或实例已变化」后重弹三选一；输入框取消回到三选一。**无效令牌绝不写入设置**（验证通过才持久化）；
     - **使用其他端口启动实例**：仅此选择执行「自动换端口」回退（保留原有「临时改用端口」提示文案）；
     - **按原流程重试**：完整重跑探测决策——实例已消失则原端口自启（owned=true）；仍被占用则重弹三选一；
     - 适用范围：主路径与崩溃自愈路径的最终决策点统一走该弹窗；`autoStart=false` 保持原 `err.portOccupied` 语义不弹窗；`foreign`（非 dsh 占用/带令牌的 401）维持静默换端口不弹。无新设置项。
  4. **代理支持预置 Cookie 启动**（跳过令牌交换）；无令牌时 401 自愈不再尝试交换（记日志降级为 502/401，不死循环）。
  5. **多窗口同时冷启动竞态自愈**：两个窗口几乎同时打开面板时，双方初始探测均「未运行」而各自 spawn dsh，后绑定端口的子进程因 EADDRINUSE 崩溃——此前的崩溃自愈路径只识别「无令牌旧版 dsh」，新版 dsh 的 401 会被当成普通端口占用而直接换端口（即用户实测的「窗口 B 提示 3080 被占用、临时改用 3081」）。现在崩溃自愈探测到「疑似 dsh 未认证」时同样先尝试持久化 Cookie 复用（含约 2 秒宽限重试，吸收赢家「绑定端口 → 发布 Cookie」的短暂窗口与跨窗口 globalState 同步延迟），复用失败与主路径一致弹出三选一决策。
  6. **探测决策链结构化诊断日志**：初始探测/自愈探测结果、持久化 Cookie 读取（命中/未命中）与带 Cookie 探测结果、用户决策走向全量记录到 DSH 输出通道（`[process]` 前缀）；探测层新增 `[probe]` 诊断（仅注入日志时生效，记录非 dsh 判定的 HTTP 状态码与响应体片段、网络错误的具体信息），真实环境复现「A 就绪后 B 仍回退」时可直接从日志定位分类偏差。
  - 已知边界：Cookie 复用路径无令牌，「浏览器打开/复制网址」得到的是裸地址（浏览器侧 401）；面板经代理不受影响。需要浏览器访问时在三选一中选择「输入令牌重试」完成 `dsh.externalToken` 配置。

### 修复

- **修复「未配置 externalToken 时疑似 dsh 实例被误判 foreign、静默换端口且不弹三选一」**（用户实测：A 窗口在 3080 就绪后，B 窗口 Reconnect 直接改用 3081，无复用也无决策弹窗）。根因：`dsh.externalToken` 设置默认值为空串 `''`，归一化后仍是 `''`，流入探测层后使「无令牌 401 → dsh-unauthenticated」判据（`token === undefined`）失效——空串被当作「已提供令牌」，401 响应体不再识别，直接落入 foreign 静默换端口分支（单测环境传 `undefined` 故从未暴露）。修复（双层）：`ServiceManager` 构造时把空串/纯空白 externalToken 归一化为 `undefined`；探测层所有令牌判据改为真值语义（空串一律按无令牌处理），并补回归测试覆盖空串 401 识别与三选一触发。
- **修复「重装/冷启动后 bridge 误报未激活 + 面板首屏白屏且无任何操作入口」**（用户实测：冷启动握手在 3s 内未完成即判失败并弹警告，iframe 首屏未渲染完时面板一片空白、无按钮可用）。修复三点：
  1. **握手超时 3s → 20s**：冷启动时 dsh web 首屏需引导十余个 client 模块再初始化 UI，3s 太紧（实测热启动 1s 内握手成功、冷启动 3s 超时误报）；
  2. **超时自动恢复**：首次握手超时不再直接判失败，而是自动重载面板 iframe 重试一次（覆盖首屏中途 404/模块引导慢的场景），重试仍超时才判 degraded；
  3. **页面加载异常提示条**：就绪页底部新增可点亮/隐藏的提示条（扩展侧 postMessage 控制，不重载 iframe）——握手超时或失败后自动点亮，显示「DSH 页面未正常加载（空白或无响应）？」并提供【重新加载页面】【重试安装桥接】两个可重复点击的手动按钮（分别触发 iframe 重载与桥接重装+服务重启），彻底告别无声白屏。

## [0.3.8] - 2026-08-31

### 修复

- **修复「快捷键 cmd+1 / cmd+2 / cmd+3 点击一次经常连续触发两次」**（用户实测反馈）。根因排查：单次 keydown 逻辑只转发一次（`e.repeat` 已过滤按住不放），双发来自**同一页面内 keydown 监听器叠加**（桥接模块被重复 materialize，如 HMR 热重载/重复注入——每次执行都向 window 注册监听器，旧的不会随模块重载移除）或**事件竞态双发**；toggle 类命令（切换辅助栏/面板/侧边栏）双执行会来回横跳，表现为"点击一次动两次"。修复（双层防线）：
  1. **桥接客户端幂等安装保护**：`window.__dshVscodeBridgeInstalled` 标记，模块被重复 materialize 时跳过注册并记日志——监听器不再叠加；
  2. **页面侧转发去抖**：同一组合键 300ms 内重复命中只转发一次（同时保持 preventDefault，事件仍被接管）；
  3. **扩展侧命令去抖**：provider 收到同一 combo 的 300ms 内重复消息只执行一次命令并记日志（兜底覆盖页面侧之外的任何双发路径）。
  - 配套桥接升至 0.3.8（扩展+桥接统一，触发强制重装）；新增构建断言（产物含幂等标记与去抖状态）。

## [0.3.7] - 2026-08-31

### 新增

- **支持复用外部已启动的 dsh web 实例（手动令牌）**：终端里手动启动的 `dsh web`，插件拿不到其动态令牌（仅打印在该进程的 stdout，无持久化）。新增设置 `dsh.externalToken`：粘贴终端打印的完整 URL（或仅 `token=` 的值）即可在面板中复用该实例（探测/地址/代理均使用该令牌），令牌无效时自动回退「换端口启动插件自有实例」。**更推荐的多实例方式无需任何配置**：插件探测到配置端口被其他 dsh 实例占用时，自动临时换端口启动自有实例并自动解析其令牌（见下）。

### 修复

- **修复「页面能打开但显示『连接中…→连接异常』」**（0.3.6 遗留）。根因：DSH 前端的实时通道（Typert Remote 流：会话/工作区事件推送）走 **WebSocket**（`ws://<页面origin>/api/remote.mux`，`dsh-api-gateway` 的 upgrade 路由），而 0.3.6 的面板嵌入代理**只转发 HTTP、没有处理 upgrade** —— Node http server 对 upgrade 请求会直接关闭 socket → WS 握手必然失败 → 前端连接指示器从「连接中…」变为「连接异常」（首页/静态资源/RPC 单发都正常，所以页面能渲染出来，误导性强）。修复：
  1. **代理支持 WebSocket upgrade 转发**（`/api/remote.mux` 及任意 upgrade 路径）：注入会话 Cookie、剥离 `Origin`/`sec-fetch-*`、改写 `Host`（与 HTTP 转发同规则，通过 dsh 的 `requestRejection` 鉴权），重建 `Connection: Upgrade` 头，上游 101 响应手写回传（含 `Sec-WebSocket-Accept`），之后双向字节管道透传（含握手后 head 数据）；上游 401 时重新交换会话 Cookie 后重试一次；
  2. **修复转发请求未剥离 `Transfer-Encoding` 的头**（chunked 请求体会因「chunked 头 + 已解帧 body」损坏）；
  3. **修复代理 stop() 挂起**（已升级的 WebSocket socket 脱离 http 连接管理，closeAllConnections 关不掉 → server.close 永久等待；现显式跟踪并销毁）；
  4. 新增 WS 转发单元测试（本地假 dsh + 最小 WS echo 服务端 + 原生 WebSocket 客户端）与真实 dsh 集成断言（无 Cookie 客户端经代理握手成功）。
- **确认并验证 dsh 多实例（多端口）并发无冲突**：新增真实 dsh 集成测试（`test/integration/multi-instance.test.ts`）——两个实例同时运行，各自的令牌交换 / 首页 / WebSocket 实时通道全部正常，日志无锁/冲突报错。因此插件「端口占用 → 自动换端口启动自有实例」的多实例方案可靠：**旧实例残留时无需手动关闭，也无需手动输入令牌**。
  - 说明：残留的旧 dsh 实例占着配置端口时，插件会自动临时换端口启动新实例（弹窗告知新端口，仅本次会话），旧实例可随时手动关闭；也可执行 `DSH: 重启` 让插件重新走完整启动流程。

## [0.3.6] - 2026-08-31

### 修复

- **修复「面板能打开 Web 但显示『需要授权』（dsh web authentication required）」**（0.3.5 遗留）。根因：新版 dsh 的会话 Cookie 是 **`HttpOnly; SameSite=Strict`**，而 VS Code webview 的 iframe 是跨站子框架 —— Strict Cookie 在子框架请求中**永远不会被回传**（且 webview 本身不持久化 Cookie）。面板 iframe 加载 `/?token=X` 完成 303 令牌交换后，重定向到 `/` 的请求不带 Cookie → 401 → 显示授权页。**修复：扩展宿主内启动本地反向代理（面板嵌入代理）**——代理自己完成令牌交换并持有会话 Cookie，把 webview 的每个请求注入 Cookie 后转发给 dsh，同时剥离 `Origin`/`sec-fetch-site` 并改写 `Host` 通过 dsh 的 Host/Origin 围栏；webview 只面对代理：无重定向、无 Set-Cookie、全程 200，完全不依赖浏览器 Cookie。具体：
  1. 新增 `src/service/proxy.ts`（`DshProxy`）：令牌交换拿会话 Cookie → 转发时注入；401 自动重新交换并重试一次；响应剥离 Set-Cookie；
  2. 管理器就绪后（有令牌时）自动启动代理，`embedUrl` 供面板嵌入；代理随服务停止/重启/令牌变化而重建；旧版 dsh（无令牌）不启动代理，行为不变；
  3. 面板 iframe / CSP frame-src / 桥接握手 origin 全部改用代理地址；**浏览器打开 / 复制地址仍用带令牌的真实地址**（浏览器 Cookie 正常，行为不变）；
  4. 代理启动失败自动回退直连并记日志，不影响服务本身。
  - 该方案不削弱 dsh 的令牌鉴权（只有扩展宿主持有会话凭据），也不依赖 dsh 内部实现，兼容后续 dsh 版本。

## [0.3.5] - 2026-08-31

### 修复

- **修复「升级新版 dsh 后扩展无法在 VS Code 中打开 Web」**（实机日志 `dsh web: http://127.0.0.1:3081/?token=...` 确认）。根因：新版 dsh 每次启动**动态生成 32 字节随机访问令牌**（无禁用/固定选项），URL 形如 `dsh web: http://host:port/?token=XXX`，未带令牌访问首页一律返回 401；而扩展此前用裸地址（无令牌）做端口探测与面板加载 → 探测被误判为「端口被其他程序占用」/「启动超时」，面板打不开 Web。修复：
  1. **解析子进程启动输出中的令牌**（`dsh web: ...?token=XXX` 行，兼容跨 chunk 分片到达与 LAN 附加地址，只取回环地址的令牌）；
  2. **端口探测携带令牌**（带令牌走 303 令牌交换判定——`Location:/` + `dsh-auth-*` Cookie；未带令牌保持旧版行为，兼容旧版 dsh）；
  3. **面板 iframe / 浏览器打开 / 复制地址全部使用带令牌 URL**（就绪后令牌才到达时自动刷新地址）；
  4. **令牌与进程绑定**：重启/停止/意外退出即失效并重新解析，健康探测同样携带令牌（否则 401 会被误判为「服务失联」）。
  - 旧版 dsh（无令牌行）完全不受影响：按原裸地址行为探测与访问。

## [0.3.4] - 2026-08-26

### 修复

- **撤销/重做（Cmd/Ctrl+Z、Cmd+Shift+Z、Ctrl+Y）无效**。根因：DSH 输入框自带 draft 事务级撤销系统（keydown 里 Cmd/Ctrl+Z/Y → `keyboard.undo()/redo()`），而桥接在捕获阶段把 Cmd+Z 拦截（`preventDefault`+`stopPropagation`）——事件到不了 DSH 的 keydown 处理器，其自带撤销被遮蔽；桥接本地执行的 `execCommand('undo')` 对 React 受控输入无效（原生撤销栈为空），旧的手动快照栈也因此失效。修复：**撤销/重做一律放行给页面自身处理**（快捷键事件不再拦截，浏览器原生撤销对普通输入框照常生效）；右键菜单「撤销/重做」改为向焦点输入框派发合成 Cmd/Ctrl+Z（重做带 Shift），由页面自身执行（合成事件不会触发浏览器默认动作，无双重撤销）；**菜单点击会抢走焦点（mousedown 聚焦），故在弹出菜单瞬间记录当时的编辑焦点，派发以它为 target**——否则合成 keydown 派发到菜单按钮上，到不了输入框的 keydown 处理器；移除已无用的手动撤销/重做栈（`inputHistory`/`manualUndo`/`manualRedo`）。

- **点击对话中的文件路径统一改为当前 VS Code 窗口打开**（此前会调用 DSH 的 `host.openPath` 用系统默认应用打开）。**双层兜底**：① DOM 拦截（`button.fileMention`、产物 chip、工具调用行的 fileLink——按文本路径形态或「位于 `[data-disclosure-row]` 折叠行内」识别，覆盖相对化后只剩 basename 的根目录文件如 `Edit · README.zh.md`）；② **RPC 层统一接管**（v0.3.4 新增，根治"某种卡片漏拦"）：DSH 所有文件打开入口最终都汇聚到 `host.openPath` RPC（`WebApiClient.doFetch = globalThis.fetch`，必经桥接已拦截的 fetch），桥接在发送前拦截该请求——不发给后端（系统默认应用不弹出）、转发扩展宿主 `showTextDocument` 在当前窗口打开、伪造 `server-response` 成功响应（rpcId 回显 + `opened:true`）让 DSH 无感。此后无论 DSH 新增任何形态的打开文件 UI，都会被 RPC 层兜住；普通按钮不受影响，未握手（普通浏览器）仍保持 DSH 原生行为。
- **桥接版本同步 0.3.4**（扩展+桥接统一，随包发布触发强制重装）。

## [0.3.2] - 2026-08-26

### 新增

- **快捷键桥接：面板内任意 VS Code 快捷键可用**。与 Cmd+C/V 修复同源（VS Code 只把快捷键转发给顶层 webview、嵌套 iframe 内的组合键全部被吞），桥接现在把 iframe 内按下的组合键转发给扩展宿主执行对应 VS Code 命令。新增设置 `dsh.bridge.shortcuts`（`{ 组合键: 命令 }` 映射）：
  - **默认内置**（与作者 keybindings 一致）：`Cmd+1` 切换辅助栏、`Cmd+2` 切换面板、`Cmd+3` 切换侧边栏、`Cmd+Esc` 最大化面板（Windows 对应 `Ctrl+` 前缀版本同设）；反引号键未内置默认映射，需要时自行添加（如 `"cmd+`": "workbench.action.terminal.toggleTerminal"`）；
  - **任意扩展**：组合键写法 `cmd`/`ctrl`/`alt`/`shift` + 按键（字母、`0-9`、`` ` ``、`escape`、`f1-f24` 等），如 `"alt+1": "workbench.view.explorer"`；条目覆盖默认、可自由新增，修改后自动重渲染面板生效；
  - 编辑类快捷键（Cmd/Ctrl+C/V/A/X/Z）仍由页面内本地仿真优先（复制/粘贴/剪切/全选），不参与自定义映射；撤销/重做（Cmd+Z 等）放行给页面自身处理（见 0.3.4 修复）；按住不放的自动重复不会重复触发 toggle 类命令。
  - 配套桥接升至 `0.3.2`（扩展+桥接统一，触发强制重装），握手诊断日志新增 `shortcuts=N` 便于确认映射已下发。

## [0.3.1] - 2026-08-24

### 修复

- **修复「商店更新到 0.3.0 后仍无法上传图片、弹旧报错」**（实机用户反馈）。根因：桥接版本与插件版本统一后，安装器此前只按「版本号不一致」决定重装；若用户机器上残留的是**旧代码的 0.3.0 桥接**（早期有 bug 的版本，会把被拒响应透传并弹「图片已保存为文件路径…」提示），新包桥接也是 0.3.0 → 版本一致 → **跳过重装 → 继续跑旧代码**。修复：① 安装器新增**内容一致性校验**——随附 `client.js` 与已装 `client.js` 字节比对，不一致即强制重装（不再依赖版本号）；② 版本升至 **0.3.1**（扩展+桥接统一）触发所有旧桥接重装；③ 握手回执携带桥接版本，扩展日志显示 `[bridge] handshake ok (bridge v0.3.1)`，一眼确认页面跑的是哪份代码。

## [0.3.0] - 2026-08-20

### 变更

- **右上角图标改为「原鲸鱼 + 白底」**（`assets/whale-icon-bg.svg`）：原图标为纯黑填充（`#000000`），在深色主题的编辑器标题栏上几乎不可见。现给原鲸鱼加白底圆角背景，明暗主题下都清晰可辨；**左右侧边栏容器图标保持原始 `assets/whale-icon.svg` 不变**（曾尝试明暗双主题变体，侧边栏渲染异常且用户不满意，已回退并删除变体文件）。
- **卸载扩展时自动清理桥接**：`package.json` 新增 `uninstall` 钩子（`node ./out/uninstall.js`），VS Code 卸载扩展时自动从 DSH 用户目录移除桥接包并按 begin/end 标记还原 `cordis.patch.yml`（尽力而为，不影响卸载流程；仍可用 `DSH: 卸载桥接` 手动移除）。
- **桥接版本与插件版本统一**：二者始终一致（一同随插件包发布到商城），新增回归测试防漂移（bridge-client 版本 === 插件版本，且握手日志随版本号）。

### 修复

- **修复 issue #6：macOS 无法 Cmd+Z 撤销**。根因：VS Code 吞掉嵌套 iframe 内快捷键，且 DSH 输入框为 React 受控组件、原生撤销栈为空，`document.execCommand('undo')` 失效且按键已被桥接接管。桥接现为每个可编辑元素维护**手动撤销/重做栈**（`beforeinput` 记录改动前值、连续输入按 400ms 归组为一条记录，上限 100 条；原生撤销可用时优先原生、失败时手动兜底），并覆盖 Cmd+Shift+Z / Ctrl+Y 重做。配套桥接升至 `0.3.5`（触发强制重装），握手诊断 `handshake ok, v0.3.5`。

### 新增

- **SSH Remote 支持（可选）**：远程连接时可在远端运行 dsh，并经 VS Code 隧道在面板中打开。
  新增设置 `dsh.remote.enabled`（默认 `false`）。开启后：扩展在远端宿主管控 dsh（复用优先、自动启动兜底），
  用 `vscode.env.asExternalUri` 建立本地↔远端端口隧道，展示、复制网址与浏览器打开均使用隧道本地 URL；
  关闭时远程窗口显示引导占位页，不启动远端服务。声明 `extensionKind` 优先在工作区（远端）运行。
- **编辑器右上角 DSH 图标**：`editor/title` 贡献 + `dsh.openFromTitle` 命令，点击在编辑器标签栏右上角图标
  打开右侧辅助侧边栏面板（与 Claude Code 同位置）。
- **对话框自由上传图片**：模型无视觉能力时不再报错——桥接客户端在附件加入/拖拽/粘贴时捕获图片字节并去重缓存；
  发送被服务端以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝后，自动把图片经扩展宿主缓存到工作区，
  把图片改为「地址（绝对路径）」随消息重新发出，模型据此自行用图像识别工具查看并正常回答，全程无感；
  页面卸载时清理缓存文件；新增设置 `dsh.image.fallback`（默认 `true`）。普通浏览器/未握手时行为与之前完全一致。
- **新增设置**：`dsh.openInBrowser`（默认 `false`，关闭即默认传 `--no-open`）、
  `dsh.remote.enabled`（默认 `false`）、`dsh.image.fallback`（默认 `true`）。

### 修复

- **dsh 新版默认弹浏览器**：启动 `dsh web` 默认追加 `--no-open`（DSH 上游 `openBrowser` 默认 true），
  不再自动打开浏览器；需要时用 `dsh.openInBrowser=true` 恢复原行为。
- **兼容不支持 `--no-open` 的旧版 dsh（验收修复）**：启动崩溃并伴随换端口级联的问题根因——旧版 dsh 的
  commander 不识别 `--no-open`，报 `unknown option` 后退出且被误判为“端口被抢占”。现用 stderr 识别该根因，
  本次会话自动去掉 `--no-open` 并**原端口**重启，不再陷入换端口级联。
- **图片自由上传真正生效（验收修复）**：① 桥接包版本升至 `0.3.0`，安装器据此对旧装桥接强制重装（此前版本未变不会刷新页面里的桥接代码）；② RPC 线格式对齐——DSH 请求体为 `{ rpcId, payload }`，拦截改按 `payload.content` 判定并按 `{rpcId, payload}` 重构重发；③ 图片落盘 cwd 增加工作区根兜底（此前未传 cwd 会拒绝写入）。注意：图片降级需在**打开工作区文件夹**的窗口内使用（缓存文件落在工作区根）。
- **图片降级重发重构为「无感直发」（本轮验收修复）**：此前被拒响应原样透传给 DSH，导致消息不发且弹「当前模型不支持图像输入」报错。现改为：图片落盘后，协议层用「原文 + 图片：<绝对路径>」重构请求重发，并用**重发成功响应顶替被拒响应**交回 DSH——用户看到的是图片照常发送、模型正常回答，不再有任何报错或降级通知；被拒响应不再透传，`imageFallback` 通知消息与弹窗一并移除（改为 DevTools 诊断日志）。无落盘（未打开工作区）时仍保留原生报错，绝不吞错误。
- **桥接包版本升至 `0.3.1`（交付修复）**：上一版 vsix 已给用户装过桥接 `0.3.0`，新 vsix 若仍随附 `0.3.0`，安装器会判定「版本一致、无需重装」，导致用户侧继续跑旧的降级逻辑、复测必失败——现升至 `0.3.1` 强制安装器覆写旧包；握手诊断日志同步为 `handshake ok, v0.3.1` 供 DevTools 确认新桥接已加载。
- **图片降级三项验收修复（按实机反馈）**：① **只降级本条消息实际包含的图片**——按消息内的图片块顺序（图片一、图片二…）匹配已捕获缓存（文件名/数据双重匹配），不再把历史上传的全部图片反复引用进后续消息；已用过的缓存立即消费移除；② **图片按上传/发送顺序标注** `图片一：<路径>`/`图片二：<路径>`，多图顺序一目了然；③ **临时图片随对话终止清理**——新建/删除/切换会话时，删除上一对话已落盘的工作区临时图片（页面卸载与扩展停用清理保留）。配套将桥接升至 **`0.3.2`**（用户已装 `0.3.1`，必须再升版本触发强制重装），握手诊断同步 `handshake ok, v0.3.2`。
- **临时图「模型看完即删」（按实机反馈重构清理语义）**：每条消息的临时图按「批次」管理——① 同会话发出**下一条消息**时立即删除上一批（此时模型已读完该图并给出回答）；② 若不再发消息，TTL（默认 2 分钟）**自动删除**兜底；③ 会话新建/删除/切换、页面卸载、扩展停用、手动命令等触发全部保留。磁盘上任何时刻最多只有“当前刚发、可能正在被模型读取”的一批图，杜绝占用与隐私残留。桥接升至 **`0.3.3`**（强制重装），握手诊断 `handshake ok, v0.3.3`。
- **临时图清理再加两层兜底（按实机反馈）**：① **孤儿扫描**——VS Code/扩展重启会让内存注册表丢失、旧 `dsh-imgcache-*` 成为无人追踪的孤儿（现有按注册表清理找不到）；现于扩展激活时按工作区根目录扫描，只删本扩展专属命名空间（`dsh-imgcache-*` 白名单）的残留；② **手动命令 `DSH: 清理图片缓存`**（`dsh.cleanupImageCache`）——随时一键删除注册表缓存 + 扫描清理孤儿。这两层都**不依赖注册表**，解决“重启/关闭后仍残留”的根因。
- **右上角图标改为鲸鱼图标（验收修复）**：`dsh.openFromTitle` 图标由辅助侧边栏 codicon 改为扩展自带 `assets/whale-icon.svg`。

### 其他

- 桥接消息协议扩展：`saveImage` / `deleteImages`（含握手转发与扩展宿主落盘/删除，
  均为白名单 + 路径安全防护）。
- 回归：既有 v0.2.4 功能（本地面板/双侧栏/命令/状态栏/桥接/端口回退/退出清理/双语）全部保留并有回归测试覆盖。

## [0.2.4] - 2026-08-19

### 修复

- **macOS 上聊天内容无法复制/粘贴/右键（issue #3）**：VS Code 在 macOS 上会吞掉嵌套 iframe 内的 `Cmd+C` / `Cmd+V` / `Cmd+A` 等标准快捷键与右键菜单（上游 bug [microsoft/vscode#129178](https://github.com/microsoft/vscode/issues/129178) / [#180234](https://github.com/microsoft/vscode/issues/180234)，官方未修复）。桥接包在握手后接管这些操作：
  - 捕获 `keydown`，识别 `Cmd/Ctrl+C/V/X/A/Z` 与 `Shift+Insert`，优先用 `document.execCommand` 模拟（此方案由 Flutter DevTools 团队在同类场景验证有效）；
  - **复制/剪切兜底**：`execCommand` 不可用时，把选区文本经剪贴板写桥接交给扩展宿主写入系统剪贴板；
  - **粘贴兜底**：新增剪贴板读取桥接（`vscode.env.clipboard.readText`，无 webview 权限限制），把剪贴板文本插入焦点输入框（textareas 兼容 React 受控组件）；
  - **右键菜单**：捕获 `contextmenu` 弹出自定义菜单（复制/粘贴/剪切/全选/撤销/重做），不再依赖 VS Code 的原生菜单；
  - 未握手（普通浏览器）时保持原生行为完全不变。

## [0.2.3] - 2026-08-17

### 修复

- **DSH 侧栏内代码块「复制」无反应**：双层修复剪贴板在 VS Code 内嵌跨源 iframe 中失效的问题：
  - 给内嵌 DSH 页面的 iframe 显式声明 `allow="clipboard-write"`；
  - 桥接包接管 DSH 页面的 `navigator.clipboard.writeText`：复制文本经面板转发给扩展宿主，由 `vscode.env.clipboard` 写入系统剪贴板，绕开 VS Code 对 webview 跨源 iframe 剪贴板 API 的权限拦截；桥接禁用/未安装时保持 DSH 原生行为不变。

# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.2] - 2026-08-17

### 修复
- **Windows 下服务启动失败（全局 dsh 场景）**：修复 Windows 上「已全局安装 dsh，插件却报未找到 dsh / 服务启动失败」的完整问题链：
  - Windows 改用 `node <bin.js>` 直跑 dsh 入口，规避 spawn `dsh.cmd` 批处理 shim 的 EINVAL；
  - 桥接包安装到三个位置（web profile、profiles 根、npm 全局 node_modules），覆盖 VS Code 扩展宿主进程的模块解析链；
  - 桥接 host 插件改为**零外部依赖的函数式插件**，不再 import `@deepseek-ai/cordis`——npm 全局安装布局下该依赖嵌套在 dsh 包内部，顶层解析不到会导致整个插件树加载失败；
  - 安装器比对桥接包版本，升级插件时自动刷新旧版桥接包；
  - Windows 下改用系统 PATH 中的 `node.exe` 直跑 dsh 入口，不再使用扩展宿主的 `process.execPath`（Electron 的 Code.exe）——Electron 运行时缺少 dsh loader/HMR 依赖的系统 Node 内部特性，会报 `--expose-internals is required` 并崩溃。
- 子进程因端口被残留 dsh 实例占用而崩溃时，自动探测并复用现有服务，不再误报启动失败。
- 启动期间端口被其他程序抢占（如 WSL 与 Windows 共享 localhost 端口、WSL 侧 dsh 慢启动竞态）导致崩溃时，自动改用第一个空闲端口重启，不再报启动失败。

### 新增
- **端口占用自动替换**：`dsh.port` 被其他程序占用时，自动改用第一个空闲端口（仅本次会话临时生效，不修改设置），并弹窗告知临时端口。
- **日志增强**：日志带时间戳与环境信息头（扩展/VS Code/dsh/Node 版本、平台、关键配置）；记录实际启动命令；新增 `DSH: 复制日志` 命令一键复制完整日志用于问题报告。

## [0.2.1] - 2026-08-16

### 修复
- 构建前清空 out 目录，消除删除文件后的产物残留（测试数统计失真）
- 握手 token 改用 crypto 随机数（不可预测）
- retryBridge 失败路径兜底，消除未处理异常

### 改进
- 扩展改为按需激活，减少 VS Code 启动负担
- 新增 GitHub Actions CI（typecheck + 测试 + 打包）
- 新增 Issue/PR 模板与贡献指南
- README 英文主版 + 中文版（README.zh.md，顶部语言互链）

## [0.2.0] - 2026-08-15

### 新增

- **桥接与工作区联动**：通过官方扩展点桥接包，面板与 VS Code 之间新增两项联动能力：
  - 面板内点击外链，在系统默认浏览器中打开；
  - 面板内点击文件路径，在 VS Code 中打开对应文件。
- **桥接命令**：新增 `DSH: 重试桥接安装` 与 `DSH: 卸载桥接` 命令。
- **桥接设置项**：新增 `dsh.bridge.enabled`（默认 `true`）、`dsh.workspaceRootIndex`（默认 `0`）、`dsh.bridge.silenceWarning`（默认 `false`）。

### 移除

- **工作区自动同步**：移除打开面板时自动把 VS Code 工作区同步为 DSH 工作区的联动能力（用户决定放弃）。

### 修复

- **spawn 工作目录兜底**：自启 `dsh web` 时按 `dsh.workspaceRootIndex` 解析工作区根目录作为子进程工作目录，多根工作区不再错误落点。

### 降级与警告

- 桥接未生效时面板完全可用，仅两项联动不可用；插件启动时会弹一次降级警告，可「重试安装」或「不再提示」。

## [0.1.0] - 2026-08-15

### 新增

- DSH 网页界面在 VS Code 侧边栏内嵌显示，支持左右双侧栏入口。
- 服务自动探测 / 启动 / 复用与状态栏四态指示。
- 异常兜底提示页与一键重连、双语界面、退出清理、回环地址安全边界。
