// test/bridge/interceptor.test.ts — 图片降级拦截器集成测试（在真实构建产物上运行）
// 目的：直接把「内联后的 client.js」工厂放进一个最小浏览器沙箱（node:vm）执行，
// 模拟握手 + 附件捕获 + 被拒响应，验证 v0.3.0 图片降级的新行为（用户验收口径）：
//   ① 非视觉模型被拒 → 保存图片、改为「原文+图片地址」重发、用重发成功响应顶替被拒响应
//      （DSH 不再显示"不支持图像输入"报错），且不向上发任何 imageFallback 通知；
//   ② 视觉模型（成功响应）→ 原样透传，完全不动；
//   ③ 被拒但无落盘（未打开工作区）→ 回退原生被拒响应，绝不吞错误。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBridgeClient } from '../../scripts/bridge-build.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const REJECT_BODY = {
  rpcId: 'orig-1',
  result: {
    ok: false,
    error: {
      code: 'attachment-error',
      message: 'Model "x" does not support image input.',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    },
  },
};
const ACCEPT_BODY = { rpcId: 'orig-1', result: { ok: true, value: { accepted: true } } };

/** 构造并加载桥接工厂，返回可调用的沙箱句柄 */
function loadBridge(opts: { fetch: (input: unknown, init: any) => Promise<Response> }) {
  const outDir = join(tmpdir(), 'dsh-bridge-it-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  // 静默构建（buildBridgeClient 会 console.log 一行，避免污染 node --test 的 TAP 流——
  // 与其它测试并行时可能导致 runner 反序列化失败（Unable to deserialize cloned data））
  const origLog = console.log;
  console.log = () => {};
  let built: string;
  try {
    built = buildBridgeClient({
      coreSource: join(process.cwd(), 'bridge-client', 'lib', 'core.js'),
      clientTemplate: join(process.cwd(), 'bridge-client', 'lib', 'client.js'),
      outDir,
    });
  } finally {
    console.log = origLog;
  }
  const code = readFileSync(built, 'utf8');

  // —— 最小浏览器沙箱 ——
  const windowListeners: Map<string, Set<(...a: any[]) => void>> = new Map();
  const docListeners: Map<string, Set<(...a: any[]) => void>> = new Map();
  const parentMessages: any[] = [];
  let loadedPlugin: any = null;

  const emitWin = (type: string, data: unknown) => {
    for (const fn of windowListeners.get(type) ?? []) fn({ data });
  };
  const emitDoc = (type: string, ev: unknown) => {
    for (const fn of docListeners.get(type) ?? []) fn(ev);
  };

  // 父页面（扩展宿主）桩：落盘 saveImage 即回执 saveImageAck（模拟扩展写盘后回路径）。
  const parent = {
    postMessage(msg: any, _o?: string) {
      parentMessages.push(msg);
      if (msg?.kind === 'saveImage') {
        emitWin('message', { kind: 'saveImageAck', requestId: msg.requestId, ok: true, path: '/ws/' + msg.name });
      } else if (msg?.kind === 'deleteImages') {
        emitWin('message', { kind: 'deleteImagesAck', requestId: msg.requestId, ok: true });
      }
    },
  };

  const fakeWindow: Record<string, any> = {
    __ModuleLoader__: { load(cfg: any) { loadedPlugin = cfg; } },
    fetch: opts.fetch,
    __dshVscodeBridgeReady: false,
    addEventListener(type: string, fn: (...a: any[]) => void) {
      (windowListeners.get(type) ?? (windowListeners.set(type, new Set()).get(type)!)).add(fn);
    },
    removeEventListener(type: string, fn: (...a: any[]) => void) {
      windowListeners.get(type)?.delete(fn);
    },
    getSelection() { return null; },
    innerWidth: 1280,
    innerHeight: 800,
    // 测试默认把「模型看完即删」的 TTL 设为 30ms：批次自动快速删除，避免测试结束时残留定时器
    __dshBridgeImageTtlMs: 30,
  };
  // 按 id 取元素（改动行测试用）：React useId 生成的 id 形如 ":r5q:-0"，含冒号，不能当 CSS 选择器
  const elementsById = new Map<string, any>();
  const fakeDocument: Record<string, any> = {
    getElementById(id: string) { return elementsById.get(id) ?? null; },
    addEventListener(type: string, fn: (...a: any[]) => void) {
      (docListeners.get(type) ?? (docListeners.set(type, new Set()).get(type)!)).add(fn);
    },
    activeElement: null,
    // undo/redo 返回 false：模拟「React 受控输入框原生撤销栈为空」，强制走桥接手动手栈
    execCommand(cmd: string) { return cmd !== 'undo' && cmd !== 'redo'; },
    // 可收集的 DOM 桩：append 记录 children、addEventListener 记录监听器（右键菜单测试用）
    createElement() {
      const el: any = {
        textContent: '',
        style: {},
        children: [],
        listeners: {},
        append(...nodes: any[]) { for (const n of nodes) if (n && typeof n === 'object') this.children.push(n); },
        setAttribute() {},
        addEventListener(type: string, fn: (...a: any[]) => void) {
          (el.listeners[type] ?? (el.listeners[type] = [])).push(fn);
        },
        getBoundingClientRect() { return { width: 0, height: 0 }; },
        contains() { return false; },
        classList: { add() {}, contains() { return false; } },
      };
      return el;
    },
    head: {
      children: [],
      append(...nodes: any[]) { for (const n of nodes) if (n && typeof n === 'object') this.children.push(n); },
    },
    body: {
      children: [],
      append(...nodes: any[]) { for (const n of nodes) if (n && typeof n === 'object') this.children.push(n); },
    },
  };

  const sandbox: Record<string, any> = {
    window: fakeWindow,
    document: fakeDocument,
    navigator: { clipboard: {} },
    parent,
    btoa: (globalThis as any).btoa?.bind(globalThis),
    atob: (globalThis as any).atob?.bind(globalThis),
    Response: globalThis.Response,
    fetch: globalThis.fetch,
    // vm 沙箱不自动提供宿主 URL 构造器（与 Response/fetch 一样需显式注入）；
    // 缺它会让 isAllowedExternalUrl 内部 new URL 抛错 → 外链判定恒为 false，
    // 桥接行为与真实浏览器不一致（外链用例会假失败）。
    URL: globalThis.URL,
    setTimeout,
    clearTimeout,
    // —— 撤销/重做测试用 DOM 桩 ——
    Event: class { type: string; bubbles: boolean; constructor(type: string, opts?: { bubbles?: boolean }) { this.type = type; this.bubbles = !!(opts && opts.bubbles); } },
    // 合成组合键派发（右键菜单撤销/重做）用
    KeyboardEvent: class {
      type: string;
      init: any;
      constructor(type: string, init?: any) { this.type = type; this.init = init || {}; }
    },
    HTMLTextAreaElement: {
      prototype: (() => {
        const proto: any = {};
        Object.defineProperty(proto, 'value', { get() { return this._v; }, set(v: string) { this._v = v; } });
        return proto;
      })(),
    },
    HTMLInputElement: {
      prototype: (() => {
        const proto: any = {};
        Object.defineProperty(proto, 'value', { get() { return this._v; }, set(v: string) { this._v = v; } });
        return proto;
      })(),
    },
    // 沙箱内 console：桥接的降级诊断行照常转发到 node console（调试可见），但
    // 用简单对象包裹，避免跨 realm console 对象参与 runner 的结果序列化
    console: {
      log: (...a: unknown[]) => console.log(...a),
      warn: (...a: unknown[]) => console.warn(...a),
      error: (...a: unknown[]) => console.error(...a),
    },
  };
  const ctx = createContext(sandbox);
  runInContext(code, ctx);

  assert.ok(loadedPlugin, '工厂应被 load 捕获');
  assert.equal(loadedPlugin.id, 'dsh-vscode-bridge');
  assert.ok(typeof loadedPlugin.factory === 'function');

  return {
    outDir,
    window: fakeWindow,
    document: fakeDocument,
    windowListeners,
    docListeners,
    elementsById,
    parentMessages,
    emitWin,
    emitDoc,
    /** 执行 factory 并返回 module.exports（应用实例） */
    apply() {
      const req = (id: string) => { throw new Error('unexpected require: ' + id); };
      return loadedPlugin.factory(req);
    },
  };
}

test('被拒（非视觉模型）→ 保存图片、图片改为地址重发、返回成功响应且无通知', async () => {
  const calls: { input: unknown; init: any }[] = [];
  let servedOriginal = false;
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    if (!servedOriginal) {
      servedOriginal = true;
      return jsonResponse(REJECT_BODY); // 第 1 次：原始含图请求 → 被拒
    }
    return jsonResponse(ACCEPT_BODY);   // 第 2 次：降级重发 → 成功
  };

  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply(); // 执行工厂：完成所有监听绑定与 fetch 接管

    // 握手：携带 imageFallback=true 激活降级
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    assert.equal(b.parentMessages.length, 1, '握手应回执 bridgeAck');
    assert.equal(b.parentMessages[0].kind, 'bridgeAck');

    // 捕获一张图片（模拟对话框选择文件）
    const file = {
      name: 'photo.png',
      size: 3,
      lastModified: 42,
      type: 'image/png',
      arrayBuffer: async () => new Uint8Array([1, 2, 3]),
    };
    b.emitDoc('change', { target: { files: [file] } });
    await new Promise((r) => setTimeout(r, 10)); // 等 btoa 微任务完成

    // 模拟 DSH 发送含图 prompt（父页面桩会自动回执 saveImageAck）
    const promptBody = JSON.stringify({
      type: 'client-request',
      rpcId: 'orig-1',
      method: 'session.prompt',
      payload: {
        sessionId: 's1',
        mode: 'queue',
        content: [{ type: 'text', text: '这是什么？' }, { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'a.png' }],
      },
    });
    const out = await b.window.fetch('http://127.0.0.1:3080/api/prompt', { method: 'POST', body: promptBody, headers: { 'content-type': 'application/json' } });

    // ① 返回给 DSH 的是「成功」响应（顶替被拒），且 rpcId 回写为原请求
    const json = await out.json();
    assert.equal(json.rpcId, 'orig-1', '交回响应的 rpcId 应为原请求');
    assert.equal(json.result.ok, true, '交回响应应为成功（不再报"不支持图像输入"）');
    assert.equal(json.result.value.accepted, true);
    assert.equal(out.status, 200);

    // ② DSH 侧应发起两次真实 fetch：原始（含图）+ 降级重发（纯文本图片地址）
    assert.equal(calls.length, 2, '应恰好一次原始 + 一次重发');
    const originalBody = JSON.parse(calls[0].init.body);
    const resendBody = JSON.parse(calls[1].init.body);
    // 原始请求不被篡改（仍是原 rpcId + 图片块）
    assert.equal(originalBody.type, 'client-request');
    assert.equal(originalBody.method, 'session.prompt');
    assert.equal(originalBody.rpcId, 'orig-1');
    assert.ok(originalBody.payload.content.some((x: any) => x.type === 'image'));
    // 重发：保留线格式 type/method（否则服务器 bad-request 拒绝）、新 rpcId、保留 sessionId/mode、内容为「原文 + 图片：路径」且不再含图片块
    assert.equal(resendBody.type, 'client-request', '重发必须保留 type=client-request');
    assert.equal(resendBody.method, 'session.prompt', '重发必须保留 method=session.prompt');
    assert.match(resendBody.rpcId, /^vsc-fb-/);
    assert.equal(resendBody.payload.sessionId, 's1');
    assert.equal(resendBody.payload.mode, 'queue');
    assert.ok(Array.isArray(resendBody.payload.content) && resendBody.payload.content.length === 1);
    assert.equal(resendBody.payload.content[0].type, 'text');
    assert.ok(resendBody.payload.content[0].text.includes('这是什么？'), '应保留用户原文');
    assert.match(resendBody.payload.content[0].text, /图片一：\S+dsh-imgcache-\S+\.png/, '应以「图片一：<绝对路径>」形式随消息发出');

    // ③ 请求过 saveImage 落盘（带图像数据，父桩回执了路径）
    const saveReqs = b.parentMessages.filter((m) => m.kind === 'saveImage');
    assert.equal(saveReqs.length, 1);
    assert.ok(typeof saveReqs[0].dataB64 === 'string' && saveReqs[0].dataB64.length > 0);
    assert.match(saveReqs[0].name, /^dsh-imgcache-/);

    // ④ 绝不向上发 imageFallback 通知（全程无感）
    assert.ok(!b.parentMessages.some((m) => m.kind === 'imageFallback'), '不应发送 imageFallback 通知');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('视觉模型（成功响应）→ 原样透传，不重发、不落盘、不通知', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    return jsonResponse(ACCEPT_BODY); // 模型支持图像 → 成功
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const promptBody = JSON.stringify({
      type: 'client-request', rpcId: 'orig-9', method: 'session.prompt',
      payload: { sessionId: 's2', content: [{ type: 'image' }, { type: 'text', text: '看图' }] },
    });
    const out = await b.window.fetch('/api/prompt', { method: 'POST', body: promptBody });
    const json = await out.json();
    assert.equal(json.result.ok, true);
    assert.equal(calls.length, 1, '成功路径不应触发重发');
    assert.ok(!b.parentMessages.some((m) => m.kind === 'saveImage'), '成功路径不应落盘');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('被拒但无图片缓存（未打开工作区）→ 回退原生被拒响应，不吞错误', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(REJECT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    // 未捕获任何图片（imageCache 为空）直接发含图请求
    const promptBody = JSON.stringify({
      type: 'client-request', rpcId: 'orig-3', method: 'session.prompt',
      payload: { sessionId: 's3', content: [{ type: 'image' }] },
    });
    const out = await b.window.fetch('/api/prompt', { method: 'POST', body: promptBody });
    const json = await out.json();
    // 保持原生：返回的是被拒响应（用户在 DSH 里能看到原始报错，不静默吞掉）
    assert.equal(json.result.ok, false);
    assert.equal(json.result.error.code, 'attachment-error');
    assert.ok(!b.parentMessages.some((m) => m.kind === 'saveImage'), '无缓存不应落盘');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('多条历史缓存时只降级本条消息的图片：按序标注 图片一/图片二、用后消费，不再重复引用', async () => {
  const calls: { input: unknown; init: any }[] = [];
  // 模拟服务端：含图请求被拒（非视觉模型），纯文本重发成功
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    let body: any = {};
    try { body = JSON.parse(init.body || '{}'); } catch {}
    const content = body.payload && body.payload.content;
    const hasImage = Array.isArray(content) && content.some((c: any) => c && c.type === 'image');
    return jsonResponse(hasImage ? REJECT_BODY : ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    // 捕获 3 张（A/B/C）
    const mkFile = (name: string) => ({ name, size: name.length, lastModified: 1, type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]) });
    b.emitDoc('change', { target: { files: [mkFile('A.png'), mkFile('B.png'), mkFile('C.png')] } });
    await new Promise((r) => setTimeout(r, 20));

    // 第 1 次发送：本条消息只含 A、B 两张
    const body1 = JSON.stringify({
      type: 'client-request', rpcId: 'm1', method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'queue',
        content: [{ type: 'text', text: '看看' }, { type: 'image', name: 'A.png', data: 'x' }, { type: 'image', name: 'B.png', data: 'y' }] },
    });
    const out1 = await b.window.fetch('/api/prompt', { method: 'POST', body: body1 });
    assert.equal((await out1.json()).result.ok, true);
    // 恰好 2 次 fetch：原始(含图) + 重发(纯文本)
    assert.equal(calls.length, 2);
    const text1 = JSON.parse(calls[1].init.body).payload.content[0].text;
    assert.match(text1, /图片一：\S*dsh-imgcache-[^\n]*\.png/m, '应按序标为图片一');
    assert.match(text1, /图片二：\S*dsh-imgcache-[^\n]*\.png/m, '应按序标为图片二');
    assert.ok(!/图片[三四五]/m.test(text1), '不应引用本条消息外的图片');
    const saves1 = b.parentMessages.filter((m) => m.kind === 'saveImage');
    assert.equal(saves1.length, 2, '只应落盘本条消息的 2 张');

    // 第 2 次发送：只含 C —— A/B 已被消费，不应再被重复引用
    const body2 = JSON.stringify({
      type: 'client-request', rpcId: 'm2', method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'queue',
        content: [{ type: 'text', text: '再发' }, { type: 'image', name: 'C.png', data: 'z' }] },
    });
    const out2 = await b.window.fetch('/api/prompt', { method: 'POST', body: body2 });
    assert.equal((await out2.json()).result.ok, true);
    assert.equal(calls.length, 4);
    const text2 = JSON.parse(calls[3].init.body).payload.content[0].text;
    assert.match(text2, /图片一：\S*dsh-imgcache-[^\n]*\.png/m, 'C 应标为图片一');
    assert.ok(!/图片二/m.test(text2), 'C 只有一张，不应出现第二行');
    // 不重复引用第 1 次落盘的 A/B 文件
    for (const s of saves1) {
      assert.ok(!text2.includes(s.name), '不得重复引用上一轮已消费的临时文件 ' + s.name);
    }
    assert.equal(b.parentMessages.filter((m) => m.kind === 'saveImage').length, 3, '本轮新增只落盘 1 张');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('会话新建/切换时删除上一对话已落盘的临时图片（对话终止清理）', async () => {
  const calls: { input: unknown; init: any }[] = [];
  // 含图请求被拒（触发降级落盘），纯文本/其它成功
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    let body: any = {};
    try { body = JSON.parse(init.body || '{}'); } catch {}
    const content = body.payload && body.payload.content;
    const hasImage = Array.isArray(content) && content.some((c: any) => c && c.type === 'image');
    return jsonResponse(hasImage ? REJECT_BODY : ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    // TTL 放大（须在工厂执行前设置，工厂在 apply 时读取该覆盖值），
    // 避免测试期间定时器自动删除干扰「会话新建触发删除」的计数断言
    b.window.__dshBridgeImageTtlMs = 60000;
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    // 会话 s1：发一张图 → 被拒 → 落盘 1 张到工作区
    const mkFile = (name: string) => ({ name, size: 3, lastModified: 7, type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]) });
    b.emitDoc('change', { target: { files: [mkFile('s1.png')] } });
    await new Promise((r) => setTimeout(r, 20));
    const bodyP = JSON.stringify({
      type: 'client-request', rpcId: 'p1', method: 'session.prompt',
      payload: { sessionId: 's1', content: [{ type: 'text', text: 'hi' }, { type: 'image', name: 's1.png', data: 'x' }] },
    });
    const out1 = await b.window.fetch('/api/prompt', { method: 'POST', body: bodyP });
    assert.equal((await out1.json()).result.ok, true);
    const saves = b.parentMessages.filter((m) => m.kind === 'saveImage');
    assert.equal(saves.length, 1);
    const savedPath = '/ws/' + saves[0].name;

    // 新建会话 → 应删除上一对话（s1）已落盘的临时图片
    const createBody = JSON.stringify({
      type: 'client-request', rpcId: 'c1', method: 'session.create', payload: { workspaceId: 'w' },
    });
    await b.window.fetch('/api/session.create', { method: 'POST', body: createBody });
    const dels = b.parentMessages.filter((m) => m.kind === 'deleteImages');
    assert.equal(dels.length, 1, '会话新建时应发起一次删除清理');
    assert.ok(Array.isArray(dels[0].paths) && dels[0].paths.includes(savedPath), '应删除上一对话落盘的临时图片 ' + savedPath);
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('模型看完即删：同会话下一条消息立即删除上一批；TTL 到期自动删除', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    let body: any = {};
    try { body = JSON.parse(init.body || '{}'); } catch {}
    const content = body.payload && body.payload.content;
    const hasImage = Array.isArray(content) && content.some((c: any) => c && c.type === 'image');
    return jsonResponse(hasImage ? REJECT_BODY : ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    // 本用例把 TTL 放大到 300ms（须在工厂执行前设置），既验证 TTL 自动删，又避免与断言竞态
    b.window.__dshBridgeImageTtlMs = 300;
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const mkFile = (name: string) => ({ name, size: 3, lastModified: 7, type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]) });
    b.emitDoc('change', { target: { files: [mkFile('m1.png')] } });
    await new Promise((r) => setTimeout(r, 20));
    // 发送消息 1（含图）→ 落盘 1 张
    const body1 = JSON.stringify({
      type: 'client-request', rpcId: 'q1', method: 'session.prompt',
      payload: { sessionId: 's9', content: [{ type: 'image', name: 'm1.png', data: 'x' }] },
    });
    const out1 = await b.window.fetch('/api/prompt', { method: 'POST', body: body1 });
    assert.equal((await out1.json()).result.ok, true);
    const saves1 = b.parentMessages.filter((m) => m.kind === 'saveImage');
    assert.equal(saves1.length, 1);
    const p1 = '/ws/' + saves1[0].name;
    // 发送消息 2（纯文本，同一会话）→ 模型已读完消息 1 的图 → 立即删除，无需等 TTL
    const body2 = JSON.stringify({
      type: 'client-request', rpcId: 'q2', method: 'session.prompt',
      payload: { sessionId: 's9', content: [{ type: 'text', text: '继续' }] },
    });
    await b.window.fetch('/api/prompt', { method: 'POST', body: body2 });
    const dels1 = b.parentMessages.filter((m) => m.kind === 'deleteImages');
    assert.ok(dels1.length >= 1 && dels1.some((d) => d.paths.includes(p1)), '下一条消息应立即删除上一批临时图 ' + p1);
    // 消息 3（含图）→ 落盘新一批；TTL(30ms) 到期后应自动删除
    b.emitDoc('change', { target: { files: [mkFile('m2.png')] } });
    await new Promise((r) => setTimeout(r, 20));
    const body3 = JSON.stringify({
      type: 'client-request', rpcId: 'q3', method: 'session.prompt',
      payload: { sessionId: 's9', content: [{ type: 'image', name: 'm2.png', data: 'y' }] },
    });
    const out3 = await b.window.fetch('/api/prompt', { method: 'POST', body: body3 });
    assert.equal((await out3.json()).result.ok, true);
    const saves3 = b.parentMessages.filter((m) => m.kind === 'saveImage');
    const p3 = '/ws/' + saves3[saves3.length - 1].name;
    assert.ok(!b.parentMessages.some((m) => m.kind === 'deleteImages' && m.paths.includes(p3)), '刚落盘的批次不应被立即删除');
    // 等待 TTL（300ms）到期 → 自动删除
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(b.parentMessages.some((m) => m.kind === 'deleteImages' && m.paths.includes(p3)), 'TTL 到期应自动删除临时图 ' + p3);
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.2 撤销/重做（Cmd+Z 等）放行给页面自身处理，不拦截不本地仿真', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const started = b.parentMessages.length;
    const keydown = (k: any) => b.windowListeners.get('keydown')?.forEach((fn) => fn(k));
    const ev = (over: any) => ({
      key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false,
      preventDefault() {}, stopPropagation() {}, ...over,
    });

    // ① Cmd+Z：放行——不 preventDefault、不 stopPropagation、不产生任何桥接消息
    //    （DSH 输入框自带 draft 事务级撤销系统，keydown 冒泡到它的处理器执行 keyboard.undo）
    let p1 = 0, s1 = 0;
    keydown(ev({ key: 'z', code: 'KeyZ', metaKey: true, preventDefault() { p1 += 1; }, stopPropagation() { s1 += 1; } }));
    assert.equal(p1, 0, 'Cmd+Z 不应 preventDefault（放行给页面自身撤销）');
    assert.equal(s1, 0, 'Cmd+Z 不应 stopPropagation');
    assert.equal(b.parentMessages.slice(started).length, 0, 'Cmd+Z 不应产生桥接消息');

    // ② Cmd+Shift+Z（重做）与 Ctrl+Z 同样放行
    let p2 = 0;
    keydown(ev({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true, preventDefault() { p2 += 1; } }));
    assert.equal(p2, 0, 'Cmd+Shift+Z 应放行');
    let p3 = 0;
    keydown(ev({ key: 'z', code: 'KeyZ', ctrlKey: true, preventDefault() { p3 += 1; } }));
    assert.equal(p3, 0, 'Ctrl+Z 应放行');

    // ③ 对照：Cmd+C 仍被拦截走本地仿真（剪贴板桥接路径不受影响）
    let p4 = 0;
    keydown(ev({ key: 'c', code: 'KeyC', metaKey: true, preventDefault() { p4 += 1; } }));
    assert.equal(p4, 1, 'Cmd+C 仍应被拦截（本地仿真）');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.2 右键菜单「撤销/重做」向焦点输入框派发合成组合键（由页面自身执行）', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });

    // 焦点输入框（React 受控 textarea 简化桩）：记录派发的合成事件
    const dispatched: any[] = [];
    const ta: any = {
      tagName: 'TEXTAREA',
      _v: 'hello world',
      isContentEditable: false,
      isConnected: true,
      selectionStart: 5,
      selectionEnd: 5,
      setSelectionRange() {},
      focus() {},
      dispatchEvent(ev: any) { dispatched.push(ev); },
    };
    Object.defineProperty(ta, 'value', { get() { return this._v; }, set(v: string) { this._v = v; } });
    b.document.activeElement = ta;

    // 右键 → 自定义菜单出现（挂在 body 下，按钮带点击监听）。
    // 注意：contextmenu 直接调 window 监听器（emitWin 会包一层 {data}，不适合事件桩）
    b.windowListeners.get('contextmenu')?.forEach((fn) =>
      fn({ clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} }),
    );
    const menuEl = b.document.body.children[0];
    assert.ok(menuEl, '菜单应被创建并挂到 body');
    const undoBtn = menuEl.children.find((c: any) => c.textContent === '撤销');
    const redoBtn = menuEl.children.find((c: any) => c.textContent === '重做');
    assert.ok(undoBtn && redoBtn, '菜单应包含撤销/重做项');

    // 模拟真实浏览器：点击菜单按钮（mousedown）会把焦点从输入框抢到按钮上——
    // 撤销/重做必须仍派发给「右键瞬间的输入框」（menuContextEditable），而非当前焦点
    b.document.activeElement = menuEl;

    // 点「撤销」→ 向右键时焦点输入框派发合成 Cmd+Z（metaKey+ctrlKey，无 Shift）
    undoBtn.listeners.click[0]();
    assert.equal(dispatched.length, 1, '撤销应派发一次 keydown');
    assert.equal(dispatched[0].type, 'keydown');
    assert.equal(dispatched[0].init.key, 'z');
    assert.equal(dispatched[0].init.metaKey, true, '应带 metaKey（mac 主修饰键）');
    assert.equal(dispatched[0].init.ctrlKey, true, '应带 ctrlKey（win 主修饰键，DSH 检查 metaKey||ctrlKey）');
    assert.equal(dispatched[0].init.shiftKey, false, '撤销不带 Shift');

    // 点「重做」→ 合成 Cmd+Shift+Z（shiftKey=true）
    redoBtn.listeners.click[0]();
    assert.equal(dispatched.length, 2, '重做应再派发一次');
    assert.equal(dispatched[1].init.shiftKey, true, '重做应带 Shift');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.2 桥接快捷键：命中映射的组合键转发给扩展宿主，未命中放行', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    // 握手携带快捷键映射（combo → commandId，扩展侧生成）
    b.emitWin('message', {
      kind: 'bridgeHello',
      token: 'tok',
      imageFallback: true,
      shortcuts: {
        'cmd+1': 'workbench.action.toggleAuxiliaryBar',
        'cmd+escape': 'workbench.action.toggleMaximizedPanel',
      },
    });
    const started = b.parentMessages.length;
    const keydown = (k: any) => b.windowListeners.get('keydown')?.forEach((fn) => fn(k));
    const ev = (over: any) => ({
      key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false,
      preventDefault() {}, stopPropagation() {}, ...over,
    });
    const shortcutMsgs = () => b.parentMessages.slice(started).filter((m) => m.kind === 'shortcut');

    // ① 命中映射：转发 shortcut 消息并 preventDefault
    const e1 = ev({ key: '1', code: 'Digit1', metaKey: true });
    keydown(e1);
    assert.equal(shortcutMsgs().length, 1, '命中映射应转发一条 shortcut');
    assert.equal(shortcutMsgs()[0].combo, 'cmd+1');
    assert.equal(shortcutMsgs()[0].code, 'Digit1');

    // ② Cmd+Esc（带修饰键的 Esc）同样命中映射
    const e2 = ev({ key: 'Escape', code: 'Escape', metaKey: true });
    keydown(e2);
    assert.equal(shortcutMsgs().length, 2);
    assert.equal(shortcutMsgs()[1].combo, 'cmd+escape');

    // ③ 未命中映射的组合键：不转发、不 preventDefault（放行给 DSH 页面自身）
    let prevented = 0;
    const e3 = ev({ key: '2', code: 'Digit2', metaKey: true, preventDefault() { prevented += 1; } });
    keydown(e3);
    assert.equal(shortcutMsgs().length, 2, '未命中不应转发');
    assert.equal(prevented, 0, '未命中不应 preventDefault');

    // ④ 自动重复（按住不放）不转发，避免 toggle 类命令来回横跳
    const e4 = ev({ key: '1', code: 'Digit1', metaKey: true, repeat: true });
    keydown(e4);
    assert.equal(shortcutMsgs().length, 2, 'repeat 事件不应转发');

    // ⑤ 编辑类快捷键（Cmd+Z）仍走本地仿真，不产生 shortcut 消息
    keydown({ key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} });
    assert.equal(shortcutMsgs().length, 2, '编辑类快捷键不应进入转发');

    // ⑥ 无修饰键的 Esc 不转发（仅收起自定义菜单，放行给页面）
    const e6 = ev({ key: 'Escape', code: 'Escape' });
    keydown(e6);
    assert.equal(shortcutMsgs().length, 2, '无修饰键 Esc 不应转发');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.2 握手未携带 shortcuts 时：组合键一律放行（向后兼容）', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    // 旧版握手（无 shortcuts 字段）：cmd+1 不应被拦截
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const started = b.parentMessages.length;
    const keydown = (k: any) => b.windowListeners.get('keydown')?.forEach((fn) => fn(k));
    const e = { key: '1', code: 'Digit1', metaKey: true, preventDefault() {}, stopPropagation() {} };
    keydown(e);
    assert.equal(b.parentMessages.slice(started).filter((m) => m.kind === 'shortcut').length, 0, '无映射不应转发');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

/**
 * 文件链接点击测试共用的元素桩。
 * 只实现桥接 DOM 拦截真正用到的选择器（button / a / 用例注入的祖先），其余一律返回 null，
 * 避免「任意选择器都命中」导致工具行等其它分支被假命中。
 */
function mkFileEl(over: {
  className?: string;
  title?: string;
  ariaLabel?: string;
  text?: string;
  refChip?: string;
  tag?: string;
  closestMap?: Record<string, unknown>;
}) {
  const attrs: Record<string, string> = {};
  if (over.className !== undefined) attrs['class'] = over.className;
  if (over.title !== undefined) attrs['title'] = over.title;
  if (over.ariaLabel !== undefined) attrs['aria-label'] = over.ariaLabel;
  if (over.refChip !== undefined) attrs['data-ref-chip'] = over.refChip;
  const el: any = {
    textContent: over.text ?? '',
    getAttribute: (n: string) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
    closest: (sel: string) => {
      if (sel === 'button') return (over.tag ?? 'button') === 'button' ? el : null;
      if (sel === 'a') return null;
      const hit = over.closestMap?.[sel];
      return hit === true ? el : (hit as any) ?? null;
    },
  };
  return el;
}

/** 一次点击的派发与结果（是否被拦截）；extra 可注入 detail 等原生事件字段 */
function clickFile(b: { emitDoc: (t: string, e: unknown) => void }, target: any, extra: Record<string, unknown> = {}) {
  let prevented = 0;
  let stopped = 0;
  b.emitDoc('click', {
    target,
    ...extra,
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  });
  return { prevented, stopped };
}

test('dsh 0.1.7 文件链接点击：CSS Modules 哈希类名 / @引用芯片 / 产物卡片 / 工具行均转发 openFile', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const started = b.parentMessages.length;
    const openFiles = () => b.parentMessages.slice(started).filter((m) => m.kind === 'openFile');

    // ① markdown 文件链接：类名被哈希（_fileMention_x / _fileLink_y），title 是相对路径
    clickFile(b, mkFileEl({
      className: '_fileMention_1jct6_85 _fileLink_1jct6_59',
      title: 'src/a.ts',
      text: 'a.ts',
    }));
    assert.equal(openFiles().length, 1, '哈希类名的文件链接应被接管');
    assert.equal(openFiles()[0].path, 'src/a.ts', '相对路径原样转发（扩展侧按工作区根解析）');

    // ② @文件 引用芯片：data-ref-chip="file"，title 是 @路径（含引号包裹的空格路径）
    clickFile(b, mkFileEl({
      className: '_refChip_1jct6_1 _fileMention_1jct6_85',
      title: '@"docs/a b.md"',
      refChip: 'file',
      text: 'a b.md',
    }));
    assert.equal(openFiles().length, 2, '@引用芯片应被接管');
    assert.equal(openFiles()[1].path, 'docs/a b.md', '应去掉 @ 前缀与引号');

    // ③ 产物文件卡片：覆盖整卡的 button，title 为绝对路径，aria-label 是本地化文案（不可当路径）
    const r3 = clickFile(b, mkFileEl({
      className: 'nyYjTG_cardPreview',
      title: '/ws/out/a.log',
      ariaLabel: '预览 a.log',
      text: '',
    }));
    assert.equal(openFiles().length, 3, '产物卡片应被接管');
    assert.equal(openFiles()[2].path, '/ws/out/a.log', '必须取 title 而非 aria-label 文案');
    assert.equal(r3.prevented, 1, '命中应 preventDefault（阻止 DSH 打开自己的侧边栏预览）');

    // ④ 工具调用行 fileLink（无 title，只剩 basename）：按类名 + 文本识别
    clickFile(b, mkFileEl({ className: 'o3BgMG_fileLink', text: 'README.md' }));
    assert.equal(openFiles().length, 4, '工具行只剩文件名时也应被接管');
    assert.equal(openFiles()[3].path, 'README.md');

    // ⑤ 点击落在卡片子节点（非 button）上：经 [data-presented-file] 回退到卡内带 title 的按钮
    const overlay = mkFileEl({ className: 'nyYjTG_cardPreview', title: '/ws/card.txt', text: '' });
    clickFile(b, mkFileEl({
      tag: 'span', text: 'card.txt',
      closestMap: { 'button': null, '[data-presented-file]': { querySelector: (sel: string) => (sel === 'button[title]' ? overlay : null) } },
    }));
    assert.equal(openFiles().length, 5, '卡片子节点点击应回退到卡内按钮');
    assert.equal(openFiles()[4].path, '/ws/card.txt');

    // ⑥ 非文件按钮（普通按钮、目录引用芯片）：不拦截、不 preventDefault，交回 DSH 自己处理
    const prose = clickFile(b, mkFileEl({ className: 'lcKema_row', title: '复制代码', ariaLabel: '复制', text: '复制' }));
    const folder = clickFile(b, mkFileEl({
      className: '_refChip_1jct6_1 _fileMention_1jct6_85', title: '@docs/', refChip: 'folder', text: 'docs',
    }));
    assert.equal(openFiles().length, 5, '非文件点击不应转发');
    assert.equal(prose.prevented + folder.prevented, 0, '非文件点击不应 preventDefault');
    assert.equal(prose.stopped + folder.stopped, 0, '非文件点击不应 stopPropagation');

    // ⑦ 带行号锚点的链接：剥掉锚点只转发路径（扩展侧 showTextDocument 只接受路径）
    clickFile(b, mkFileEl({ className: '_fileLink_1jct6_59', title: '/ws/src/b.ts#L12-L20', text: 'b.ts' }));
    assert.equal(openFiles().length, 6);
    assert.equal(openFiles()[5].path, '/ws/src/b.ts', '应剥掉 #L12-L20 行号锚点');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('旧版 dsh 文件链接点击仍被接管（裸类名 fileMention / title 绝对路径 / Windows 盘符）', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const started = b.parentMessages.length;
    const openFiles = () => b.parentMessages.slice(started).filter((m) => m.kind === 'openFile');

    // ① 旧版裸类名 fileMention：title 为真实路径（旧实现曾误用 aria-label 文案）
    clickFile(b, mkFileEl({ className: 'fileMention', title: '/ws/src/main.ts', ariaLabel: '打开 /ws/src/main.ts', text: 'main.ts' }));
    assert.equal(openFiles().length, 1, 'fileMention 应转发 openFile');
    assert.equal(openFiles()[0].path, '/ws/src/main.ts', '应转发 title 真实路径而非 aria-label 文案');

    // ② 产物 chip（无文件类名，title 绝对路径）③ Windows 盘符
    clickFile(b, mkFileEl({ title: '/ws/out/a.log', ariaLabel: '打开 /ws/out/a.log', text: 'a.log' }));
    clickFile(b, mkFileEl({ title: 'C:\\proj\\b.ts', ariaLabel: '打开 C:\\proj\\b.ts', text: 'b.ts' }));
    assert.equal(openFiles().length, 3, 'title 为绝对路径的按钮应转发 openFile');
    assert.equal(openFiles()[1].path, '/ws/out/a.log');
    assert.equal(openFiles()[2].path, 'C:\\proj\\b.ts');

    // ④ 普通按钮（title 非路径、无文件类名）：不拦截
    const r4 = clickFile(b, mkFileEl({ title: '复制代码', ariaLabel: '复制', text: '复制' }));
    assert.equal(openFiles().length, 3, '非路径按钮不应转发');
    assert.equal(r4.prevented, 0, '非路径按钮不应 preventDefault');
    assert.equal(r4.stopped, 0, '非路径按钮不应 stopPropagation');

    // ⑤ 外链 <a>：仍走 openExternal（不被文件分支误吞）
    const before = openFiles().length;
    b.emitDoc('click', {
      target: { closest: (sel: string) => (sel === 'a' ? { href: 'https://example.com/x' } : null) },
      preventDefault() {}, stopPropagation() {},
    });
    assert.equal(openFiles().length, before, '外链不应产生 openFile');
    const openExternals = b.parentMessages.slice(started).filter((m) => m.kind === 'openExternal');
    assert.ok(openExternals.length >= 1, '外链应转发 openExternal');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.2 未握手时文件路径点击不拦截（普通浏览器保持 DSH 原生行为）', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply(); // 不握手
    const started = b.parentMessages.length;
    clickFile(b, mkFileEl({ className: '_fileMention_1jct6_85', title: '/ws/a.ts', text: 'a.ts' }));
    assert.equal(b.parentMessages.slice(started).filter((m) => m.kind === 'openFile').length, 0, '未握手不应转发');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.24 原生同款守卫：多击与「存在未折叠选区」的单击都不接管（拖选/双击不误开文件）', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const started = b.parentMessages.length;
    const openFiles = () => b.parentMessages.slice(started).filter((m) => m.kind === 'openFile');
    // 与 dsh 0.1.7 真实 DOM 一致的文件链接按钮（哈希类名 + 内层 span）
    const link = () => mkFileEl({ className: '_fileMention_1jct6_85 _fileLink_1jct6_59', title: 'src/a.ts', text: 'a.ts' });

    // ① 单击（detail=1）+ 选区折叠 → 接管
    const single = clickFile(b, link(), { detail: 1 });
    assert.equal(openFiles().length, 1, '单击应接管');
    assert.equal(single.prevented, 1, '单击应 preventDefault');

    // ② 双击/多击（detail>1）→ 不接管（照抄原生 `event.detail > 1` 直接 return）
    const dbl = clickFile(b, link(), { detail: 2 });
    assert.equal(openFiles().length, 1, '双击不应转发 openFile');
    assert.equal(dbl.prevented + dbl.stopped, 0, '双击应完全放行原事件');

    // ③ 存在未折叠选区时的单击（拖选收尾误触）→ 不接管
    b.document.getSelection = () => ({ isCollapsed: false });
    const drag = clickFile(b, link(), { detail: 1 });
    assert.equal(openFiles().length, 1, '有未折叠选区时不应转发 openFile');
    assert.equal(drag.prevented + drag.stopped, 0, '有未折叠选区时应完全放行原事件');

    // ④ 选区恢复折叠 → 恢复接管（守卫只挡拖选，不挡正常单击）
    b.document.getSelection = () => ({ isCollapsed: true });
    const again = clickFile(b, link(), { detail: 1 });
    assert.equal(openFiles().length, 2, '折叠选区后应恢复接管');
    assert.equal(again.prevented, 1);
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.2 工具调用行（ToolRow）fileLink 点击：文本路径转发 openFile，其它按钮放行', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const started = b.parentMessages.length;

    // 模拟 DSH ToolCall DOM：容器带 data-tool，内部 fileLink 按钮无 title/aria-label，
    // 文本形如「read · <路径>」。fileLinkStructure=true 时模拟真实层级：
    // fileLink 按钮位于 [data-disclosure-row] 折叠行内（Edit 行 basename 场景）
    const mkFileLink = (text: string, opts?: { fileLinkStructure?: boolean }) => {
      const toolRow: any = {
        classList: { contains: () => false },
        getAttribute: (name: string) => (name === 'data-tool' ? 'read' : null),
        textContent: '',
        closest: () => null,
      };
      const foldRow: any = {
        classList: { contains: () => false },
        getAttribute: (name: string) => (name === 'data-disclosure-row' ? '' : null),
        textContent: '',
        closest: (sel: string) => (sel === '[data-tool]' ? toolRow : null),
      };
      const btn: any = {
        classList: { contains: () => false },
        getAttribute: () => null,
        textContent: text,
        parentElement: null,
        closest: (sel: string) => {
          if (sel === '[data-tool]') return toolRow;
          if (sel === 'button') return btn;
          if (sel === '[data-disclosure-row]') return opts?.fileLinkStructure ? foldRow : null;
          return null;
        },
      };
      if (opts?.fileLinkStructure) {
        btn.parentElement = foldRow;
      }
      return btn;
    };
    const click = (target: any) => {
      let prevented = 0;
      let stopped = 0;
      b.emitDoc('click', {
        target,
        preventDefault() { prevented += 1; },
        stopPropagation() { stopped += 1; },
      });
      return { prevented, stopped };
    };
    const openFiles = () => b.parentMessages.slice(started).filter((m) => m.kind === 'openFile');

    // ① 用户描述的形态：read· test/bridge/interceptor.test.ts → 转发提取出的路径
    const e1 = click(mkFileLink('read · test/bridge/interceptor.test.ts'));
    assert.equal(openFiles().length, 1, '工具行文件链接应转发 openFile');
    assert.equal(openFiles()[0].path, 'test/bridge/interceptor.test.ts', '应转发去掉「read · 」前缀的路径');
    assert.equal(e1.prevented, 1, '命中应 preventDefault（阻止 DSH 的 host.openPath）');

    // ② 相对会话 cwd 的路径（无前缀形态）同样转发
    click(mkFileLink('src/main.ts'));
    assert.equal(openFiles().length, 2);
    assert.equal(openFiles()[1].path, 'src/main.ts');

    // ③ ~ 缩写路径原样转发（host 侧展开主目录）
    click(mkFileLink('read · ~/proj/a.ts'));
    assert.equal(openFiles().length, 3);
    assert.equal(openFiles()[2].path, '~/proj/a.ts');

    // ④ Edit 行根目录文件：相对化后只剩 basename（README.zh.md，无分隔符）——
    //    文本判定不命中，由 fileLink 结构判定（折叠行直接子级）兜底
    const e4 = click(mkFileLink('README.zh.md', { fileLinkStructure: true }));
    assert.equal(openFiles().length, 4, 'basename 形态的 fileLink 应转发');
    assert.equal(openFiles()[3].path, 'README.zh.md');
    assert.equal(e4.prevented, 1, '结构命中应 preventDefault');

    // ⑤ body 区按钮（复制等，非折叠行直接子级）：即使无分隔符也不拦截
    const e5 = click(mkFileLink('复制'));
    assert.equal(openFiles().length, 4, '非 fileLink 结构按钮不应转发');
    assert.equal(e5.prevented, 0, '非 fileLink 结构按钮不应 preventDefault');
    assert.equal(e5.stopped, 0, '非 fileLink 结构按钮不应 stopPropagation');

    // ⑥ 无路径形态且在折叠行直接子级的空文本按钮（如装饰元素）：不转发
    const e6 = click(mkFileLink('', { fileLinkStructure: true }));
    assert.equal(openFiles().length, 4, '空文本按钮不应转发');
    assert.equal(e6.prevented, 0);
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.4 host.openPath RPC 统一拦截：转发扩展宿主并伪造成功响应（后端不被调用）', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    return jsonResponse(ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const started = b.parentMessages.length;

    // 模拟 DSH 的 callUnary（WebApiClient.doFetch = globalThis.fetch）：
    // POST /api/host.openPath，请求体为 client-request 线格式
    const out = await b.window.fetch('/api/host.openPath', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-1',
        method: 'host.openPath',
        payload: { path: '/ws/src/main.ts' },
      }),
    });
    // ① 后端不被调用（系统默认应用不会弹出）
    assert.equal(calls.length, 0, 'openPath 请求不应到达后端');
    // ② 转发扩展宿主打开文件
    const openFiles = b.parentMessages.slice(started).filter((m) => m.kind === 'openFile');
    assert.equal(openFiles.length, 1, '应转发 openFile 消息');
    assert.equal(openFiles[0].path, '/ws/src/main.ts');
    // ③ 伪造 server-response 成功响应（rpcId 回显 + opened:true），DSH 的 rpcId 校验与 value 解析通过
    const json = await out.json();
    assert.equal(json.type, 'server-response');
    assert.equal(json.rpcId, 'rpc-1', 'rpcId 必须回显（否则 DSH 抛 rpcId mismatch）');
    assert.equal(json.result.ok, true);
    assert.deepEqual(json.result.value, { opened: true }, 'value 须满足 hostOpenPathValueSchema');
    assert.equal(out.status, 200);
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.4 host.openPath 拦截与图片降级互不干扰：其它 RPC 原样透传', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    return jsonResponse(ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const started = b.parentMessages.length;
    // 普通 RPC（如 session.list）不受 openPath 前置拦截影响
    const out = await b.window.fetch('/api/session.list', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-2', method: 'session.list', payload: {} }),
    });
    assert.equal(calls.length, 1, '普通 RPC 应到达后端');
    assert.equal((await out.json()).result.ok, true);
    assert.equal(b.parentMessages.slice(started).filter((m) => m.kind === 'openFile').length, 0, '不应转发 openFile');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.4 未握手时 host.openPath 不拦截（普通浏览器保持原生行为）', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    return jsonResponse(ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply(); // 不握手
    const started = b.parentMessages.length;
    await b.window.fetch('/api/host.openPath', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-3', method: 'host.openPath', payload: { path: '/ws/a.ts' } }),
    });
    assert.equal(calls.length, 1, '未握手应原样到达后端');
    assert.equal(b.parentMessages.slice(started).filter((m) => m.kind === 'openFile').length, 0, '未握手不应转发');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('syncWorkspace：session.create 的 workspaceId 被覆盖为本窗口工作区（pre-fetch，须在 origFetch 前）', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    return jsonResponse(ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    // 下发本窗口工作区 id
    b.emitWin('message', { kind: 'bridgeSyncWorkspace', workspaceId: 'ws-suansuan' });
    // 前端新建会话（自带全局最近工作区 id）
    const body = JSON.stringify({ type: 'client-request', rpcId: 'c', method: 'session.create', payload: { workspaceId: 'ws-global-recent' } });
    await b.window.fetch('/api/session.create', { method: 'POST', body });
    assert.equal(calls.length, 1, 'session.create 应到达后端');
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.payload.workspaceId, 'ws-suansuan', 'session.create 的 workspaceId 应覆盖为本窗口工作区');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('syncWorkspace：未下发工作区时 session.create 保持原体不被篡改', async () => {
  const calls: { input: unknown; init: any }[] = [];
  const fakeRealFetch = async (input: unknown, init: any) => {
    calls.push({ input, init });
    return jsonResponse(ACCEPT_BODY);
  };
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const body = JSON.stringify({ type: 'client-request', rpcId: 'c', method: 'session.create', payload: { workspaceId: 'ws-other' } });
    await b.window.fetch('/api/session.create', { method: 'POST', body });
    assert.equal(calls.length, 1, 'session.create 应到达后端');
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.payload.workspaceId, 'ws-other', '未下发工作区时应保持原体');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

/**
 * DSH「改动」卡片（[data-changed-files]）文件行的元素桩：只实现桥接真正用到的选择器，
 * 其余一律返回 null（避免「任意选择器都命中」导致其它分支假命中）。
 */
function mkChangedRow(over: {
  describedBy?: string;
  inCard?: boolean;
  rowText?: string;
  tag?: string;
}) {
  const attrs: Record<string, string> = {};
  if (over.describedBy !== undefined) attrs['aria-describedby'] = over.describedBy;
  const firstSpan = { textContent: over.rowText ?? '' };
  const el: any = {
    textContent: over.rowText ?? '',
    getAttribute: (n: string) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
    querySelector: (sel: string) => (sel === 'span' ? firstSpan : null),
    closest: (sel: string) => {
      if (sel === '[data-changed-files] button') return (over.inCard ?? true) && (over.tag ?? 'button') === 'button' ? el : null;
      if (sel === 'button') return (over.tag ?? 'button') === 'button' ? el : null;
      return null;
    },
  };
  return el;
}

test('v0.3.26 改动卡片文件行：点击改道 VS Code 打开（aria-describedby 的绝对路径 / 相对路径两形态）', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const started = b.parentMessages.length;
    const openFiles = () => b.parentMessages.slice(started).filter((m) => m.kind === 'openFile');

    // ① cwd 已知：隐藏 span 是已解析的绝对路径
    b.elementsById.set('r1-0', { textContent: '/ws/src/bridge/host.ts' });
    const r1 = clickFile(b, mkChangedRow({ describedBy: 'r1-0', rowText: 'src/bridge/host.ts' }), { detail: 1 });
    assert.equal(openFiles().length, 1, '改动行应转发 openFile');
    assert.equal(openFiles()[0].path, '/ws/src/bridge/host.ts', '优先取 aria-describedby 指向的绝对路径');
    assert.equal(r1.prevented, 1, '命中应 preventDefault（阻止 DSH 切侧栏 diff）');
    assert.equal(r1.stopped, 1, '命中应 stopPropagation');
    assert.equal(openFiles()[0].kind, 'openFile', '复用既有 bridgeOpenFile 消息，宿主侧零改动');

    // ② cwd 缺失：隐藏 span 退回相对路径 → 照样转发（交宿主侧多基准解析）
    b.elementsById.set('r1-1', { textContent: 'src/a.ts' });
    clickFile(b, mkChangedRow({ describedBy: 'r1-1', rowText: 'a.ts' }), { detail: 1 });
    assert.equal(openFiles().length, 2);
    assert.equal(openFiles()[1].path, 'src/a.ts');

    // ③ getElementById 返回 null（describedBy 指向不存在的 id）→ 回退 row 首个子 span 文本
    clickFile(b, mkChangedRow({ describedBy: 'no-such-id', rowText: 'src/b.ts' }), { detail: 1 });
    assert.equal(openFiles().length, 3);
    assert.equal(openFiles()[2].path, 'src/b.ts', '描述元素缺失时回退 row 文本');

    // ④ 描述文本与 row 文本都不是路径 → 不拦、不抛错
    b.elementsById.set('r1-2', { textContent: '3 个文件' });
    const r4 = clickFile(b, mkChangedRow({ describedBy: 'r1-2', rowText: '+67 -10' }), { detail: 1 });
    assert.equal(openFiles().length, 3, '取不到路径时不得转发');
    assert.equal(r4.prevented + r4.stopped, 0, '取不到路径时应完全放行原事件');
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});

test('v0.3.26 改动行误拦面：header/折叠按钮、侧栏 review tab、hover 预览 span 一律放行', async () => {
  const fakeRealFetch = async (_input: unknown, _init: any) => jsonResponse(ACCEPT_BODY);
  const b = loadBridge({ fetch: fakeRealFetch });
  try {
    b.apply();
    b.emitWin('message', { kind: 'bridgeHello', token: 'tok', imageFallback: true });
    const started = b.parentMessages.length;
    const openFiles = () => b.parentMessages.slice(started).filter((m) => m.kind === 'openFile');

    // a) 卡片 header（aria-label=changes.openReview）：在卡片内但没有 aria-describedby → 放行
    const header = clickFile(b, mkChangedRow({ rowText: 'src/a.ts' }), { detail: 1 });
    assert.equal(openFiles().length, 0, 'header 按钮不得被拦');
    assert.equal(header.prevented + header.stopped, 0);

    // b) 侧栏 review tab 内的文件行：不在 [data-changed-files] 作用域 → 放行
    const sidebarRow = clickFile(b, mkChangedRow({ inCard: false, describedBy: 'r1-0', rowText: '/ws/src/a.ts' }), { detail: 1 });
    assert.equal(openFiles().length, 0, '侧栏 review tab 的行不得被拦');
    assert.equal(sidebarRow.prevented + sidebarRow.stopped, 0);

    // c) hover 预览是 span 而非 button：closest('[data-changed-files] button') 返回 null → 放行
    const previewSpan = clickFile(b, mkChangedRow({ tag: 'span', describedBy: 'r1-0', rowText: '/ws/src/a.ts' }), { detail: 1 });
    assert.equal(openFiles().length, 0, 'hover 预览（span）不得被拦');
    assert.equal(previewSpan.prevented + previewSpan.stopped, 0);

    // ④ 多击/选区守卫同样作用于改动行（有意比 DSH 原生更严）
    const dbl = clickFile(b, mkChangedRow({ describedBy: 'r1-0', rowText: 'src/a.ts' }), { detail: 2 });
    assert.equal(openFiles().length, 0, '双击改动行不应转发');
    assert.equal(dbl.prevented + dbl.stopped, 0);
    b.elementsById.set('r1-0', { textContent: '/ws/src/a.ts' });
    b.document.getSelection = () => ({ isCollapsed: false });
    const drag = clickFile(b, mkChangedRow({ describedBy: 'r1-0', rowText: 'src/a.ts' }), { detail: 1 });
    assert.equal(openFiles().length, 0, '有未折叠选区时不应转发');
    assert.equal(drag.prevented + drag.stopped, 0);
    b.document.getSelection = () => null;

    // ⑤ 未握手（纯浏览器）：改动行同样不拦，DSH 原生行为不变
    const b2 = loadBridge({ fetch: fakeRealFetch });
    try {
      b2.apply();
      const s2 = b2.parentMessages.length;
      b2.elementsById.set('r-0', { textContent: '/ws/src/a.ts' });
      clickFile(b2, mkChangedRow({ describedBy: 'r-0', rowText: 'src/a.ts' }), { detail: 1 });
      assert.equal(b2.parentMessages.slice(s2).filter((m) => m.kind === 'openFile').length, 0, '未握手不应转发');
    } finally {
      rmSync(b2.outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(b.outDir, { recursive: true, force: true });
  }
});
