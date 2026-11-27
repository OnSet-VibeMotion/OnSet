/**
 * 紧凑模式工具表裁剪与 onset_call 路由定义：
 * Antigravity CLI（agy acp）对 eager MCP 工具声明有约 32 KB 的总字节上限且不注册 call_mcp_tool，
 * 超过上限时按体积从小到大贪心保留、静默丢弃体积较大的核心主链路工具。
 * 紧凑模式将核心主链路以精简 schema 直出，其余扩展/第三方工具收敛到 onset_call，确保总声明体积远低于上限且能力 100% 可达。
 */
import { OnsetCallToolName } from './toolsmcp_policy';
import type { JSONSchema, ToolDef } from './toolsmcp_schema';

const compactSummaryLimit = 40;
const compactParamDescLimit = 20;
const compactRoutedListLimit = 1100;

function clipText(text: string, limit: number): string {
  const clean = text.trim();
  return clean.length > limit ? clean.slice(0, limit) + '…' : clean;
}

/** 紧凑模式下压短直出工具的 schema：必填参数留短说明，选填参数仅留名称与类型（完整说明见 tool_help）。 */
export function compactToolDef(tool: ToolDef): ToolDef {
  const requiredSet = new Set(tool.inputSchema.required ?? []);
  const properties: Record<string, JSONSchema> = {};
  for (const [key, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
    const keepDesc = requiredSet.has(key) || (tool.name === 'hyperframes' && key === 'subcommand');
    if (keepDesc && prop.description) {
      properties[key] = { ...prop, description: clipText(prop.description, compactParamDescLimit) };
    } else {
      const { description: _desc, ...rest } = prop;
      properties[key] = rest;
    }
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

/** 生成紧凑模式的通用扩展调用工具 onset_call。 */
export function onsetCallToolDef(routed: ToolDef[]): ToolDef {
  const names = routed.map((t) => t.name);
  let listed = '';
  let shown = 0;
  for (const name of names) {
    const next = listed === '' ? name : `${listed}、${name}`;
    if (next.length > compactRoutedListLimit) break;
    listed = next;
    shown++;
  }
  const suffix = shown < names.length ? ` 等共 ${names.length} 项（全表见 tool_help({"tool": "*"})）` : '';
  const summary =
    names.length > 0
      ? `调用其余片场扩展工具（参数见 tool_help）：${listed}${suffix}`
      : '调用任意片场操作工具（参数见 tool_help）';
  const helpLines =
    names.length > 0
      ? '\n\n经本工具调用的扩展工具：\n' + routed.map((t) => `  ${t.name}：${t.description}`).join('\n')
      : '';
  return {
    name: OnsetCallToolName,
    description: summary,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名' },
        arguments: { type: 'object', description: '参数对象' },
        wait_seconds: { type: 'number', description: '等待秒数' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    help:
      '紧凑模式通用调用入口：按操作名调用未直接暴露的扩展或第三方站工具（也可调用任意操作）。\n\n' +
      '参数：\n' +
      '  tool（字符串，必填）：操作名（完整参数先用 tool_help({"tool": "<名>"}) 查，或 tool_help({"tool": "*"}) 列全表）\n' +
      '  arguments（对象）：传给该操作的参数对象，可省略\n' +
      '  wait_seconds（数字）：等待秒数，可省略\n\n' +
      '例子：\n' +
      '  onset_call({"tool": "sfx_search", "arguments": {"query": "whoosh"}})' +
      helpLines,
  };
}
