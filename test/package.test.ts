// test/package.test.ts — package.json 静态贡献与设置的回归校验（v0.3.0）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function pkg() {
  return JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
}

test('extensionKind 优先 workspace（远程场景跑在远端）', () => {
  const p = pkg();
  assert.ok(Array.isArray(p.extensionKind));
  assert.equal(p.extensionKind[0], 'workspace');
});

test('右上角图标命令与 editor/title 菜单（v0.3.0）', () => {
  const p = pkg();
  const cmd = p.contributes.commands.find((c: { command: string }) => c.command === 'dsh.openFromTitle');
  assert.ok(cmd, '存在 dsh.openFromTitle 命令');
  // 右上角图标：原鲸鱼 + 白底（明暗主题都清晰可见），不再用明暗双主题变体
  assert.equal(cmd.icon, 'assets/whale-icon-bg.svg', '右上角命令图标应为白底鲸鱼');
  assert.ok(existsSync(join(__dirname, '..', '..', 'assets', 'whale-icon-bg.svg')), '白底鲸鱼图标文件应存在');
  const bg = readFileSync(join(__dirname, '..', '..', 'assets', 'whale-icon-bg.svg'), 'utf8');
  assert.ok(bg.includes('#FFFFFF'), '白底图标应含白色背景');
  assert.ok(bg.includes('#000000'), '白底图标应保留原黑色鲸鱼路径');
  const menu: { command: string; group?: string }[] = p.contributes.menus['editor/title'] || [];
  const item = menu.find((m) => m.command === 'dsh.openFromTitle');
  assert.ok(item, 'editor/title 菜单包含该命令');
  assert.ok(String(item.group).startsWith('navigation'), '组为 navigation（标签栏右侧图标区）');
});

test('存在手动清理图片缓存命令 dsh.cleanupImageCache', () => {
  const p = pkg();
  const cmd = p.contributes.commands.find((c: { command: string }) => c.command === 'dsh.cleanupImageCache');
  assert.ok(cmd, '存在 dsh.cleanupImageCache 命令');
  assert.ok(String(cmd.title).includes('dsh.cmd.cleanupImageCache.title'), '命令标题走本地化');
  assert.ok(Array.isArray(p.activationEvents) && p.activationEvents.includes('onCommand:dsh.cleanupImageCache'), '需声明激活事件');
});

test('活动栏/辅助侧边栏容器图标保持原始鲸鱼图标（assets/whale-icon.svg）', () => {
  const p = pkg();
  for (const container of [...p.contributes.viewsContainers.activitybar, ...p.contributes.viewsContainers.secondarySidebar]) {
    assert.equal(container.icon, 'assets/whale-icon.svg', container.id + ' 应保持原始鲸鱼图标');
  }
  assert.ok(existsSync(join(__dirname, '..', '..', 'assets', 'whale-icon.svg')), '原始鲸鱼图标文件应存在');
});

test('v0.3.0 设置项：remote.enabled 默认 false、image.fallback 默认 true、openInBrowser 默认 false', () => {
  const p = pkg();
  const props = p.contributes.configuration.properties;
  assert.equal(props['dsh.remote.enabled'].default, false);
  assert.equal(props['dsh.image.fallback'].default, true);
  assert.equal(props['dsh.openInBrowser'].default, false);
});

test('v0.3.2 设置项：bridge.shortcuts 默认包含用户要求的组合键', () => {
  const p = pkg();
  const prop = p.contributes.configuration.properties['dsh.bridge.shortcuts'];
  assert.ok(prop, '存在 dsh.bridge.shortcuts 设置');
  assert.equal(prop.type, 'object');
  assert.ok(prop.additionalProperties && prop.additionalProperties.type === 'string', '值为 VS Code 命令 id 字符串');
  const def = prop.default;
  assert.equal(def['cmd+1'], 'workbench.action.toggleAuxiliaryBar');
  assert.equal(def['cmd+2'], 'workbench.action.togglePanel');
  assert.equal(def['cmd+3'], 'workbench.action.toggleSidebarVisibility');
  assert.equal(def['cmd+escape'], 'workbench.action.toggleMaximizedPanel');
  assert.equal(def['cmd+`'], undefined, '反引号键未内置默认映射');
  assert.equal(def['ctrl+1'], 'workbench.action.toggleAuxiliaryBar');
});

test('桥接版本与插件版本统一（一同随包发布），且卸载钩子自动清理桥接', () => {
  const p = pkg();
  // ① 卸载钩子：VS Code 卸载扩展时执行 node ./out/uninstall.js
  assert.equal(p.uninstall, 'node ./out/uninstall.js', 'package.json 应声明 uninstall 钩子');
  // ② 版本统一：bridge-client 版本 === 插件版本（防止日后漂移）
  const bridge = JSON.parse(readFileSync(join(__dirname, '..', '..', 'bridge-client', 'package.json'), 'utf8'));
  assert.equal(bridge.version, p.version, '桥接包版本必须与插件版本一致（一同被上传到商城）');
  // ③ 握手诊断日志随版本号（DevTools 排查依据；client.js 用 BRIDGE_VERSION 常量拼接）
  const client = readFileSync(join(__dirname, '..', '..', 'bridge-client', 'lib', 'client.js'), 'utf8');
  assert.ok(client.includes('const BRIDGE_VERSION = "' + p.version + '";'), 'client.js 应声明 BRIDGE_VERSION = ' + p.version);
  assert.ok(client.includes('ok, v" + BRIDGE_VERSION'), '握手日志应使用 BRIDGE_VERSION 常量拼接');
  assert.ok(client.includes('buildSyncWorkspaceAck(true, undefined, BRIDGE_VERSION)'), '握手回执应携带桥接版本');
  // ④ 构建产物应包含卸载脚本（build.mjs 在两种模式下都会构建 out/uninstall.js）
  assert.ok(existsSync(join(__dirname, '..', 'uninstall.js')), '构建产物应包含 out/uninstall.js');
});
