// src/service/proxy.ts — 面板嵌入代理：让 VS Code webview（无 Cookie 环境）也能访问新版 dsh
// 纯模块：不依赖 vscode；HTTP 转发用 node:http，可单测。
//
// 背景（新版 dsh 0.1.2-alpha.2+ 的动态令牌鉴权）：
//   dsh 每次启动生成随机进程令牌，浏览器访问需先 GET /?token=X 完成 303 令牌交换，
//   拿到 HttpOnly + SameSite=Strict 会话 Cookie 后，所有请求（首页/API/RPC）都必须带它。
//   VS Code webview 的 iframe 是跨站子框架：SameSite=Strict Cookie 永远不会被回传，
//   且 webview 会话本身不持久化 Cookie —— 直接嵌入带令牌的 URL 会在 303 重定向后拿到 401。
// 方案：
//   扩展宿主内启动一个本地反向代理，代理自己完成令牌交换并持有会话 Cookie，
//   把 webview 的每个请求注入 Cookie 后转发给 dsh；同时剥离 Origin/sec-fetch-site
//   并改写 Host，通过 dsh 的 Host/Origin 围栏（isTrustedApiRequest）。
//   webview 只面对代理：无重定向、无 Set-Cookie、全程 200，完全不依赖浏览器 Cookie。

import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

/** 转发目标（dsh 服务地址） */
export interface DshProxyTarget {
  host: string;
  port: number;
}

/** 代理配置 */
export interface DshProxyOptions {
  target: DshProxyTarget;
  /**
   * 进程访问令牌（用于令牌交换，换取会话 Cookie）。
   * 复用已有会话（initialCookie）时可不传；缺失时无法重新交换（401 自愈降级）。
   */
  token?: string;
  /**
   * 预置会话 Cookie（name=value；复用外来实例场景）：提供时 start() 跳过令牌交换直接注入。
   * 来源为上层持久化的上次会话凭据（dsh 的 Cookie 由机器级持久 secret 签名，跨重启有效）。
   */
  initialCookie?: string;
  log?: (line: string) => void;
}

/** dsh 会话 Cookie 名的稳定前缀（dsh-client-connection 的 COOKIE_PREFIX） */
const DSH_COOKIE_PREFIX = 'dsh-auth-';

/** 不转发给上游的请求头（避免破坏 dsh 的 Host/Origin 围栏与 Node 的连接管理） */
const STRIP_REQUEST_HEADERS = new Set([
  'host', 'origin', 'cookie', 'connection', 'proxy-connection', 'upgrade',
  // transfer-encoding 必须剥离：req.pipe(upstream) 流出的是已解帧的 body，
  // 若原样转发 chunked 头，上游会收到「chunked 头 + 非 chunked 数据」的非法流；
  // Node 的 ClientRequest 会按 content-length（有则）或自身 chunked（无则）重新帧化。
  'transfer-encoding',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
]);

/** 不原样回传的响应头（Node 自行管理连接/分块；Set-Cookie 对 webview 无意义且会误导） */
const STRIP_RESPONSE_HEADERS = new Set([
  'set-cookie', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
]);

/**
 * 反向代理（供面板 iframe 嵌入）。对外只暴露一个简单接口：
 * start() 完成令牌交换并监听本地端口；url 为面板嵌入地址；
 * 之后每个请求注入会话 Cookie 转发给 dsh，401 时自动重新交换后重试一次。
 */
export class DshProxy {
  private server: ReturnType<typeof createServer> | null = null;
  private port = 0;
  /** 当前会话 Cookie 头值（如 dsh-auth-xxx=yyy；由令牌交换获得） */
  private cookie: string | null = null;
  /**
   * 已升级的 WebSocket 双向管道 socket：upgrade 后已脱离 http server 的连接管理，
   * closeAllConnections 关不掉它们，stop() 前必须显式销毁，否则 server.close() 永久等待。
   */
  private upgradedSockets = new Set<Duplex>();

  constructor(private opts: DshProxyOptions) {}

  /** 面板嵌入地址（无令牌；经本代理注入会话 Cookie） */
  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  /** 当前监听的端口（未启动时为 0） */
  get listeningPort(): number {
    return this.port;
  }

  /** 当前会话 Cookie（name=value；未建立会话时为 null）——令牌交换成功后供上层持久化复用 */
  get sessionCookie(): string | null {
    return this.cookie;
  }

  /** 令牌交换（或采用预置 Cookie）+ 监听本地端口；交换失败抛错（调用方回退直连并记录日志） */
  async start(): Promise<void> {
    if (this.opts.initialCookie !== undefined) {
      // 预置会话（复用外来实例）：跳过令牌交换，直接以该 Cookie 注入
      this.cookie = this.opts.initialCookie;
    } else if (!(await this.exchange())) {
      throw new Error('dsh proxy: token exchange failed (expected 303 + dsh-auth cookie)');
    }
    const server = createServer((req, res) => void this.forward(req, res));
    // DSH 前端实时通道（Typert Remote 流）走 WebSocket 升级（/api/remote.mux）：
    // 必须转发 upgrade，否则 Node http server 会直接关闭 socket → 前端「连接异常」。
    server.on('upgrade', (req, socket, head) => void this.forwardUpgrade(req, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  /** 停止：立即断开既有连接（含 keep-alive 与已升级的 WebSocket），避免 close() 挂起等待 */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.cookie = null;
    this.port = 0;
    for (const s of this.upgradedSockets) s.destroy();
    this.upgradedSockets.clear();
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 令牌变更（重启后新进程新令牌）：重新交换会话 Cookie */
  async setToken(token: string): Promise<void> {
    this.opts.token = token;
    if (!(await this.exchange())) {
      throw new Error('dsh proxy: token re-exchange failed');
    }
  }

  /**
   * 令牌交换：GET /?token=X → 303 Location:/ + Set-Cookie: dsh-auth-*。
   * 该 303 只在令牌有效时发出；Set-Cookie 即会话凭据（HttpOnly，仅本代理持有）。
   * 无令牌（复用外来实例会话）时无法交换：返回 false 由调用方降级，绝不发起无效请求。
   */
  private async exchange(): Promise<boolean> {
    if (!this.opts.token) {
      this.opts.log?.('[proxy] 无访问令牌（复用外来实例会话），无法重新交换会话 Cookie');
      return false;
    }
    const { host, port } = this.opts.target;
    const url = `http://${host}:${port}/?token=${encodeURIComponent(this.opts.token)}`;
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status !== 303) return false;
      const setCookies =
        typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      const session = setCookies.find((c) => c.startsWith(DSH_COOKIE_PREFIX));
      if (session === undefined) return false;
      this.cookie = session.split(';')[0]; // name=value（去掉 Max-Age/Path 等属性）
      return true;
    } catch {
      return false;
    }
  }

  /** 转发一个 webview 请求；返回是否成功写出响应（401 会话失效时返回 false） */
  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.cookie === null) {
      res.writeHead(502);
      res.end('dsh proxy: no session cookie');
      return;
    }
    const makeOptions = (): RequestOptions => ({
      host: this.opts.target.host,
      port: this.opts.target.port,
      path: req.url,
      method: req.method,
      headers: {
        ...forwardRequestHeaders(req.headers, this.opts.target),
        cookie: this.cookie!,
      },
    });
    if (await this.pipeOnce(req, res, makeOptions())) return;
    // 401（会话失效：服务重启/令牌变化）：重新交换后重试一次
    this.opts.log?.('[proxy] 上游返回 401，重新交换会话 Cookie 后重试');
    if (this.cookie !== null && (await this.exchange())) {
      if (await this.pipeOnce(req, res, makeOptions())) return;
    }
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('dsh proxy: upstream request failed');
    }
  }

  /**
   * 转发 WebSocket 升级（DSH 前端实时通道：dsh-api-gateway 的 /api/remote.mux）。
   * 与 HTTP 转发同规则：注入会话 Cookie、剥离 Origin/sec-fetch-*、改写 Host，
   * 重建 connection: Upgrade + upgrade: websocket 头（原头已被剥离）。
   * 上游接受（101）→ 手写 101 响应 + Sec-WebSocket-Accept 回传 → 双向字节管道（含 head）；
   * 上游拒绝（401/403）→ 把上游的 HTTP 错误响应回传给 webview；401 时重新交换后重试一次。
   */
  private async forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.cookie === null) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    const makeOptions = (): RequestOptions => ({
      host: this.opts.target.host,
      port: this.opts.target.port,
      path: req.url,
      method: 'GET',
      headers: {
        ...forwardRequestHeaders(req.headers, this.opts.target),
        cookie: this.cookie!,
        connection: 'Upgrade',
        upgrade: 'websocket',
      },
    });
    const attempt = (): Promise<boolean> =>
      new Promise((resolve) => {
        const upstream = httpRequest(makeOptions());
        let settled = false;
        upstream.on('upgrade', (upRes, upSocket, upHead) => {
          settled = true;
          // 手写 101 响应：把上游的 Sec-WebSocket-Accept（及可选扩展/子协议）回传
          const lines = [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
          ];
          const accept = upRes.headers['sec-websocket-accept'];
          if (typeof accept === 'string') lines.push(`Sec-WebSocket-Accept: ${accept}`);
          const extensions = upRes.headers['sec-websocket-extensions'];
          if (typeof extensions === 'string') lines.push(`Sec-WebSocket-Extensions: ${extensions}`);
          const protocol = upRes.headers['sec-websocket-protocol'];
          if (typeof protocol === 'string') lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
          socket.write(lines.join('\r\n') + '\r\n\r\n');
          if (upHead.length > 0) socket.write(upHead);
          upSocket.pipe(socket);
          socket.pipe(upSocket);
          // 任一侧断开/出错 → 销毁另一侧，防泄漏
          const teardown = (): void => {
            this.upgradedSockets.delete(socket);
            this.upgradedSockets.delete(upSocket);
            socket.destroy();
            upSocket.destroy();
          };
          this.upgradedSockets.add(socket);
          this.upgradedSockets.add(upSocket);
          socket.on('close', teardown);
          upSocket.on('close', teardown);
          resolve(true);
        });
        upstream.on('response', (upRes) => {
          // 上游未接受升级（如 401/403）：把上游响应原样转回 webview 的 raw socket
          settled = true;
          const chunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => chunks.push(c));
          upRes.on('end', () => {
            const status = upRes.statusCode ?? 502;
            if (status === 401) {
              // 会话失效：不写响应，交给外层「重新交换后重试」（同一 socket 再升级一次）
              resolve(false);
              return;
            }
            const reason = status === 403 ? 'Forbidden' : 'Bad Gateway';
            const body = Buffer.concat(chunks);
            socket.end(
              `HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n` +
              `Content-Type: text/plain; charset=utf-8\r\n` +
              `Content-Length: ${String(body.length)}\r\n\r\n` +
              body.toString('utf8'),
            );
            resolve(true);
          });
          upRes.on('error', () => {
            socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
            resolve(true);
          });
        });
        upstream.on('error', () => {
          if (!settled) {
            socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
            resolve(true);
          }
        });
        // webview 提前断开 → 取消上游升级
        socket.on('close', () => upstream.destroy());
        upstream.end();
      });
    if (await attempt()) return;
    // 401（会话失效）：重新交换后重试一次；仍失败则回 401（与上游一致）
    this.opts.log?.('[proxy] WebSocket 升级 401，重新交换会话 Cookie 后重试');
    if (this.cookie !== null && (await this.exchange())) {
      if (await attempt()) return;
    }
    if (!socket.destroyed) {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\nContent-Length: 11\r\n\r\nunauthorized',
      );
    }
  }

  /** 把 req 管道转发给上游并把响应管道回给 res；401 时消费掉响应体并返回 false */
  private pipeOnce(
    req: IncomingMessage,
    res: ServerResponse,
    options: RequestOptions,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const upstream = httpRequest(options, (upRes) => {
        if (upRes.statusCode === 401) {
          upRes.resume(); // 消费响应体，避免连接泄漏
          resolve(false);
          return;
        }
        if (!res.headersSent) {
          res.writeHead(upRes.statusCode ?? 502, forwardResponseHeaders(upRes.headers));
        }
        upRes.pipe(res);
        resolve(true);
      });
      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('dsh proxy: upstream error');
        } else {
          res.destroy();
        }
        resolve(true);
      });
      // 双向中断清理：webview 断开 → 断开上游；上游中途断开 → 断开 webview
      res.on('close', () => upstream.destroy());
      req.on('error', () => upstream.destroy());
      req.pipe(upstream);
    });
  }
}

/** 过滤请求头：剥离会破坏围栏/连接管理的头，其余原样转发 */
function forwardRequestHeaders(
  headers: IncomingMessage['headers'],
  target: DshProxyTarget,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  // Host 必须指向真实 dsh（isTrustedApiRequest 校验 loopback + 权威地址）
  out['host'] = `${target.host}:${target.port}`;
  return out;
}

/** 过滤响应头：Set-Cookie/连接管理类头不回传，其余原样转发 */
function forwardResponseHeaders(headers: IncomingMessage['headers']): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/** 管理器依赖注入用的最小代理接口（单测可注入假实现） */
export interface DshProxyLike {
  /** 面板嵌入地址（http://127.0.0.1:port/） */
  readonly url: string;
  /** 当前会话 Cookie（可选实现；令牌交换成功后供上层持久化，跨窗口复用外来实例） */
  readonly sessionCookie?: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 令牌变更后重新交换会话 Cookie（可选实现） */
  setToken?(token: string): Promise<void>;
}

/** 默认代理工厂（管理器未注入时使用；把扩展日志接到代理日志） */
export function createDefaultProxyFactory(log: (line: string) => void) {
  return (opts: { target: DshProxyTarget; token: string; initialCookie?: string }): DshProxyLike =>
    new DshProxy({ ...opts, log });
}
