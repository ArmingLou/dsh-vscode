import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncWorkspace } from '../../src/bridge/sync';
import type { DshApiClient, WorkspaceItem } from '../../src/bridge/api';

const mkItem = (workspaceId: string, path: string): WorkspaceItem => ({ workspaceId, path });

test('syncWorkspace calls workspaceCreate (idempotent) and returns result', async () => {
  const api: DshApiClient = {
    workspaceCreate: async (p) => mkItem('w1', p),
  };
  const ws = await syncWorkspace(api, '/proj');
  assert.equal(ws.workspaceId, 'w1');
  assert.equal(ws.path, '/proj');
});

test('syncWorkspace with created:false (existing workspace) returns same id', async () => {
  const api: DshApiClient = {
    workspaceCreate: async (p) => mkItem('w-existing', p),
  };
  const ws = await syncWorkspace(api, '/proj');
  assert.equal(ws.workspaceId, 'w-existing');
});

test('syncWorkspace passes workspaceRoot as-is', async () => {
  let receivedPath = '';
  const api: DshApiClient = {
    workspaceCreate: async (p) => { receivedPath = p; return mkItem('w1', p); },
  };
  await syncWorkspace(api, '/my/project');
  assert.equal(receivedPath, '/my/project');
});
