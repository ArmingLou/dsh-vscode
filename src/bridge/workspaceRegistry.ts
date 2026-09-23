// src/bridge/workspaceRegistry.ts — 从 DSH 的工作区注册表里读出「DSH 侧工作区路径」
// 职责：把 $DSH_HOME/storages/workspace.json 解析成候选基准目录列表，供文件链接的相对路径解析使用。
//
// 为什么需要它（v0.3.25）：DSH 前端产出的相对路径，其语义基准是**该会话的 cwd**，而扩展此前只有
// 「VS Code 窗口工作区根」一个 base —— 用户在 A 仓库开 DSH 会话、却在 B 仓库的 VS Code 窗口用面板时，
// 相对路径会被拼到 B 仓库根（用户实测：报 `Unable to resolve nonexistent file`）。
// 首选来源是 DSH RPC `session/list`（含各会话 cwd，按 updatedAt 由新到旧）；本模块是**不依赖网络/鉴权
// 的兜底来源**：DSH 的客户端工作区注册表在本地磁盘上，包含用户用过的全部工作区绝对路径。
// 纯函数、无 IO：读文件由调用方负责，形状不符一律返回空数组（宁可少候选，不可抛错打断点击链路）。

/** 注册表里最多取多少个候选路径（再多只会拖慢逐基准存在性探测；9 个实测工作区远小于上限） */
export const MAX_REGISTRY_WORKSPACES = 16;

/**
 * 解析 DSH 工作区注册表 JSON 文本 → 去重后的工作区绝对路径列表。
 *
 * 形状（dsh 0.1.7 实测）：`{ tables: { workspaces: { <workspaceId>: { path, title, sessionIds, ... } } } }`。
 * 防御式：非 JSON、缺 tables/workspaces、workspaces 非对象、path 非字符串一律跳过；不抛异常。
 *
 * @param raw workspace.json 的文本内容
 * @returns 去重、保序（注册表插入顺序）且不超过上限的绝对路径列表
 */
export function workspacePathsFromRegistry(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const tables = (parsed as Record<string, unknown>).tables;
  if (typeof tables !== 'object' || tables === null) return [];
  const workspaces = (tables as Record<string, unknown>).workspaces;
  if (typeof workspaces !== 'object' || workspaces === null || Array.isArray(workspaces)) return [];
  const paths: string[] = [];
  for (const entry of Object.values(workspaces as Record<string, unknown>)) {
    if (paths.length >= MAX_REGISTRY_WORKSPACES) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const path = (entry as Record<string, unknown>).path;
    if (typeof path === 'string' && path !== '' && !paths.includes(path)) paths.push(path);
  }
  return paths;
}
