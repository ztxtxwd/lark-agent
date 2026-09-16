/**
 * JSON Patch（RFC 6902）—— 基于 fast-json-patch 的薄封装。
 *
 * 供 modify_card 工具使用：模型输出一小段补丁而不是整卡 JSON。
 * 错误统一转成带操作序号的中文信息，由 agent 循环以 isError 结果回给模型修正；
 * 应用时不动输入文档（库内部深拷贝）。
 */
import fastJsonPatch from 'fast-json-patch';

type JsonPatchModule = typeof import('fast-json-patch');
// 包无 exports 字段且 index.js 用 Object.assign 逐出，ESM 具名导入探测不到；走 default interop
const { applyPatch } = fastJsonPatch as unknown as JsonPatchModule & {
  applyPatch: JsonPatchModule['applyPatch'];
};

export interface JsonPatchOp {
  op?: unknown;
  path?: unknown;
  from?: unknown;
  value?: unknown;
}

const KNOWN_OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

/** 把工具参数（JSON 字符串或已是数组）解析并做形状校验。 */
export function parseJsonPatch(raw: unknown): JsonPatchOp[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      throw new Error('json_patch 不是合法的 JSON 字符串');
    }
  }
  if (!Array.isArray(arr)) throw new Error('json_patch 必须是 RFC 6902 操作数组');
  if (arr.length === 0) throw new Error('json_patch 为空：没有任何要做的修改');

  arr.forEach((op, i) => {
    const label = `json_patch 第 ${i + 1} 个操作非法`;
    if (!op || typeof op !== 'object') throw new Error(`${label}：不是对象`);
    const o = op as JsonPatchOp;
    if (typeof o.op !== 'string' || !KNOWN_OPS.has(o.op)) throw new Error(`${label}：未知 op「${String(o.op)}」`);
    if (typeof o.path !== 'string') throw new Error(`${label}：path 必须是字符串`);
    if ((o.op === 'move' || o.op === 'copy') && typeof o.from !== 'string')
      throw new Error(`${label}：${o.op} 需要字符串类型的 from`);
    if ((o.op === 'add' || o.op === 'replace') && o.value === undefined)
      throw new Error(`${label}：${o.op} 需要 value`);
  });
  return arr as JsonPatchOp[];
}

/** 应用补丁；不修改 doc 本身。路径不存在等错误抛紧凑中文提示（不回显整棵树）。 */
export function applyJsonPatch(inputDoc: unknown, ops: JsonPatchOp[]): unknown {
  try {
    // mutateDocument=false：先克隆再应用，原始底稿保持不变；validateOperation=true 先走一遍深度校验
    return applyPatch(inputDoc, ops as never, true, false).newDocument;
  } catch (err) {
    const e = err as { message?: string; name?: string; index?: number; operation?: Record<string, unknown> };
    const HINTS: Record<string, string> = {
      OPERATION_PATH_UNRESOLVABLE: '补丁路径在底稿中不存在',
      OPERATION_PATH_CANNOT_OPEN: '补丁路径的父级无法打开',
      OPERATION_VALUE_REQUIRED: '缺少 value',
      OPERATION_VALUE_NOT_FOUND: 'from 指向的内容不存在',
      OPERATION_FROM_REQUIRED: '缺少 from',
      OPERATION_OP_INVALID: '无效的 op',
      TEST_OPERATION_FAILED: 'test 断言与实际值不符',
    };
    const idx = typeof e.index === 'number' ? `第 ${e.index + 1} 个操作` : '';
    const opStr = e.operation ? ` ${JSON.stringify(e.operation).slice(0, 140)}` : '';
    const reason = (e.name && HINTS[e.name]) || e.message || String(err);
    throw new Error(`应用 JSON Patch 失败${idx ? `（${idx}）` : ''}：${reason}${opStr}`);  }
}
