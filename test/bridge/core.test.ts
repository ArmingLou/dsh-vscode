// test/bridge/core.test.ts — 桥接纯逻辑单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedExternalUrl,
  buildOpenExternalMessage,
  buildOpenFileMessage,
  buildSyncWorkspaceAck,
  buildCopyTextMessage,
  buildCopyTextAck,
  isBridgeMessage,
  HANDSHAKE_TOKEN_KEY,
  getShortcutCommand,
  getShortcutCombo,
  canonicalizeCombo,
  normalizeShortcutMap,
  buildShortcutMessage,
  extractToolLinkPath,
  hasFileLinkClass,
  isDuplicateOrSelectionClick,
  resolveChangedRowClick,
  resolveFileClickPath,
  extractOpenPathRequest,
  isEditableElement,
  computeInsertedValue,
  buildReadTextMessage,
  buildReadTextAck,
} from '../../bridge-client/lib/core.js';

test('isAllowedExternalUrl 仅放行 http/https', () => {
  assert.equal(isAllowedExternalUrl('https://example.com/a'), true);
  assert.equal(isAllowedExternalUrl('http://127.0.0.1:3080/x'), true);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedExternalUrl(''), false);
});

test('buildOpenExternalMessage 构造消息', () => {
  assert.deepEqual(buildOpenExternalMessage('https://a.b/c'), { kind: 'openExternal', url: 'https://a.b/c' });
});

test('buildOpenFileMessage 携带可选 cwd', () => {
  assert.deepEqual(buildOpenFileMessage('src/main.ts', '/proj'), { kind: 'openFile', path: 'src/main.ts', cwd: '/proj' });
  assert.deepEqual(buildOpenFileMessage('/abs/a.ts', undefined), { kind: 'openFile', path: '/abs/a.ts' });
});

test('buildSyncWorkspaceAck 构造回执', () => {
  assert.deepEqual(buildSyncWorkspaceAck(true), { kind: 'bridgeAck', ok: true });
  assert.deepEqual(buildSyncWorkspaceAck(false, '/proj'), { kind: 'bridgeAck', ok: false, path: '/proj' });
});

test('buildCopyTextMessage / buildCopyTextAck 构造剪贴板桥接消息', () => {
  assert.deepEqual(buildCopyTextMessage('hello', 'req-1'), { kind: 'copyText', text: 'hello', requestId: 'req-1' });
  assert.deepEqual(buildCopyTextAck('req-1', true), { kind: 'copyTextAck', requestId: 'req-1', ok: true });
  assert.deepEqual(buildCopyTextAck('req-2', false), { kind: 'copyTextAck', requestId: 'req-2', ok: false });
});

test('isBridgeMessage 校验 token', () => {
  assert.equal(isBridgeMessage({ token: 't1' }, 't1'), true);
  assert.equal(isBridgeMessage({ token: 't2' }, 't1'), false);
  assert.equal(isBridgeMessage(null, 't1'), false);
});

test('常量取值正确', () => {
  assert.equal(HANDSHAKE_TOKEN_KEY, 'token');
});

// —— 标准编辑快捷键仿真（VS Code 吞掉 iframe 内 Cmd+C/V/A/X/Z 的修复） ——

test('getShortcutCommand 识别 mac/win 标准编辑快捷键', () => {
  // mac: metaKey
  assert.equal(getShortcutCommand({ key: 'c', metaKey: true }), 'copy');
  assert.equal(getShortcutCommand({ key: 'v', metaKey: true }), 'paste');
  assert.equal(getShortcutCommand({ key: 'x', metaKey: true }), 'cut');
  assert.equal(getShortcutCommand({ key: 'a', metaKey: true }), 'selectAll');
  assert.equal(getShortcutCommand({ key: 'z', metaKey: true }), 'undo');
  assert.equal(getShortcutCommand({ key: 'z', metaKey: true, shiftKey: true }), 'redo');
  // win/linux: ctrlKey
  assert.equal(getShortcutCommand({ key: 'C', ctrlKey: true }), 'copy');
  assert.equal(getShortcutCommand({ key: 'V', ctrlKey: true }), 'paste');
  // Shift+Insert（Windows 粘贴惯例）
  assert.equal(getShortcutCommand({ key: 'Insert', shiftKey: true }), 'paste');
  // 大小写不敏感
  assert.equal(getShortcutCommand({ key: 'C', metaKey: true }), 'copy');
  // 未命中：无修饰键、非编辑键、非法输入
  assert.equal(getShortcutCommand({ key: 'c' }), null);
  assert.equal(getShortcutCommand({ key: 'Enter', metaKey: true }), null);
  assert.equal(getShortcutCommand({ key: 'k', ctrlKey: true }), null);
  assert.equal(getShortcutCommand(null), null);
  assert.equal(getShortcutCommand(undefined), null);
  assert.equal(getShortcutCommand({}), null);
});

test('isEditableElement 只认可接收文本编辑的元素', () => {
  // textarea / text input / contenteditable 为可编辑
  assert.equal(isEditableElement({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: '' }), true); // type 缺省即 text
  assert.equal(isEditableElement({ tagName: 'DIV', isContentEditable: true }), true);
  // 非文本输入型 input 不可编辑
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'button' }), false);
  // 普通元素 / 空值 / 非对象
  assert.equal(isEditableElement({ tagName: 'DIV' }), false);
  assert.equal(isEditableElement(null), false);
  assert.equal(isEditableElement(undefined), false);
  assert.equal(isEditableElement('textarea'), false);
});

test('computeInsertedValue 在选区插入文本', () => {
  // 正常插入（前不着后不着）
  assert.equal(computeInsertedValue('hello world', 6, 11, 'VS Code'), 'hello VS Code');
  // 全选替换
  assert.equal(computeInsertedValue('hello', 0, 5, 'hi'), 'hi');
  // 空选区 = 光标处插入
  assert.equal(computeInsertedValue('ab', 1, 1, 'X'), 'aXb');
  // 选区顺序/越界归一
  assert.equal(computeInsertedValue('abc', 5, 2, 'X'), 'abcX');
  assert.equal(computeInsertedValue('abc', -1, 2, 'X'), 'Xc');
  // 非字符串值兜底
  assert.equal(computeInsertedValue(undefined, 0, 0, 'x'), 'x');
  assert.equal(computeInsertedValue(null, 0, 0, 'x'), 'x');
});

test('buildReadTextMessage / buildReadTextAck 构造剪贴板读取消息', () => {
  assert.deepEqual(buildReadTextMessage('req-1'), { kind: 'readText', requestId: 'req-1' });
  assert.deepEqual(buildReadTextAck('req-1', true, 'abc'), { kind: 'readTextAck', requestId: 'req-1', ok: true, text: 'abc' });
  // 读取失败：不带 text 字段
  assert.deepEqual(buildReadTextAck('req-2', false), { kind: 'readTextAck', requestId: 'req-2', ok: false });
  assert.deepEqual(buildReadTextAck('req-3', true, ''), { kind: 'readTextAck', requestId: 'req-3', ok: false });
});

// —— v0.3.2 桥接快捷键转发（VS Code 吞掉 iframe 内组合键的修复） ——

test('getShortcutCombo 生成规范组合键（e.code 优先、布局无关）', () => {
  assert.equal(getShortcutCombo({ key: '1', code: 'Digit1', metaKey: true }), 'cmd+1');
  assert.equal(getShortcutCombo({ key: '2', code: 'Digit2', metaKey: true }), 'cmd+2');
  assert.equal(getShortcutCombo({ key: '3', code: 'Digit3', ctrlKey: true }), 'ctrl+3');
  // 反引号键：中文输入法下 key 可能是 '·'，code 恒为 Backquote → 归一为 cmd+`
  assert.equal(getShortcutCombo({ key: '`', code: 'Backquote', metaKey: true }), 'cmd+`');
  assert.equal(getShortcutCombo({ key: '·', code: 'Backquote', metaKey: true }), 'cmd+`');
  // Esc / 组合修饰键 / 无 code 回退 key
  assert.equal(getShortcutCombo({ key: 'Escape', code: 'Escape', metaKey: true }), 'cmd+escape');
  assert.equal(getShortcutCombo({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true }), 'cmd+shift+z');
  assert.equal(getShortcutCombo({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true }), 'ctrl+shift+f');
  assert.equal(getShortcutCombo({ key: 'F2', code: 'F2', altKey: true }), 'alt+f2');
  assert.equal(getShortcutCombo({ key: 'k', metaKey: true }), 'cmd+k'); // 测试桩无 code：回退 key
  // 无修饰键（普通按键/页面自身快捷键）不参与转发
  assert.equal(getShortcutCombo({ key: 'a', code: 'KeyA' }), null);
  assert.equal(getShortcutCombo({ key: 'Escape', code: 'Escape' }), null);
  // 非法输入
  assert.equal(getShortcutCombo(null), null);
  assert.equal(getShortcutCombo(undefined), null);
  assert.equal(getShortcutCombo({}), null);
});

test('canonicalizeCombo 归一化配置的组合键写法', () => {
  assert.equal(canonicalizeCombo('cmd+1'), 'cmd+1');
  assert.equal(canonicalizeCombo('CMD + Esc'), 'cmd+escape');
  assert.equal(canonicalizeCombo('Cmd+`'), 'cmd+`');
  assert.equal(canonicalizeCombo('ctrl+shift+f '), 'ctrl+shift+f');
  assert.equal(canonicalizeCombo('meta+1'), 'cmd+1'); // meta → cmd
  assert.equal(canonicalizeCombo('option+1'), 'alt+1'); // option → alt
  assert.equal(canonicalizeCombo('cmd+backtick'), 'cmd+`');
  assert.equal(canonicalizeCombo('cmd+f2'), 'cmd+f2');
  // 无修饰键 / 重复按键 / 未知键名 / 非字符串 → null
  assert.equal(canonicalizeCombo('1'), null);
  assert.equal(canonicalizeCombo(''), null);
  assert.equal(canonicalizeCombo('cmd+'), null);
  assert.equal(canonicalizeCombo('cmd++'), null);
  assert.equal(canonicalizeCombo('cmd+1+2'), null);
  assert.equal(canonicalizeCombo('cmd+wat'), null);
  assert.equal(canonicalizeCombo(null), null);
  assert.equal(canonicalizeCombo(42), null);
});

test('normalizeShortcutMap 只保留合法条目并归一化键名', () => {
  assert.deepEqual(
    normalizeShortcutMap({ 'cmd+esc': 'workbench.action.x', 'CMD+1': 'workbench.action.y', 'ctrl+shift+f': 'workbench.action.z' }),
    { 'cmd+escape': 'workbench.action.x', 'cmd+1': 'workbench.action.y', 'ctrl+shift+f': 'workbench.action.z' },
  );
  // 非法条目（无修饰键、空命令、非字符串值、非对象）一律丢弃
  assert.deepEqual(normalizeShortcutMap({ 'cmd+1': '', '1': 'x', 'cmd+wat': 'y', 42: 'z' }), {});
  assert.deepEqual(normalizeShortcutMap(null), {});
  assert.deepEqual(normalizeShortcutMap('x'), {});
  assert.deepEqual(normalizeShortcutMap([1, 2]), {});
});

test('buildShortcutMessage 构造转发消息', () => {
  assert.deepEqual(buildShortcutMessage('cmd+1', '1', 'Digit1'), { kind: 'shortcut', combo: 'cmd+1', key: '1', code: 'Digit1' });
  assert.deepEqual(buildShortcutMessage('cmd+escape'), { kind: 'shortcut', combo: 'cmd+escape', key: '', code: '' });
});

// —— v0.3.2 工具调用行（ToolRow）文件链接路径提取 ——

test('extractToolLinkPath 从工具行按钮文本提取路径', () => {
  // 带「工具名 · 」前缀（用户看到的 read· test/bridge/interceptor.test.ts 形态）
  assert.equal(extractToolLinkPath('read · test/bridge/interceptor.test.ts'), 'test/bridge/interceptor.test.ts');
  assert.equal(extractToolLinkPath('read·test/bridge/interceptor.test.ts'), 'test/bridge/interceptor.test.ts');
  assert.equal(extractToolLinkPath('write · src/main.ts'), 'src/main.ts');
  assert.equal(extractToolLinkPath('bash · scripts/build.mjs'), 'scripts/build.mjs');
  // 无前缀：直接是路径（相对 / 绝对 / ~ 缩写 / Windows 盘符）
  assert.equal(extractToolLinkPath('test/bridge/interceptor.test.ts'), 'test/bridge/interceptor.test.ts');
  assert.equal(extractToolLinkPath('/ws/src/main.ts'), '/ws/src/main.ts');
  assert.equal(extractToolLinkPath('~/proj/a.ts'), '~/proj/a.ts');
  assert.equal(extractToolLinkPath('C:\\proj\\b.ts'), 'C:\\proj\\b.ts');
  // 包裹引号
  assert.equal(extractToolLinkPath('read · "/ws/a b.ts"'), '/ws/a b.ts');
  // 非路径形态：空 / 无分隔符（callId、图标按钮、inspect 按钮文案）→ 不处理
  assert.equal(extractToolLinkPath(''), '');
  assert.equal(extractToolLinkPath('   '), '');
  assert.equal(extractToolLinkPath('call-123'), '');
  assert.equal(extractToolLinkPath('查看轨迹'), '');
  assert.equal(extractToolLinkPath('read · call-123'), '', '去掉前缀后无路径分隔符 → 不处理');
  // 非字符串输入
  assert.equal(extractToolLinkPath(null), '');
  assert.equal(extractToolLinkPath(undefined), '');
  assert.equal(extractToolLinkPath(42), '');
});

// —— dsh 0.1.7 回归：文件链接类名从裸类名改为 CSS Modules 哈希类名 ——
test('hasFileLinkClass 兼容裸类名与 CSS Modules 哈希类名', () => {
  // 旧版 dsh：裸类名（原实现用 classList.contains('fileMention') 能命中）
  assert.equal(hasFileLinkClass('fileMention'), true);
  assert.equal(hasFileLinkClass('fileLink'), true);
  // 新版 dsh：CSS Modules 哈希类名（本地名作为子串保留，原来的 contains 判断失效 → 回归根因）
  assert.equal(hasFileLinkClass('_fileMention_1jct6_85 _fileLink_1jct6_59'), true);
  assert.equal(hasFileLinkClass('_fileMention_1jct6_85'), true);
  assert.equal(hasFileLinkClass('o3BgMG_fileLink'), true); // 前缀哈希形态（非下划线开头）
  // 大小写不敏感
  assert.equal(hasFileLinkClass('FILEMENTION'), true);
  // 非文件链接类名：不命中（避免误拦其它按钮）
  assert.equal(hasFileLinkClass('_linkIcon_1jct6_94 _markdown_1jct6_5'), false);
  assert.equal(hasFileLinkClass('_cardPreview_nyYjTG_1'), false);
  assert.equal(hasFileLinkClass(''), false);
  assert.equal(hasFileLinkClass(null), false);
  assert.equal(hasFileLinkClass(undefined), false);
  assert.equal(hasFileLinkClass(42), false);
});

test('resolveFileClickPath 兼容新旧版文件链接 DOM 形态，并放行非文件点击', () => {
  // ① 新版 markdown 文件链接：哈希类名 + 相对路径 title（旧实现 classList.contains 失效 → 回归）
  assert.equal(
    resolveFileClickPath({ className: '_fileMention_1jct6_85 _fileLink_1jct6_59', title: 'src/a.ts', text: 'a.ts' }),
    'src/a.ts',
  );
  // ② 旧版裸类名 + 绝对路径 title：必须继续兼容
  assert.equal(resolveFileClickPath({ className: 'fileMention', title: '/ws/src/main.ts' }), '/ws/src/main.ts');
  // ③ 无类名的产物卡片（title 绝对路径）继续兼容
  assert.equal(resolveFileClickPath({ className: '_cardPreview_1', title: '/ws/out/a.log' }), '/ws/out/a.log');
  // ④ @文件 引用芯片：data-ref-chip="file" + title 带 @ 前缀（可含引号包裹的空格路径）
  assert.equal(resolveFileClickPath({ refChip: 'file', title: '@src/a.ts' }), 'src/a.ts');
  assert.equal(resolveFileClickPath({ refChip: 'file', title: '@"docs/a b.md"' }), 'docs/a b.md');
  // ⑤ 非 file 引用芯片（folder/skill/session）：不得误拦（技能芯片 title=/skill 形似路径）
  assert.equal(resolveFileClickPath({ refChip: 'skill', className: '_fileMention_1jct6_85', title: '/skill' }), '');
  assert.equal(resolveFileClickPath({ refChip: 'folder', className: '_refChip_1', title: '@docs/' }), '');
  // ⑥ 行号锚点剥离（扩展侧 showTextDocument 只接受路径）
  assert.equal(resolveFileClickPath({ className: '_fileLink_1jct6_59', title: '/ws/src/b.ts#L12-L20' }), '/ws/src/b.ts');
  // ⑦ 普通按钮：不返回路径（调用方据此放行原事件，不 preventDefault）
  assert.equal(resolveFileClickPath({ className: '_button_1', title: '复制代码', text: '复制' }), '');
  assert.equal(resolveFileClickPath({}), '');
  assert.equal(resolveFileClickPath(null), '');
});

test('extractOpenPathRequest 按 0.1.7 真实线格式接管（slash 端点 + payload.args.request）', () => {
  // 0.1.7 真实请求体：信封 {type:'client-request', rpcId, method, payload}（dsh-client-connection）；
  // payload.args 是「按参数 wire 名索引的普通对象」，openWorkspacePath 的参数 wire 名为 request。
  const wire = (method: string, args: unknown) => ({
    type: 'client-request',
    rpcId: 'rpc-1',
    method,
    payload: { args },
  });

  // ① 默认应用打开 → 接管并转发扩展宿主（扩展侧换成 showTextDocument）
  assert.equal(
    extractOpenPathRequest(wire('session/openWorkspacePath', { request: { path: '/ws/a.ts' } })),
    '/ws/a.ts',
    'slash 端点 + args.request.path 是 0.1.7 现行形态，必须命中',
  );
  // ② 用户有意的「离开编辑器」动作 → 放行给 DSH
  assert.equal(
    extractOpenPathRequest(wire('session/openWorkspacePath', { request: { path: '/ws/a.ts', action: 'reveal' } })),
    '',
    'action=reveal（在文件管理器显示）必须放行',
  );
  assert.equal(
    extractOpenPathRequest(wire('session/openWorkspacePath', { request: { path: '/ws/a.ts', application: '/Applications/X.app' } })),
    '',
    '显式 application（指定应用打开）必须放行',
  );
  // ③ 防御形态：位置数组 args[0]（DSH 若改回位置参数仍能命中）
  assert.equal(extractOpenPathRequest(wire('session/openWorkspacePath', [{ path: '/ws/b.ts' }])), '/ws/b.ts');
  // ④ 其它端点 / 非法形状 → 放行
  assert.equal(extractOpenPathRequest(wire('session/page', { request: { path: '/ws/a.ts' } })), '');
  assert.equal(extractOpenPathRequest(wire('session/openWorkspacePath', {})), '');
  assert.equal(extractOpenPathRequest(wire('session/openWorkspacePath', { request: {} })), '');
  assert.equal(
    extractOpenPathRequest({ type: 'client-request', rpcId: 'r', method: 'session.openWorkspacePath', payload: { path: '/ws/a.ts' } }),
    '',
    '0.1.7 无线协议不存在点号形态（endpointOf = namespace/method），不得误判命中',
  );
  assert.equal(extractOpenPathRequest(null), '');
  assert.equal(extractOpenPathRequest({}), '');
});

test('extractOpenPathRequest 兼容 dsh ≤0.1.0-rc.6 旧点号协议（host.openPath + payload.path）', () => {
  assert.equal(
    extractOpenPathRequest({ type: 'client-request', rpcId: 'rpc-old', method: 'host.openPath', payload: { path: '/ws/old.ts' } }),
    '/ws/old.ts',
    'rc6 点号形态必须继续兼容（0.1.7 已无该端点，仅为旧版兜底）',
  );
  assert.equal(extractOpenPathRequest({ method: 'host.openPath', payload: {} }), '');
  assert.equal(extractOpenPathRequest({ method: 'host.openPath' }), '');
});

test('resolveChangedRowClick 拦截「改动」卡片文件行：作用域 + aria-describedby 双重限定', () => {
  // ① 正常命中：隐藏 span 给的是已解析绝对路径
  assert.equal(
    resolveChangedRowClick({ inChangedCard: true, describedBy: ':r5q:-0', describedPath: '/ws/src/bridge/host.ts', rowText: 'src/bridge/host.ts' }),
    '/ws/src/bridge/host.ts',
  );
  // ② cwd 缺失：隐藏 span 退回相对路径，照样取用（交宿主侧多基准解析）
  assert.equal(
    resolveChangedRowClick({ inChangedCard: true, describedBy: ':r1:-0', describedPath: 'src/a.ts', rowText: 'a.ts' }),
    'src/a.ts',
  );
  // ③ 被 describedBy 指向的文本不是路径（或元素不存在 → describedPath 为空）→ 回退 row 首个子 span 文本
  assert.equal(
    resolveChangedRowClick({ inChangedCard: true, describedBy: ':r1:-0', describedPath: '3 files changed', rowText: 'src/b.ts' }),
    'src/b.ts',
  );
  assert.equal(
    resolveChangedRowClick({ inChangedCard: true, describedBy: ':r1:-0', describedPath: '', rowText: 'src/c.ts' }),
    'src/c.ts',
    'getElementById 返回 null（describedPath 空）时回退 row 文本',
  );
  // ④ 两者都不形似路径 → 不拦（调用方放行原事件），且不抛错
  assert.equal(resolveChangedRowClick({ inChangedCard: true, describedBy: ':r1:-0', describedPath: '3 个文件', rowText: '+67 -10' }), '');
  assert.equal(resolveChangedRowClick({ inChangedCard: true, describedBy: ':r1:-0' }), '');
  assert.equal(resolveChangedRowClick(null), '');
  assert.equal(resolveChangedRowClick({}), '');
});

test('resolveChangedRowClick 排除误拦面：卡片 header / 折叠按钮 / 侧栏 review tab / 非改动行', () => {
  // a) header 按钮（「打开整轮 review」）：无 aria-describedby → 不拦
  assert.equal(
    resolveChangedRowClick({ inChangedCard: true, describedBy: '', describedPath: '', rowText: 'src/a.ts' }),
    '',
    'header 按钮没有 aria-describedby，即使文本形似路径也不得拦',
  );
  // 折叠按钮同理（同样没有 aria-describedby）
  assert.equal(resolveChangedRowClick({ inChangedCard: true, describedBy: '', rowText: 'src/a.ts' }), '');
  // b) 侧栏 review tab 内的文件行：不在 [data-changed-files] 作用域内 → 不拦
  assert.equal(
    resolveChangedRowClick({ inChangedCard: false, describedBy: ':r1:-0', describedPath: '/ws/src/a.ts', rowText: 'src/a.ts' }),
    '',
    '侧栏 review tab 的行语义是切换预览，必须放行',
  );
  assert.equal(resolveChangedRowClick({ describedBy: ':r1:-0', describedPath: '/ws/src/a.ts' }), '');
  // c) hover 预览是 span 而非 button：DOM 层只对 [data-changed-files] button 取属性，纯函数无从参与
  //    （该项由 interceptor 用例断言；这里只需确认「未在改动卡片内的元素」一律返回 ''）
  assert.equal(resolveChangedRowClick({ inChangedCard: true, describedBy: '   ', describedPath: '/ws/a.ts' }), '');
});

test('isDuplicateOrSelectionClick 照抄 DSH 原生守卫（多击 / 未折叠选区）', () => {
  const sel = (isCollapsed: boolean) => ({ isCollapsed });
  // 单击 + 无选区/折叠选区（光标）→ 应接管
  assert.equal(isDuplicateOrSelectionClick({ detail: 1 }, null), false);
  assert.equal(isDuplicateOrSelectionClick({ detail: 1 }, sel(true)), false, '折叠选区（光标）不拦截');
  // 双击/多击 → 放行（原生 `detail > 1` 直接 return）
  assert.equal(isDuplicateOrSelectionClick({ detail: 2 }, null), true);
  assert.equal(isDuplicateOrSelectionClick({ detail: 3 }, sel(true)), true);
  // 存在未折叠选区时的单击（拖选收尾误触）→ 放行
  assert.equal(isDuplicateOrSelectionClick({ detail: 1 }, sel(false)), true);
  // detail === 0（程序化点击）：原生不套用选区判定
  assert.equal(isDuplicateOrSelectionClick({ detail: 0 }, sel(false)), false);
  // detail 非数字（合成事件缺字段）：按 0 处理，不误拦
  assert.equal(isDuplicateOrSelectionClick({}, sel(false)), false);
  assert.equal(isDuplicateOrSelectionClick(null, sel(false)), false);
});
