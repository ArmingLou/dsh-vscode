// src/service/detect.ts — 端口探测：判断目标地址上是否运行着 DSH web 服务
// 纯模块：不依赖 vscode，可用 node:test 直接单测。

/** 探测结果 */
export type ProbeResult = 'dsh' | 'foreign' | 'down';

/** DSH 首页的稳定识别特征（首页 HTML 内联了 window.__DSH_BOOT__ 启动数据，已实测确认） */
const DSH_MARKER = '__DSH_BOOT__';

/**
 * 新版 dsh 的令牌交换响应特征：GET /?token=X → 303 Location:/ + Set-Cookie 会话。
 * 该 303 只在令牌有效时发出（令牌是 32 字节随机数，只有 dsh 自己校验），
 * 因此「303 重定向到干净首页 + dsh-auth-* Cookie」即证明端口上是 dsh 且令牌有效。
 * fetch 不维护 cookie jar（无法自动跟随 303 并携带 Cookie），故直接以 303 特征判定，
 * 无需再跟随重定向。
 */
const DSH_TOKEN_EXCHANGE = { location: '/', cookiePrefix: 'dsh-auth-' };

/**
 * 探测 host:port 上运行的服务：
 * - 带令牌时：新版 dsh 走令牌交换（/?token=X → 303 + Cookie），命中即 'dsh'；
 *   无令牌（旧版 dsh / 页面直出）时仍以首页标记判定。
 * - 200 且首页含 DSH 标记 → 'dsh'
 * - 有 HTTP 响应但不是 DSH（含新版 dsh 未带令牌的 401）→ 'foreign'（端口被其他程序占用）
 * - 连接失败/超时/拒绝 → 'down'（视为未运行）
 *
 * @param token 新版 dsh 的进程访问令牌（由启动输出 "dsh web: ...?token=XXX" 解析；
 *              未知时传 undefined，按旧版行为探测）
 */
export async function probeService(
  host: string,
  port: number,
  timeoutMs = 3000,
  token?: string,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 带令牌时请求令牌交换 URL：新版 dsh 未带令牌访问首页会收到 401
    const target = token
      ? `http://${host}:${port}/?token=${encodeURIComponent(token)}`
      : `http://${host}:${port}/`;
    const res = await fetch(target, {
      signal: controller.signal,
      redirect: 'manual',
    });
    if (res.status === 303 && token !== undefined) {
      const location = res.headers.get('location');
      const cookies =
        typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : null;
      // getSetCookie 缺失（极旧 fetch 实现）时退化为仅校验 Location，不影响判定
      const cookieOk = cookies === null || cookies.some((c) => c.startsWith(DSH_TOKEN_EXCHANGE.cookiePrefix));
      if (location === DSH_TOKEN_EXCHANGE.location && cookieOk) return 'dsh';
    }
    if (!res.ok) return 'foreign';
    const body = await res.text();
    return body.includes(DSH_MARKER) ? 'dsh' : 'foreign';
  } catch {
    // 网络错误 / 超时中断：一律视为未运行
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/** 端口被占用时自动替换的候选尝试次数（从原端口 +1 起依次探测） */
export const PORT_FALLBACK_ATTEMPTS = 50;

/**
 * 从 startPort+1 开始依次探测，返回第一个「未运行」的端口号（探测结果为 down 视为空闲）。
 * 全部候选都被占用或超出 65535 时返回 null，由调用方保持原「端口被占用」错误。
 *
 * @param host       目标主机（与 probeService 一致）
 * @param startPort  被占用端口（候选从其 +1 开始）
 * @param attempts   最多尝试的候选数
 * @param probeImpl  探测实现（默认 probeService；单测可注入假实现）
 * @param timeoutMs  单次探测超时（透传给 probeImpl）
 */
export async function findFreePort(
  host: string,
  startPort: number,
  attempts: number,
  probeImpl: (host: string, port: number, timeoutMs?: number) => Promise<ProbeResult> = probeService,
  timeoutMs?: number,
): Promise<number | null> {
  for (let offset = 1; offset <= attempts; offset++) {
    const candidate = startPort + offset;
    if (candidate > 65535) break; // 超出合法端口范围，停止
    const result = await probeImpl(host, candidate, timeoutMs);
    if (result === 'down') return candidate;
  }
  return null;
}
