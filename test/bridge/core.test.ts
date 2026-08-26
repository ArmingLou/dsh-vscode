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
