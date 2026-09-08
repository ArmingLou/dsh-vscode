import { request } from 'node:http';

export interface WorkspaceItem {
  workspaceId: string;
  path: string;
}

export interface DshApiClient {
  workspaceCreate(path: string): Promise<WorkspaceItem>;
}

function extractAuthCookie(setCookie: string | string[] | undefined): string | undefined {
  if (!setCookie) return undefined;
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie];
  const parts: string[] = [];
  for (const entry of entries) {
    for (const segment of entry.split(',')) {
      const match = segment.trim().match(/^(dsh-auth-[^=]+=[^;]+)/);
      if (match) parts.push(match[1]);
    }
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

async function exchangeTokenForCookie(baseUrl: string, token: string): Promise<string> {
  const url = new URL(baseUrl);
  const reqPath = `/?token=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: url.hostname, port: url.port, path: reqPath, method: 'GET' },
      (res) => {
        res.resume();
        res.on('end', () => {
          const cookie = extractAuthCookie(res.headers['set-cookie']);
          if (cookie) {
            resolve(cookie);
          } else {
            reject(new Error(`token exchange: no dsh-auth cookie in response (status=${res.statusCode})`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function dshWorkspaceCreate(baseUrl: string, path: string, cookie: string): Promise<WorkspaceItem> {
  const url = new URL(baseUrl);
  const rpcId = 'dsh-vscode-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const body = JSON.stringify({
    type: 'client-request',
    rpcId,
    method: 'workspace/create',
    payload: { args: { request: { path } } },
  });
  const reqPath = '/api/workspace/create';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'cookie': cookie,
  };
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: url.hostname, port: url.port, path: reqPath, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch {
            return reject(new Error(`workspace/create: non-JSON response (status=${res.statusCode}, body=${raw.slice(0, 200)})`));
          }
          if (!parsed || typeof parsed !== 'object') {
            return reject(new Error(`workspace/create: unexpected shape (status=${res.statusCode})`));
          }
          const p = parsed as Record<string, unknown>;
          if (p.result && typeof p.result === 'object') {
            const r = p.result as Record<string, unknown>;
            if (r.ok === true && r.value !== undefined) {
              const v = r.value as Record<string, unknown>;
              if (v.workspace && typeof v.workspace === 'object') {
                const ws = v.workspace as Record<string, unknown>;
                if (typeof ws.workspaceId === 'string' && typeof ws.path === 'string') {
                  return resolve({ workspaceId: ws.workspaceId, path: ws.path });
                }
              }
              return reject(new Error(`workspace/create: result.value.workspace missing workspaceId/path (status=${res.statusCode}, body=${raw.slice(0, 300)})`));
            }
            if (r.ok === false && r.error) {
              return reject(new Error(`workspace/create: ${JSON.stringify(r.error)} (status=${res.statusCode})`));
            }
          }
          reject(new Error(`workspace/create: unexpected response (status=${res.statusCode}, body=${raw.slice(0, 300)})`));
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function createDshApiClient(baseUrl: string, cookie?: string): Promise<DshApiClient> {
  let resolvedCookie: string | undefined = cookie;
  if (!resolvedCookie) {
    const url = new URL(baseUrl);
    const token = url.searchParams.get('token');
    if (token) {
      resolvedCookie = await exchangeTokenForCookie(baseUrl, token);
    }
  }
  return {
    async workspaceCreate(path: string): Promise<WorkspaceItem> {
      if (!resolvedCookie) {
        throw new Error('workspace/create: no session cookie available (no cookie provided and no token in URL for exchange)');
      }
      return dshWorkspaceCreate(baseUrl, path, resolvedCookie);
    },
  };
}
