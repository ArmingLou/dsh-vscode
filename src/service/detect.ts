// src/service/detect.ts — 端口探测：判断目标地址上是否运行着 DSH web 服务
// 纯模块：不依赖 vscode，可用 node:test 直接单测。

/**
 * 探测结果：
 * - 'dsh'                 已确认是 DSH（令牌交换 303 / 首页标记 / Cookie 会话命中）
 * - 'dsh-unauthenticated' 疑似 DSH 但未认证（无令牌探测收到 401 且响应体为 dsh 认证提示）
 * - 'foreign'             有 HTTP 响应但不是 DSH（端口被其他程序占用）
 * - 'down'                连接失败/超时/拒绝（视为未运行）
 */
export type ProbeResult = 'dsh' | 'foreign' | 'down' | 'dsh-unauthenticated';

/** DSH 首页的稳定识别特征（首页 HTML 内联了 window.__DSH_BOOT__ 启动数据，已实测确认） */
const DSH_MARKER = '__DSH_BOOT__';

/** dsh 未认证 401 响应体的稳定识别特征（纯文本提示，已实测确认） */
const DSH_AUTH_REQUIRED_MARKER = 'dsh web authentication required';

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
 * - 带会话 Cookie（无令牌）时：以 Cookie 头直接访问首页，200 且含 DSH 标记 → 'dsh'
 *   （复用外来实例场景：dsh 的会话 Cookie 由机器级持久 secret 签名，跨重启/跨实例有效）。
 * - 200 且首页含 DSH 标记 → 'dsh'
 * - 无令牌收到 401 且响应体含 dsh 认证提示 → 'dsh-unauthenticated'（占用者疑似 dsh，
 *   上层可据此尝试 Cookie/外部令牌复用或引导用户配置 dsh.externalToken）
 * - 其余有 HTTP 响但不是 DSH（含带令牌的 401，即令牌错误/过期）→ 'foreign'（端口被其他程序占用）
 * - 连接失败/超时/拒绝 → 'down'（视为未运行）
 *
 * @param token  新版 dsh 的进程访问令牌（由启动输出 "dsh web: ...?token=XXX" 解析；
 *               未知时传 undefined，按旧版行为探测）
 * @param cookie 已有会话 Cookie（name=value；仅无令牌时生效，用于复用外来实例的探测）
 * @param log    诊断日志出口（可选）：非 'dsh' 判定时记录 HTTP 状态码/响应体片段/错误信息，
 *               用于定位真实环境中的探测分类偏差（401 文案变化、代理劫持等）；缺省不产生任何日志
 */
export async function probeService(
  host: string,
  port: number,
  timeoutMs = 3000,
  token?: string,
  cookie?: string,
  log?: (line: string) => void,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 带令牌时请求令牌交换 URL：新版 dsh 未带令牌访问首页会收到 401
    const target = token
      ? `http://${host}:${port}/?token=${encodeURIComponent(token)}`
      : `http://${host}:${port}/`;
    const headers: Record<string, string> = {};
    // 空串令牌 = 未提供（外部配置默认 '' 归一化前也会流入）：一律按无令牌处理，
    // 否则 401 的「无令牌识别」（下方 token 判据）会被空串破坏 → 疑似 dsh 误判 foreign
    if (!token && cookie !== undefined) headers['cookie'] = cookie;
    const res = await fetch(target, {
      signal: controller.signal,
      redirect: 'manual',
      headers,
    });
    if (res.status === 303 && token) {
      const location = res.headers.get('location');
      const cookies =
        typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : null;
      // getSetCookie 缺失（极旧 fetch 实现）时退化为仅校验 Location，不影响判定
      const cookieOk = cookies === null || cookies.some((c) => c.startsWith(DSH_TOKEN_EXCHANGE.cookiePrefix));
      if (location === DSH_TOKEN_EXCHANGE.location && cookieOk) return 'dsh';
    }
    if (!res.ok) {
      // 无令牌（含空串，见上）收到 401 且响应体为 dsh 认证提示 → 疑似 dsh 未认证。
      // 带令牌的 401（令牌错误/过期）维持原 'foreign' 语义，不读响应体。
      if (res.status === 401 && !token) {
        const body = await res.text();
        if (body.includes(DSH_AUTH_REQUIRED_MARKER)) {
          log?.(`[probe] ${host}:${port} → dsh-unauthenticated（HTTP 401，响应体片段：${snippet(body)}）`);
          return 'dsh-unauthenticated';
        }
        log?.(`[probe] ${host}:${port} → foreign（HTTP 401，响应体不含 dsh 认证标记，片段：${snippet(body)}）`);
        return 'foreign';
      }
      // 其余非 OK 响应：仅诊断模式读响应体记录片段（无日志时保持原行为不读 body，不改变分类边界）
      if (log) {
        try {
          const body = await res.text();
          log(`[probe] ${host}:${port} → foreign（HTTP ${res.status}，响应体片段：${snippet(body)}）`);
        } catch {
          log(`[probe] ${host}:${port} → foreign（HTTP ${res.status}，响应体读取失败）`);
        }
      }
      return 'foreign';
    }
    const body = await res.text();
    if (body.includes(DSH_MARKER)) return 'dsh';
    log?.(`[probe] ${host}:${port} → foreign（HTTP ${res.status}，响应体无 __DSH_BOOT__ 标记，片段：${snippet(body)}）`);
    return 'foreign';
  } catch (err) {
    // 网络错误 / 超时中断：一律视为未运行（诊断日志记录具体错误，定位 fetch 缺失/代理劫持等环境差异）
    log?.(`[probe] ${host}:${port} → down（${err instanceof Error ? err.message : String(err)}）`);
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/** 响应体片段（诊断日志用）：压缩空白并截断到 80 字符，避免日志膨胀 */
function snippet(body: string): string {
  const s = body.replace(/\s+/g, ' ').trim();
  return s.length <= 80 ? s : `${s.slice(0, 80)}…`;
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
