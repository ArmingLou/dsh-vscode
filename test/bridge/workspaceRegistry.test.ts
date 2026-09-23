// test/bridge/workspaceRegistry.test.ts — DSH 工作区注册表解析（相对路径兜底基准来源）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspacePathsFromRegistry, MAX_REGISTRY_WORKSPACES } from '../../src/bridge/workspaceRegistry';

test('workspacePathsFromRegistry 提取全部工作区路径（dsh 0.1.7 实测形状）', () => {
  const raw = JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['a', 'b'] },
    tables: {
      workspaces: {
        a: { path: '/Users/me/repo-a', title: 'repo-a', sessionIds: ['s1'] },
        b: { path: '/Users/me/repo-b', title: 'repo-b', sessionIds: [] },
      },
    },
  });
  assert.deepEqual(workspacePathsFromRegistry(raw), ['/Users/me/repo-a', '/Users/me/repo-b']);
});

test('workspacePathsFromRegistry 防御式：去重、跳过非法项、形状不符返回空', () => {
  const raw = JSON.stringify({
    tables: { workspaces: { a: { path: '/x' }, b: { path: '/x' }, c: { path: 42 }, d: null, e: {} } },
  });
  assert.deepEqual(workspacePathsFromRegistry(raw), ['/x'], '重复路径去重、非字符串/空项跳过');
  // 非 JSON / 形状不符：一律空数组（不抛错）
  assert.deepEqual(workspacePathsFromRegistry('not json'), []);
  assert.deepEqual(workspacePathsFromRegistry('{}'), []);
  assert.deepEqual(workspacePathsFromRegistry('{"tables":{}}'), []);
  assert.deepEqual(workspacePathsFromRegistry('{"tables":{"workspaces":[]}}'), [], 'workspaces 为数组视为形状不符');
  assert.deepEqual(workspacePathsFromRegistry('null'), []);
  assert.deepEqual(workspacePathsFromRegistry(''), []);
});

test('workspacePathsFromRegistry 上限截断（避免逐基准探测过慢）', () => {
  const workspaces: Record<string, { path: string }> = {};
  for (let i = 0; i < MAX_REGISTRY_WORKSPACES + 5; i += 1) workspaces[`w${i}`] = { path: `/repo-${i}` };
  assert.equal(workspacePathsFromRegistry(JSON.stringify({ tables: { workspaces } })).length, MAX_REGISTRY_WORKSPACES);
});
