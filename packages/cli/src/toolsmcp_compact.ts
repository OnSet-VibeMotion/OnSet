/**
 * 静态紧凑模式：直出核心工具精简 Schema、统一 tool_search 检索引擎与 tool_call 扩展执行定义。
 *
 * 顶层工具表全程静态不变（100% 保住 KV Prompt Cache 前缀命中，不发 list_changed），
 * 为全部 9 家编排后端与内置制作人每轮直省 ~75%-78% 工具 Schema Token，同时稳守 agy ACP ~32 KB 声明预算。
 */
import * as studioview from '@onset/engine/studioview';
import type { ParamValues } from './ops/op';
import {
  LegacyOnsetCallName,
  LegacyToolHelpName,
  ToolCallName,
  ToolCategories,
  ToolSearchName,
  toolCategory,
} from './toolsmcp_policy';
import type { JSONSchema, ToolCatalog, ToolDef } from './toolsmcp_schema';

const compactSummaryLimit = 40;
const compactParamDescLimit = 20;
const defaultSearchLimit = 8;

/** 禁止经 tool_call / onset_call 嵌套转发的控制与交互工具。 */
export const DirectOnlyTools: ReadonlySet<string> = new Set([
  'job_wait',
  'job_cancel',
  ToolSearchName,
  LegacyToolHelpName,
  ToolCallName,
  LegacyOnsetCallName,
  studioview.StudioAskToolName,
]);

function clipText(text: string, limit: number): string {
  const clean = text.trim();
  return clean.length > limit ? clean.slice(0, limit) + '…' : clean;
}

/** 递归精简嵌套 schema（如 studio_ask 的 questions[].options[]），仅保留必填字段短说明。 */
function compactSchemaNode(node: JSONSchema, keepDesc: boolean): JSONSchema {
  const { description, properties, items, ...rest } = node;
  const out: JSONSchema = { ...rest };
  if (keepDesc && description) out.description = clipText(description, compactParamDescLimit);
  if (properties) {
    const req = new Set(node.required ?? []);
    const nextProps: Record<string, JSONSchema> = {};
    for (const [k, v] of Object.entries(properties)) {
      nextProps[k] = compactSchemaNode(v, req.has(k));
    }
    out.properties = nextProps;
  }
  if (items) out.items = compactSchemaNode(items, false);
  return out;
}

/** 紧凑模式下压短直出工具的 schema：必填参数留短说明，选填参数仅留名称与类型（完整说明见 tool_search）。 */
export function compactToolDef(tool: ToolDef): ToolDef {
  const requiredSet = new Set(tool.inputSchema.required ?? []);
  const properties: Record<string, JSONSchema> = {};
  for (const [key, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
    const keepDesc = requiredSet.has(key) || (tool.name === 'hyperframes' && key === 'subcommand');
    properties[key] = compactSchemaNode(prop, keepDesc);
  }
  return {
    ...tool,
    description: clipText(tool.description, compactSummaryLimit),
    inputSchema: {
      ...tool.inputSchema,
      properties,
    },
  };
}

/** 顶层统一检索与完整参数文档入口 tool_search。 */
export function toolSearchToolDef(compact: boolean): ToolDef {
  return {
    name: ToolSearchName,
    description: compact
      ? '搜扩展工具或查任意工具完整参数与示例（传工具名、关键词、category 或 "*"）'
      : '查工具完整说明、参数与示例，或按中英文关键词/领域检索（传 "*" 列全表）',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '工具名、关键词或 "*"' },
        category: { type: 'string' },
        detail: { type: 'boolean' },
        limit: { type: 'integer' },
        tool: { type: 'string' },
      },
      additionalProperties: false,
    },
    help:
      '检索片场工具或查询任意工具的完整参数说明与调用示例（含未直出的扩展与第三方站工具）。\n\n' +
      '参数：\n' +
      '  query（字符串）：精确工具名、中英文关键词，或 "*" 列出按领域分组的全目录\n' +
      '  category（字符串）：按领域筛选，如 sfx、brand_kit、asset、media、series、cast、delivery、plugin\n' +
      '  detail（true / false）：true 时为全部命中项直接内联完整参数说明（命中 1–2 项时默认自动内联）\n' +
      '  limit（整数）：最多返回条数（缺省 8）\n' +
      '  tool（字符串）：query 的精确工具名别名（兼容旧写法）\n\n' +
      '例子：\n' +
      '  tool_search({"query": "品牌包"})\n' +
      '  tool_search({"query": "sfx_search"})\n' +
      '  tool_search({"category": "brand_kit", "detail": true})\n' +
      '  tool_search({"query": "*"})',
  };
}

/** 顶层统一扩展工具执行入口 tool_call（永久静默兼容旧别名 onset_call）。 */
export function toolCallToolDef(routed: ToolDef[]): ToolDef {
  const helpLines =
    routed.length > 0
      ? '\n\n当前经本工具调用的扩展工具：\n' + routed.map((t) => `  ${t.name}：${t.description}`).join('\n')
      : '';
  return {
    name: ToolCallName,
    description: '调用经 tool_search 查到的扩展或第三方站工具（也可调用任意 onset 操作）',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名' },
        arguments: { type: 'object', description: '参数对象' },
        wait_seconds: { type: 'number' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    help:
      '统一扩展工具调用入口：按操作名调用经 tool_search 查到的扩展或第三方站工具（也可调用任意片场操作）。\n\n' +
      '参数：\n' +
      '  tool（字符串，必填）：操作名（先用 tool_search 查参数与示例）\n' +
      '  arguments（对象）：传给该操作的参数对象，可省略\n' +
      '  wait_seconds（数字）：等待秒数，可省略\n\n' +
      '例子：\n' +
      '  tool_call({"tool": "sfx_search", "arguments": {"query": "whoosh"}})' +
      helpLines,
  };
}

/** 解析 tool_call / onset_call 传入的 arguments（兼容对象或 JSON 字符串）。 */
export function parseRoutedArguments(raw: unknown, callerName = ToolCallName): ParamValues {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${callerName} 的参数 arguments 不是合法 JSON 对象`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${callerName} 的参数 arguments 要是 JSON 对象`);
    }
    return parsed as ParamValues;
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as ParamValues;
  throw new Error(`${callerName} 的参数 arguments 要是对象`);
}

function isCatalogEntry(t: ToolDef): boolean {
  return Boolean(t.op) || t.name === studioview.StudioAskToolName;
}

function formatToolDetail(tool: ToolDef, catalog: ToolCatalog): string {
  const body = tool.help || tool.description;
  const routeNote = catalog.routedNames.has(tool.name)
    ? `\n\n调用方式：经 ${ToolCallName}({"tool": ${JSON.stringify(tool.name)}, "arguments": {...}}) 调用。`
    : '';
  return `### ${tool.name}\n${body}${routeNote}`;
}

/** 列出按领域分组的紧凑全目录，供 tool_search({"query": "*"}) 返回。 */
export function formatToolIndex(catalog: ToolCatalog): string {
  const entries = catalog.all.filter(isCatalogEntry);
  const grouped = new Map<string, ToolDef[]>();
  for (const tool of entries) {
    const cat = toolCategory(tool.name, Boolean(tool.external));
    const list = grouped.get(cat.id) ?? [];
    list.push(tool);
    grouped.set(cat.id, list);
  }
  const sections: string[] = [];
  for (const spec of ToolCategories) {
    const items = grouped.get(spec.id);
    if (!items || items.length === 0) continue;
    const lines = items.map((t) => {
      const tag = catalog.routedNames.has(t.name) ? ' [tool_call]' : '';
      return `  ${t.name}${tag}：${t.description}`;
    });
    sections.push(`【${spec.label} (${spec.id})】\n${lines.join('\n')}`);
  }
  const hint =
    catalog.routedNames.size > 0
      ? `共 ${entries.length} 项工具（直出 ${entries.length - catalog.routedNames.size}，扩展 ${catalog.routedNames.size}）。` +
        `查参数：${ToolSearchName}({"query": "<工具名>"})；调用带 [tool_call] 的扩展工具：${ToolCallName}({"tool": "<名>", "arguments": {...}})。`
      : `共 ${entries.length} 项工具。查参数：${ToolSearchName}({"query": "<工具名>"})。`;
  return `${hint}\n\n${sections.join('\n\n')}`;
}

function tokenizeQuery(query: string): string[] {
  const lower = query.toLowerCase().trim();
  if (lower === '') return [];
  const raw = lower.split(/[\s,，、/|:：_-]+/).filter(Boolean);
  const tokens = new Set<string>([lower, ...raw]);
  // 中文复合词补 2 字切分，避免「剪映导出」漏命中「剪映」与「导出」。
  for (const part of raw) {
    if (/^[\u4e00-\u9fff]{3,}$/.test(part)) {
      for (let i = 0; i < part.length - 1; i++) tokens.add(part.slice(i, i + 2));
    }
  }
  return [...tokens];
}

function categoryMatches(tool: ToolDef, wanted: string): boolean {
  const cat = toolCategory(tool.name, Boolean(tool.external));
  if (cat.id === wanted || cat.label.toLowerCase().includes(wanted)) return true;
  if (cat.keywords.some((kw) => kw.toLowerCase() === wanted || kw.toLowerCase().includes(wanted))) return true;
  if (tool.external && tool.external.station.toLowerCase().includes(wanted)) return true;
  return false;
}

function scoreTool(tool: ToolDef, query: string, tokens: string[]): number {
  const name = tool.name.toLowerCase();
  const cat = toolCategory(tool.name, Boolean(tool.external));
  const summary = tool.description.toLowerCase();
  const help = (tool.help || '').toLowerCase();
  const paramKeys = Object.keys(tool.inputSchema.properties ?? {})
    .join(' ')
    .toLowerCase();
  const catText = `${cat.id} ${cat.label} ${cat.keywords.join(' ')}`.toLowerCase();
  let score = 0;
  if (name === query) score += 200;
  else if (name.startsWith(query)) score += 110;
  else if (name.includes(query)) score += 75;
  if (cat.id === query || cat.keywords.some((kw) => kw.toLowerCase() === query)) score += 65;
  else if (catText.includes(query)) score += 45;
  if (summary.includes(query)) score += 55;
  else if (help.includes(query)) score += 30;
  if (paramKeys.includes(query)) score += 25;
  for (const tok of tokens) {
    if (tok === query || tok.length < 2) continue;
    if (name.includes(tok)) score += 32;
    if (catText.includes(tok)) score += 24;
    if (summary.includes(tok)) score += 22;
    else if (help.includes(tok)) score += 10;
    if (paramKeys.includes(tok)) score += 12;
  }
  return score;
}

/** 统一 tool_search（兼旧别名 tool_help）查询执行器：MCP 与内置 director 共用。 */
export function searchTools(
  catalog: ToolCatalog,
  input: ParamValues,
  options: { legacyHelp?: boolean } = {},
): { text: string; isError: boolean } {
  const rawQuery = String(input.query ?? input.tool ?? '').trim();
  const rawCategory = String(input.category ?? '')
    .trim()
    .toLowerCase();
  const detail = input.detail === true;
  const rawLimit =
    typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.trunc(input.limit) : defaultSearchLimit;
  const limit = Math.max(1, Math.min(30, rawLimit));

  const isWildcard = rawQuery === '*' || rawQuery.toLowerCase() === 'list';
  if ((rawQuery === '' || isWildcard) && rawCategory === '') {
    return { text: formatToolIndex(catalog), isError: false };
  }
  const effectiveQuery = isWildcard ? '' : rawQuery;

  const allByName = new Map(catalog.all.map((t) => [t.name, t]));
  const aliasTarget =
    effectiveQuery === LegacyToolHelpName
      ? (allByName.get(ToolSearchName) ?? allByName.get(LegacyToolHelpName))
      : effectiveQuery === LegacyOnsetCallName
        ? allByName.get(ToolCallName)
        : (allByName.get(effectiveQuery) ??
          catalog.all.find((t) => t.name.toLowerCase() === effectiveQuery.toLowerCase()));

  if (rawCategory === '' && effectiveQuery !== '' && aliasTarget) {
    const body = aliasTarget.help || aliasTarget.description;
    const routeNote = catalog.routedNames.has(aliasTarget.name)
      ? `\n\n调用方式：经 ${ToolCallName}({"tool": ${JSON.stringify(aliasTarget.name)}, "arguments": {...}}) 调用。`
      : '';
    return { text: body + routeNote, isError: false };
  }
  if (options.legacyHelp && rawCategory === '' && input.query === undefined) {
    return { text: `没有这个工具：${rawQuery}`, isError: true };
  }

  let candidates = catalog.all.filter(isCatalogEntry);
  if (rawCategory !== '') {
    candidates = candidates.filter((t) => categoryMatches(t, rawCategory));
  }

  let ranked: ToolDef[];
  if (effectiveQuery !== '') {
    const q = effectiveQuery.toLowerCase();
    const tokens = tokenizeQuery(effectiveQuery);
    ranked = candidates
      .map((tool) => ({ tool, score: scoreTool(tool, q, tokens) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aRouted = catalog.routedNames.has(a.tool.name) ? 1 : 0;
        const bRouted = catalog.routedNames.has(b.tool.name) ? 1 : 0;
        if (aRouted !== bRouted) return aRouted - bRouted;
        return a.tool.name.localeCompare(b.tool.name);
      })
      .map((entry) => entry.tool);
  } else {
    ranked = candidates.slice().sort((a, b) => a.name.localeCompare(b.name));
  }

  if (ranked.length === 0) {
    if (options.legacyHelp && rawQuery !== '' && rawCategory === '') {
      return { text: `没有这个工具：${rawQuery}`, isError: true };
    }
    const cats = ToolCategories.map((c) => `${c.id}(${c.label})`).join('、');
    return {
      text: `未找到与「${rawQuery || rawCategory}」匹配的工具。可用 ${ToolSearchName}({"query": "*"}) 查看全目录，或按 category 检索：${cats}`,
      isError: false,
    };
  }

  const shown = ranked.slice(0, limit);
  if (detail || shown.length <= 2) {
    const head =
      ranked.length > shown.length ? `共命中 ${ranked.length} 项（展示前 ${shown.length} 项完整说明）：\n\n` : '';
    return {
      text: head + shown.map((t) => formatToolDetail(t, catalog)).join('\n\n---\n\n'),
      isError: false,
    };
  }

  const lines = shown.map((t) => {
    const cat = toolCategory(t.name, Boolean(t.external));
    const via = catalog.routedNames.has(t.name) ? '[经 tool_call]' : '[直出]';
    return `  ${t.name} ${via}（${cat.label}）：${t.description}`;
  });
  const more =
    ranked.length > shown.length
      ? `（共 ${ranked.length} 项，已显示前 ${shown.length} 项）`
      : `（共 ${ranked.length} 项）`;
  return {
    text:
      `找到以下工具${more}：\n${lines.join('\n')}\n\n` +
      `查某个工具完整参数与示例：${ToolSearchName}({"query": "<工具名>"})；或带 "detail": true 一次查看全部命中参数。` +
      (shown.some((t) => catalog.routedNames.has(t.name))
        ? `\n调用带 [经 tool_call] 的扩展工具：${ToolCallName}({"tool": "<名>", "arguments": {...}})。`
        : ''),
    isError: false,
  };
}
