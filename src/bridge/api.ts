import { request } from 'node:http';

export interface WorkspaceItem {
  workspaceId: string;
  path: string;
}

export interface DshApiClient {
  workspaceCreate(path: string): Promise<WorkspaceItem>;
  /** DSH 各会话的 cwd（按 updatedAt 由新到旧、去重）；文件链接相对路径的首选解析基准（v0.3.25） */
  sessionCwds(): Promise<string[]>;
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
    async sessionCwds(): Promise<string[]> {
      if (!resolvedCookie) {
        throw new Error('session/list: no session cookie available (no cookie provided and no token in URL for exchange)');
      }
      return dshSessionCwds(baseUrl, resolvedCookie);
    },
  };
}

/**
 * 取 DSH 各会话的 cwd（相对路径解析的首选基准）。
 *
 * 为什么需要它：桥接转发的相对路径语义基准是**该会话的 cwd**（DSH 原生
 * `openFile` → `fileAddressFor(sessionId, cwd, path)`），而扩展原先只有「VS Code 工作区根」
 * 一个 base；当 DSH 会话开在别的仓库/工作空间时，相对路径会被拼到错误的仓库根（v0.3.25 修复）。
 * `session/list` 的 `items[].cwd` 是可选的（子代理会话等可能没有），按 `updatedAt` 由新到旧、
 * 去重后返回，供宿主层「取第一个真实存在的文件」。
 */
function dshSessionCwds(baseUrl: string, cookie: string): Promise<string[]> {
  const url = new URL(baseUrl);
  const rpcId = 'dsh-vscode-sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const body = JSON.stringify({
    type: 'client-request',
    rpcId,
    // 0.1.7 typert RPC：端点为「命名空间/方法」（斜杠），参数在 payload.args.<参数 wire 名> 下。
    // session/list 的唯一参数 wire 名为 _request（可空对象，cursor 可选）。
    method: 'session/list',
    payload: { args: { _request: {} } },
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'cookie': cookie,
  };
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: url.hostname, port: url.port, path: '/api/session/list', method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch {
            return reject(new Error(`session/list: non-JSON response (status=${res.statusCode}, body=${raw.slice(0, 200)})`));
          }
          const result = (parsed as Record<string, unknown> | null)?.result as Record<string, unknown> | undefined;
          if (!result || result.ok !== true) {
            return reject(new Error(`session/list: ${JSON.stringify(result?.error ?? result)} (status=${res.statusCode})`));
          }
          const value = result.value as Record<string, unknown> | undefined;
          const items = Array.isArray(value?.items) ? (value.items as unknown[]) : [];
          const rows = items
            .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
            .map((it) => ({
              cwd: typeof it.cwd === 'string' ? it.cwd : '',
              updatedAt: typeof it.updatedAt === 'number' ? it.updatedAt : 0,
            }))
            .filter((row) => row.cwd !== '')
            .sort((a, b) => b.updatedAt - a.updatedAt);
          const cwds: string[] = [];
          for (const row of rows) if (!cwds.includes(row.cwd)) cwds.push(row.cwd);
          resolve(cwds);
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
