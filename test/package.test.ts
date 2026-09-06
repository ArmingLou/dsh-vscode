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

test('单面板收敛（v0.3.11）：主面板 dsh.panel 保留为唯一面板，副面板全套已移除', () => {
  const p = pkg();
  // 视图容器：只剩 activitybar dsh；secondarySidebar 容器 dsh-secondary 已移除
  assert.ok(Array.isArray(p.contributes.viewsContainers.activitybar), 'activitybar 容器保留');
  assert.equal(p.contributes.viewsContainers.activitybar.length, 1, '唯一容器');
  assert.equal(p.contributes.viewsContainers.activitybar[0].id, 'dsh');
  assert.equal(p.contributes.viewsContainers.secondarySidebar, undefined, 'secondarySidebar 容器已删除');
  // 视图：只剩 dsh.panel
  assert.deepEqual(Object.keys(p.contributes.views), ['dsh'], '视图组只剩主面板所在容器');
  const viewIds: string[] = p.contributes.views['dsh'].map((v: { id: string }) => v.id);
  assert.deepEqual(viewIds, ['dsh.panel'], '唯一视图 dsh.panel');
  assert.equal(p.contributes.views['dsh'][0].name, '%dsh.view.panel.name%');
  // 命令：openPanel 保留为唯一打开命令；openSecondary / openFromTitle（编辑器右上角按钮）已删除
  const cmdIds: string[] = p.contributes.commands.map((c: { command: string }) => c.command);
  assert.ok(cmdIds.includes('dsh.openPanel'), 'dsh.openPanel 保留为唯一打开命令');
  assert.ok(!cmdIds.includes('dsh.openSecondary'), 'dsh.openSecondary 已删除');
  assert.ok(!cmdIds.includes('dsh.openFromTitle'), 'dsh.openFromTitle 已删除');
  // 激活事件：副面板相关事件已移除，主面板事件保留
  assert.ok(p.activationEvents.includes('onView:dsh.panel'));
  assert.ok(p.activationEvents.includes('onCommand:dsh.openPanel'));
  assert.ok(!p.activationEvents.includes('onView:dsh.panel.secondary'));
  assert.ok(!p.activationEvents.includes('onCommand:dsh.openSecondary'));
  // editor/title 菜单已移除（右上角按钮入口随 openFromTitle 一并删除）
  assert.equal(p.contributes.menus['editor/title'], undefined, 'editor/title 菜单已删除');
  // 本地化键：副面板相关键移除、主面板键保留
  const nls = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.nls.json'), 'utf8'));
  const nlsZh = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.nls.zh-cn.json'), 'utf8'));
  assert.equal(nls['dsh.view.panel.name'], 'DSH Panel');
  assert.equal(nlsZh['dsh.view.panel.name'], 'DSH 面板');
  for (const key of ['dsh.view.panelSecondary.name', 'dsh.cmd.openSecondary.title', 'dsh.cmd.openFromTitle.title']) {
    assert.equal(nls[key], undefined, `en 不应含键 ${key}`);
    assert.equal(nlsZh[key], undefined, `zh-cn 不应含键 ${key}`);
  }
  // 右上角按钮专用图标资产已随入口删除
  assert.ok(!existsSync(join(__dirname, '..', '..', 'assets', 'whale-icon-bg.svg')), '白底鲸鱼图标文件已删除');
});

test('存在手动清理图片缓存命令 dsh.cleanupImageCache', () => {
  const p = pkg();
  const cmd = p.contributes.commands.find((c: { command: string }) => c.command === 'dsh.cleanupImageCache');
  assert.ok(cmd, '存在 dsh.cleanupImageCache 命令');
  assert.ok(String(cmd.title).includes('dsh.cmd.cleanupImageCache.title'), '命令标题走本地化');
  assert.ok(Array.isArray(p.activationEvents) && p.activationEvents.includes('onCommand:dsh.cleanupImageCache'), '需声明激活事件');
});

test('断开命令 dsh.disconnect：声明、面板标题栏菜单、激活事件齐全（单面板）', () => {
  const p = pkg();
  const cmd = p.contributes.commands.find((c: { command: string }) => c.command === 'dsh.disconnect');
  assert.ok(cmd, '存在 dsh.disconnect 命令');
  assert.equal(cmd.icon, '$(debug-disconnect)', '图标用 debug-disconnect');
  assert.ok(String(cmd.title).includes('dsh.cmd.disconnect.title'), '命令标题走本地化');
  assert.ok(Array.isArray(p.activationEvents) && p.activationEvents.includes('onCommand:dsh.disconnect'), '需声明激活事件');
  const vt: { command: string; when?: string; group?: string }[] = p.contributes.menus['view/title'] || [];
  const items = vt.filter((m) => m.command === 'dsh.disconnect');
  assert.equal(items.length, 1, '单个菜单项覆盖唯一面板');
  assert.equal(items[0].when, 'view == dsh.panel', 'when 只覆盖唯一面板 dsh.panel');
  assert.ok(String(items[0].group).startsWith('navigation'), '标题栏 navigation 组');
  // 与 Stop Service 并排：disconnect(navigation@3) 紧跟 stop(navigation@4) 之前
  const stopGroup = vt.find((m) => m.command === 'dsh.stop')?.group;
  assert.ok(stopGroup !== undefined && String(items[0].group) < String(stopGroup), '断开按钮应排在停止服务之前并排显示');
});

test('活动栏容器图标保持原始鲸鱼图标（assets/whale-icon.svg）', () => {
  const p = pkg();
  const containers = p.contributes.viewsContainers.activitybar;
  assert.ok(Array.isArray(containers) && containers.length === 1, '仅 activitybar 容器 dsh');
  assert.equal(containers[0].icon, 'assets/whale-icon.svg', '活动栏容器应保持原始鲸鱼图标');
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
