// test/bridge/host.test.ts — 桥接消息处理与路径解析单测
// 覆盖：resolveBridgePath 的绝对/相对/危险协议分支；handleBridgeMessage 的外链白名单
// 转发、危险协议拒绝、文件跳转路径解析、打开失败与路径无法解析的用户提示。
// 生产侧接 vscode API，这里注入假实现验证纯逻辑（showWarning 一并注入以断言提示文案）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBridgePath, handleBridgeMessage, saveImageToCwd, deleteImageFiles, cleanupAllImageCaches, cleanupStaleImageCaches, createImageRegistry } from '../../src/bridge/host';

test('resolveBridgePath 处理绝对/相对/危险协议', () => {
  // 绝对路径直接采用（忽略 cwd 与工作区根）
  assert.deepEqual(resolveBridgePath('/a/b.ts', undefined, '/proj'), { kind: 'abs', path: '/a/b.ts' });
  // 相对路径优先按会话 cwd 解析（工作区根不同也不影响）
  assert.deepEqual(resolveBridgePath('src/main.ts', '/proj', '/other'), { kind: 'abs', path: '/proj/src/main.ts' });
  // 会话 cwd 缺失时回退工作区根
  assert.deepEqual(resolveBridgePath('src/main.ts', undefined, '/proj'), { kind: 'abs', path: '/proj/src/main.ts' });
  // 无任何基准的相对路径：无法解析
  assert.deepEqual(resolveBridgePath('..\\evil.ts', undefined, undefined), { kind: 'invalid' });
  // 协议串（URL）：一律拒绝
  assert.deepEqual(resolveBridgePath('https://x.com/a', undefined, '/proj'), { kind: 'invalid' });
});

test('resolveBridgePath 展开 ~ 主目录缩写（DSH 工具行路径显示形态）', () => {
  const { homedir } = require('node:os');
  const home = homedir();
  // ~/x → <homedir>/x（绝对路径，与 cwd/工作区根无关）
  assert.deepEqual(resolveBridgePath('~/proj/a.ts', undefined, '/proj'), { kind: 'abs', path: home + '/proj/a.ts' });
  // 单独的 ~ → 主目录本身
  assert.deepEqual(resolveBridgePath('~', undefined, '/proj'), { kind: 'abs', path: home });
  // 非 ~ 开头的路径不受影响
  assert.deepEqual(resolveBridgePath('src/main.ts', '/proj', undefined), { kind: 'abs', path: '/proj/src/main.ts' });
  // 仅 ~/ 与 ~ 两种形态展开；~user 形式（DSH 不会产出）不特殊处理
  assert.deepEqual(resolveBridgePath('~user/x.ts', undefined, undefined), { kind: 'invalid' });
});

test('handleBridgeMessage 转发 openExternal 到外部浏览器', async () => {
  // 记录被转发的 URL，验证 http/https 外链原样透传
  const calls: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'https://a.b' }, {
    openExternal: async (u) => { calls.push(u); return true; },
    openTextDocument: async () => {},
    showWarning: () => {},
  });
  assert.deepEqual(calls, ['https://a.b']);
});

test('handleBridgeMessage 拒绝危险协议的 openExternal', async () => {
  // javascript: 协议不允许走 openExternal（纵深防御，即使桥接侧已过滤）
  let called = false;
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'javascript:alert(1)' }, {
    openExternal: async () => { called = true; return true; },
    openTextDocument: async () => {},
    showWarning: () => {},
  });
  assert.equal(called, false);
});

test('handleBridgeMessage openExternal 抛错时提示用户', async () => {
  // 假 openExternal 抛错 → 应调用 showWarning（文案含 URL 与错误摘要），且不抛未处理异常
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'https://a.b/c' }, {
    openExternal: async () => { throw new Error('no default browser'); },
    openTextDocument: async () => {},
    showWarning: (m) => { warnings.push(m); },
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('https://a.b/c'), `提示应含链接，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('no default browser'), `提示应含错误摘要，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 调用打开文档', async () => {
  // 相对路径 + cwd → 解析为绝对路径后交给 openTextDocument
  const opened: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'src/main.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { opened.push(p); },
    showWarning: () => {},
    workspaceRoot: '/proj',
  });
  assert.deepEqual(opened, ['/proj/src/main.ts']);
});

test('handleBridgeMessage openFile 打开失败时提示用户', async () => {
  // 假 openTextDocument 抛错 → 应调用 showWarning，文案含解析后的路径与错误摘要，且不抛未处理异常
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'missing.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async () => { throw new Error('ENOENT: no such file'); },
    showWarning: (m) => { warnings.push(m); },
    workspaceRoot: '/proj',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('/proj/missing.ts'), `提示应含路径，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('ENOENT'), `提示应含错误摘要，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 路径无法解析时提示用户', async () => {
  // 危险协议（无基准可解析）→ invalid 分支应调用 showWarning（替代原 vscode 硬编码告警）
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'https://x.com/a' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: (m) => { warnings.push(m); },
    workspaceRoot: '/proj',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('https://x.com/a'), `提示应含原始路径，实际：${warnings[0]}`);
});
// —— v0.3.0 图片缓存落盘/删除（路径安全） ——
test('saveImageToCwd：合法写入并登记，返回绝对路径', async () => {
  const written: string[] = [];
  const reg = createImageRegistry();
  const ok = await saveImageToCwd(
    { writeFile: async (p: string, _b: string) => { written.push(p); }, rmFile: async () => {} },
    { cwd: '/ws', name: 'dsh-imgcache-a-0.png', dataB64: 'AAAA' },
    reg,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.path, '/ws/dsh-imgcache-a-0.png');
  assert.equal(written.length, 1);
  assert.ok(reg.has('/ws/dsh-imgcache-a-0.png'), '落盘后登记进注册表');
});

test('saveImageToCwd：无 cwd/相对 cwd/穿越文件名/非法扩展名/空数据一律拒绝且不写入', async () => {
  const written: string[] = [];
  const deps = { writeFile: async (p: string) => { written.push(p); }, rmFile: async () => {} };
  assert.equal((await saveImageToCwd(deps, { cwd: undefined, name: 'dsh-imgcache-a-0.png', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: 'rel/ws', name: 'dsh-imgcache-a-0.png', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: '/ws', name: '../dsh-imgcache-a-0.png', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: '/ws', name: 'dsh-imgcache-a-0.exe', dataB64: 'x' })).ok, false);
  assert.equal((await saveImageToCwd(deps, { cwd: '/ws', name: 'dsh-imgcache-a-0.png', dataB64: '' })).ok, false);
  assert.equal(written.length, 0, '任何拒绝都不落盘');
});

test('cleanupAllImageCaches：全量删除注册表内所有缓存路径并清空', async () => {
  const reg = createImageRegistry();
  reg.add('/ws/dsh-imgcache-a-0.png');
  reg.add('/ws/dsh-imgcache-a-1.jpg');
  const deleted: string[] = [];
  const deps = { writeFile: async () => {}, rmFile: async (p: string) => { deleted.push(p); } };
  await cleanupAllImageCaches(deps, reg);
  assert.deepEqual(deleted.sort(), ['/ws/dsh-imgcache-a-0.png', '/ws/dsh-imgcache-a-1.jpg']);
  assert.equal(reg.all().length, 0, '清理后注册表应清空');
});

test('cleanupStaleImageCaches：按目录扫描只删 dsh-imgcache-* 白名单孤儿，不依赖注册表', async () => {
  const removed: string[] = [];
  // 目录里既有我们的临时图，也有用户自己的文件；只删 dsh-imgcache-* 白名单
  const n = await cleanupStaleImageCaches(
    async () => ['dsh-imgcache-1710000000-0.png', 'dsh-imgcache-1710000000-1.jpg', 'README.md', 'photo.png', 'dsh-imgcache-1710000000-2.exe'],
    async (p: string) => { removed.push(p); },
    ['/ws/root', 'not-absolute', ''],
  );
  assert.equal(n, 2);
  assert.deepEqual(removed.sort(), ['/ws/root/dsh-imgcache-1710000000-0.png', '/ws/root/dsh-imgcache-1710000000-1.jpg']);
  // 目录不可读（readDir 抛错）→ 跳过，不影响删除计数
  const n2 = await cleanupStaleImageCaches(async () => { throw new Error('ENOENT'); }, async () => {}, ['/missing']);
  assert.equal(n2, 0);
});

test('deleteImageFiles：只删除注册表中的缓存文件，任意路径被忽略', async () => {
  const reg = createImageRegistry();
  reg.add('/ws/dsh-imgcache-a-0.png');
  const deleted: string[] = [];
  const deps = { writeFile: async () => {}, rmFile: async (p: string) => { deleted.push(p); } };
  await deleteImageFiles(deps, { paths: ['/ws/dsh-imgcache-a-0.png', '/ws/user.txt', '/etc/passwd'] }, reg);
  assert.deepEqual(deleted, ['/ws/dsh-imgcache-a-0.png'], '只删注册过的缓存文件');
  assert.ok(!reg.has('/ws/dsh-imgcache-a-0.png'), '删除后移出注册表');
});

test('handleBridgeMessage bridgeSaveImage：无 sessionCwd 时回退到 workspaceRoot', async () => {
  const acks: unknown[] = [];
  await handleBridgeMessage({ type: 'bridgeSaveImage', requestId: 's9', name: 'dsh-imgcache-a-0.png', dataB64: 'AAAA' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: () => {},
    workspaceRoot: '/root',
    writeFile: async () => {},
    rmFile: async () => {},
    reply: async (m: unknown) => { acks.push(m); },
  });
  assert.equal(acks.length, 1);
  assert.equal((acks[0] as { type: string; ok: boolean; path: string }).path, '/root/dsh-imgcache-a-0.png');
});

test('handleBridgeMessage 处理 bridgeSaveImage：回执 saveImageAck（ok+path）', async () => {
  const acks: unknown[] = [];
  await handleBridgeMessage({ type: 'bridgeSaveImage', requestId: 's1', name: 'dsh-imgcache-a-0.png', dataB64: 'AAAA', sessionCwd: '/ws' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: () => {},
    writeFile: async () => {},
    rmFile: async () => {},
    reply: async (m: unknown) => { acks.push(m); },
  });
  assert.equal(acks.length, 1);
  const a = acks[0] as { type: string; ok: boolean; path: string };
  assert.equal(a.type, 'bridgeSaveImageAck');
  assert.equal(a.ok, true);
  assert.equal(a.path, '/ws/dsh-imgcache-a-0.png');
});

test('handleBridgeMessage 处理 bridgeDeleteImages：回执 deleteImagesAck', async () => {
  const acks: unknown[] = [];
  await handleBridgeMessage({ type: 'bridgeDeleteImages', requestId: 'd1', paths: [] }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    showWarning: () => {},
    writeFile: async () => {},
    rmFile: async () => {},
    reply: async (m: unknown) => { acks.push(m); },
  });
  assert.equal(acks.length, 1);
  assert.equal((acks[0] as { type: string }).type, 'bridgeDeleteImagesAck');
  assert.equal((acks[0] as { ok: boolean }).ok, true);
});

// —— v0.3.25：相对路径多基准解析（DSH 会话 cwd 优先 → VS Code 各工作区根）——
// 背景（用户实测）：DSH 会话 cwd 在 A 仓库（如 /Users/.../suansuan/suansuan），
// VS Code 窗口工作区根在 B 仓库（dsh-vscode），点 `docs/x.md` 被拼到 B 仓库 → 报 nonexistent。
test('v0.3.25 相对路径多基准：按候选顺序取第一个真实存在的文件', () => {
  // ① 会话 cwd 命中优先：即便工作区根下也有同名文件，也必须用会话 cwd（DSH 原生语义基准）
  assert.deepEqual(
    resolveBridgePath('docs/a.md', '/sess', '/ws', {
      sessionCwds: ['/sess'],
      workspaceRoots: ['/ws'],
      exists: (p) => p === '/sess/docs/a.md' || p === '/ws/docs/a.md',
    }),
    { kind: 'abs', path: '/sess/docs/a.md' },
  );
  // ② 会话 cwd 落空 → 命中第二个工作区根（多根工作区逐个尝试）
  assert.deepEqual(
    resolveBridgePath('docs/a.md', undefined, '/ws1', {
      workspaceRoots: ['/ws1', '/ws2'],
      exists: (p) => p === '/ws2/docs/a.md',
    }),
    { kind: 'abs', path: '/ws2/docs/a.md' },
  );
  // ③ 用户真实场景：DSH 会话 cwd 在另一个仓库，工作区根里没有该文件
  assert.deepEqual(
    resolveBridgePath('docs/global_free_app_configs_override_guide.md', undefined, '/vs-root', {
      sessionCwds: ['/other/repo'],
      exists: (p) => p === '/other/repo/docs/global_free_app_configs_override_guide.md',
    }),
    { kind: 'abs', path: '/other/repo/docs/global_free_app_configs_override_guide.md' },
  );
  // ④ 全部落空 → not-found 并回报试过的基准（去重、保持优先级顺序）
  assert.deepEqual(
    resolveBridgePath('docs/missing.md', '/sess', '/ws', {
      sessionCwds: ['/sess', '/other'],
      workspaceRoots: ['/ws', '/ws2'],
      exists: () => false,
    }),
    { kind: 'not-found', tried: ['/sess', '/other', '/ws', '/ws2'] },
  );
  // ④′ DSH 工作区注册表路径排在 VS Code 工作区根**之后**（避免无关历史工作区抢走窗口内同名文件）
  assert.deepEqual(
    resolveBridgePath('README.md', undefined, '/vs-root', {
      dshWorkspacePaths: ['/old/proj'],
      exists: (p) => p === '/vs-root/README.md' || p === '/old/proj/README.md',
    }),
    { kind: 'abs', path: '/vs-root/README.md' },
    '窗口工作区根能命中时，注册表路径不得抢先',
  );
  assert.deepEqual(
    resolveBridgePath('docs/only-in-old.md', undefined, '/vs-root', {
      dshWorkspacePaths: ['/old/proj'],
      exists: (p) => p === '/old/proj/docs/only-in-old.md',
    }),
    { kind: 'abs', path: '/old/proj/docs/only-in-old.md' },
    '窗口工作区根没有时才回落到注册表路径',
  );
  // ⑤ 未提供 exists（旧调用方）：保持「取第一个基准」旧语义不变
  assert.deepEqual(resolveBridgePath('src/main.ts', '/sess', '/ws'), { kind: 'abs', path: '/sess/src/main.ts' });
  // ⑥ 绝对路径与危险协议不受多基准影响
  assert.deepEqual(resolveBridgePath('/abs/a.md', '/sess', '/ws', { exists: () => false }), { kind: 'abs', path: '/abs/a.md' });
  assert.deepEqual(resolveBridgePath('https://x.com/a', '/sess', '/ws', { exists: () => true }), { kind: 'invalid' });
});

test('v0.3.25 命中会话 cwd 时正常打开（不再落到 VS Code 工作区根）', async () => {
  const opened: string[] = [];
  const warns: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'docs/a.md' }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { opened.push(p); },
    showWarning: (m) => { warns.push(m); },
    workspaceRoot: '/vs-root',
    dshSessionCwds: () => ['/other/repo'],
    vscodeWorkspaceRoots: () => ['/vs-root'],
    exists: (p) => p === '/other/repo/docs/a.md',
  });
  assert.deepEqual(opened, ['/other/repo/docs/a.md'], '应打开 DSH 会话 cwd 下的真实文件');
  assert.equal(warns.length, 0, '命中时不应有提示');
});

test('v0.3.25 多基准全落空：提示写明原始路径与试过的基准（不再只有裸的 VS Code 报错）', async () => {
  const warns: string[] = [];
  let opened = 0;
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'docs/missing.md', cwd: '/sess' }, {
    openExternal: async () => true,
    openTextDocument: async () => { opened += 1; },
    showWarning: (m) => { warns.push(m); },
    workspaceRoot: '/ws',
    dshSessionCwds: () => ['/sess', '/other'],
    vscodeWorkspaceRoots: () => ['/ws'],
    exists: () => false,
  });
  assert.equal(opened, 0, '全落空时不应尝试打开');
  assert.equal(warns.length, 1, '必须给一次可见提示');
  assert.match(warns[0]!, /找不到文件：docs\/missing\.md/);
  for (const base of ['/sess', '/other', '/ws']) {
    assert.ok(warns[0]!.includes(base), `提示应写明试过的基准 ${base}`);
  }
});
