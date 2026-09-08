import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { createDshApiClient } from '../../src/bridge/api';

type CapturedRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

const WORKSPACE_CREATE_RESPONSE = JSON.stringify({
  type: 'server-response',
  rpcId: 'test-rpc',
  result: { ok: true, value: { workspace: { workspaceId: 'w1', path: '/proj' }, created: true } },
});

function startApiServer(port: number, handler?: (captured: CapturedRequest, res: ServerResponse) => void): Promise<{ server: Server; nextRequest: () => Promise<CapturedRequest> }> {
  let resolveReq: ((value: CapturedRequest) => void) | null = null;
  const reqPromise = () => new Promise<CapturedRequest>((r) => { resolveReq = r; });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        path: req.url ?? '/',
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      resolveReq?.(captured);
      resolveReq = null;
      if (handler) {
        handler(captured, res);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(WORKSPACE_CREATE_RESPONSE);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, nextRequest: reqPromise }));
  });
}

test('workspaceCreate sends POST /api/workspace/create with correct body and cookie', async () => {
  const port = 19831;
  const { server, nextRequest } = await startApiServer(port);
  try {
    const api = await createDshApiClient(`http://127.0.0.1:${port}/`, 'dsh-auth-abc=xyz');
    const rpcPromise = api.workspaceCreate('/proj');
    const captured = await nextRequest();
    assert.equal(captured.method, 'POST');
    assert.equal(captured.path, '/api/workspace/create');
    assert.equal(captured.headers['cookie'], 'dsh-auth-abc=xyz');
    assert.equal(captured.headers['content-type'], 'application/json');
    const body = JSON.parse(captured.body);
    assert.equal(body.type, 'client-request');
    assert.equal(body.method, 'workspace/create');
    assert.deepEqual(body.payload, { args: { request: { path: '/proj' } } });
    const result = await rpcPromise;
    assert.equal(result.workspaceId, 'w1');
    assert.equal(result.path, '/proj');
  } finally {
    server.close();
  }
});

test('workspaceCreate with no cookie and no token throws', async () => {
  const port = 19832;
  const { server } = await startApiServer(port);
  try {
    const api = await createDshApiClient(`http://127.0.0.1:${port}/`);
    await assert.rejects(
      () => api.workspaceCreate('/proj'),
      { message: /no session cookie available/ },
    );
  } finally {
    server.close();
  }
});

test('workspaceCreate with token in URL performs token→cookie exchange then calls API', async () => {
  const port = 19833;
  let requestCount = 0;
  const { server } = await startApiServer(port, (captured, res) => {
    requestCount++;
    if (captured.path.startsWith('/?token=')) {
      res.writeHead(200, { 'set-cookie': 'dsh-auth-exch=token-value; Path=/' });
      res.end('ok');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(WORKSPACE_CREATE_RESPONSE);
    }
  });
  try {
    const api = await createDshApiClient(`http://127.0.0.1:${port}/?token=mytoken`);
    const result = await api.workspaceCreate('/proj');
    assert.equal(result.workspaceId, 'w1');
    assert.ok(requestCount >= 2, 'should make at least 2 requests (exchange + API)');
  } finally {
    server.close();
  }
});

test('workspaceCreate with token exchange sends exchanged cookie on API call', async () => {
  const port = 19834;
  let apiCookie: string | undefined;
  const { server } = await startApiServer(port, (captured, res) => {
    if (captured.path.startsWith('/?token=')) {
      res.writeHead(200, { 'set-cookie': 'dsh-auth-exchanged=abc123; Path=/' });
      res.end('ok');
    } else {
      apiCookie = captured.headers['cookie'] as string | undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(WORKSPACE_CREATE_RESPONSE);
    }
  });
  try {
    const api = await createDshApiClient(`http://127.0.0.1:${port}/?token=mytoken`);
    await api.workspaceCreate('/proj');
    assert.equal(apiCookie, 'dsh-auth-exchanged=abc123');
  } finally {
    server.close();
  }
});

test('workspaceCreate prefers provided cookie over token exchange', async () => {
  const port = 19835;
  let paths: string[] = [];
  const { server } = await startApiServer(port, (captured, res) => {
    paths.push(captured.path);
    if (captured.path.startsWith('/?token=')) {
      res.writeHead(200, { 'set-cookie': 'dsh-auth-from-exchange=val; Path=/' });
      res.end('ok');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(WORKSPACE_CREATE_RESPONSE);
    }
  });
  try {
    const api = await createDshApiClient(`http://127.0.0.1:${port}/?token=ignored`, 'dsh-auth-provided=direct');
    await api.workspaceCreate('/proj');
    assert.ok(!paths.some((p) => p.startsWith('/?token=')), 'should NOT exchange token when cookie already provided');
  } finally {
    server.close();
  }
});

test('workspaceCreate token exchange failure (no Set-Cookie) throws', async () => {
  const port = 19836;
  const { server } = await startApiServer(port, (_captured, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  try {
    await assert.rejects(
      () => createDshApiClient(`http://127.0.0.1:${port}/?token=bad`),
      { message: /no dsh-auth cookie/ },
    );
  } finally {
    server.close();
  }
});

test('workspaceCreate with created:false (idempotent) returns same workspace', async () => {
  const port = 19837;
  const idempotentResponse = JSON.stringify({
    type: 'server-response',
    rpcId: 'test-rpc',
    result: { ok: true, value: { workspace: { workspaceId: 'w-existing', path: '/proj' }, created: false } },
  });
  const { server } = await startApiServer(port, (_captured, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(idempotentResponse);
  });
  try {
    const api = await createDshApiClient(`http://127.0.0.1:${port}/`, 'dsh-auth-x=y');
    const result = await api.workspaceCreate('/proj');
    assert.equal(result.workspaceId, 'w-existing');
    assert.equal(result.path, '/proj');
  } finally {
    server.close();
  }
});

test('workspaceCreate non-JSON response includes status and body snippet', async () => {
  const port = 19838;
  const { server } = await startApiServer(port, (_captured, res) => {
    res.writeHead(502);
    res.end('<html>Bad Gateway</html>');
  });
  try {
    const api = await createDshApiClient(`http://127.0.0.1:${port}/`, 'dsh-auth-x=y');
    await assert.rejects(
      () => api.workspaceCreate('/proj'),
      { message: /non-JSON response.*status=502/ },
    );
  } finally {
    server.close();
  }
});

test('workspaceCreate server error result includes status', async () => {
  const port = 19839;
  const { server } = await startApiServer(port, (_captured, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: { ok: false, error: { message: 'internal error' } } }));
  });
  try {
    const api = await createDshApiClient(`http://127.0.0.1:${port}/`, 'dsh-auth-x=y');
    await assert.rejects(
      () => api.workspaceCreate('/proj'),
      { message: /internal error/ },
    );
  } finally {
    server.close();
  }
});
