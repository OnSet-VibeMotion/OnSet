/**
 * onset 工具服务的工具定义、schema 生成与调用前校验。
 */
import * as flow from '@onset/engine/flow';
import {
  allOps,
  markParamProvided,
  normalizeToolParams,
  type Op,
  opScopes,
  type ParamSpec,
  type ParamValues,
} from './ops/op';
import { defaultWaitSeconds } from './toolsmcp_jobs';
import {
  allowedForProjectFlow,
  HyperFramesSubcommands,
  instantOps,
  normalizeHyperFramesParams,
  orchestratorHyperFramesSubcommands,
  type Profile,
  sceneDispatchNote,
} from './toolsmcp_policy';

/** MCP 配置里给这个服务起的名字；claude 系的工具全名是 mcp__onset__<工具名>。 */
export const ToolsServerName = 'onset';

export interface JSONSchema {
  type: string;
  description?: string;
  items?: JSONSchema;
  enum?: readonly string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 一个工具：来自一条操作，或是服务自己的 job_wait / job_cancel / tool_help。 */
export interface ToolDef {
  /** 生成工具时的角色，用于执行时再次校验，不能只依赖 schema 限制。 */
  profile?: Profile;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  /** 对应的操作；任务工具为空。 */
  op?: Op;
  /** tool_help 返回的完整说明。 */
  help: string;
  /** 第三方站的操作：执行时落到 station_run。 */
  external?: { station: string; op: string };
}

/** 参数说明只留第一句：完整的在 tool_help 里，列表要短。 */
function firstSentence(text: string): string {
  const m = /^[^。；;\n]*/.exec(text);
  const head = (m ? m[0] : text).trim();
  return head.length > 80 ? head.slice(0, 80) + '…' : head;
}

function defaultNote(spec: ParamSpec): string {
  const d = spec.default;
  if (d === undefined || d === '' || d === false || d === 0 || (Array.isArray(d) && d.length === 0)) return '';
  return `（缺省 ${Array.isArray(d) ? d.join(',') : String(d)}）`;
}

function paramSchema(op: Op, key: string, spec: ParamSpec, profile: Profile): JSONSchema {
  const description = firstSentence(spec.description) + defaultNote(spec);
  if (op.name === 'hyperframes' && key === 'subcommand') {
    return {
      type: 'string',
      enum: profile === 'orchestrator' ? orchestratorHyperFramesSubcommands : HyperFramesSubcommands,
      description: 'HyperFrames 子命令',
    };
  }
  switch (spec.type) {
    case 'boolean':
      return { type: 'boolean', description };
    case 'integer':
      return { type: 'integer', description };
    case 'number':
      return { type: 'number', description };
    case 'strings':
      return { type: 'array', items: { type: 'string' }, description };
    default:
      // duration 也按字符串传（例如 "90s"）。
      return { type: 'string', description };
  }
}

function waitSchema(name: string): JSONSchema {
  // 每个工具都带这一项，说明要短；没跑完怎么办写在服务说明与 job_wait 里。
  return { type: 'number', description: `等待秒数（缺省 ${defaultWaitSeconds(name)}）` };
}

const visibleParams = (op: Op) => Object.entries(op.params).filter(([, s]) => !s.cliOnly);

const typeNames: Record<string, string> = {
  string: '字符串',
  boolean: 'true / false',
  integer: '整数',
  number: '数字',
  strings: '字符串数组',
  duration: '时长，例如 "30m"',
};

/** tool_help 的内容：完整说明、每个参数、例子。 */
function helpText(op: Op): string {
  const parts = [op.summary];
  if (op.description) parts.push(op.description);
  const params = visibleParams(op);
  if (params.length > 0) {
    const lines = params.map(
      ([k, s]) => `  ${k}（${typeNames[s.type]}${s.required ? '，必填' : ''}）：${s.description}${defaultNote(s)}`,
    );
    parts.push('参数：\n' + lines.join('\n'));
  }
  if (op.examples && op.examples.length > 0) parts.push('例子：\n' + op.examples.map((e) => '  ' + e).join('\n'));
  return parts.join('\n\n');
}

/**
 * 已装的第三方插件里编排工具能调的操作，做成不进操作表的 Op（参数校验、说明与内置工具同一套）。插件对所有项目生效。
 * 只能由用户触发的操作（trigger: user）不在这里：它们只有界面上的按钮。
 */
export function externalOps(): { op: Op; external: { station: string; op: string } }[] {
  const out: { op: Op; external: { station: string; op: string } }[] = [];
  for (const s of flow.loadStations().stations) {
    for (const m of s.manifest.ops) {
      if (m.trigger !== 'agent') continue;
      const params: Record<string, ParamSpec> = {};
      for (const [key, spec] of Object.entries(m.params)) {
        params[key] = {
          type: spec.type,
          description: spec.description,
          ...(spec.required ? { required: true } : {}),
          ...(spec.default !== undefined ? { default: spec.default as ParamSpec['default'] } : {}),
        };
      }
      const name = flow.toolName(s.manifest.id, m.name);
      const pluginNote = `由用户装的第三方插件「${s.manifest.name}」（${s.manifest.id} ${s.manifest.version}）提供，不是 onset 自带的工具。`;
      out.push({
        op: {
          name,
          cli: [],
          summary: `${m.summary}（第三方站「${s.manifest.name}」）`,
          description: (m.description ? m.description + '\n\n' : '') + pluginNote,
          ...(m.examples ? { examples: m.examples } : {}),
          params,
          scopes: ['orchestrator'],
          run: () => {
            throw new Error(`${name} 要经 station_run 执行`);
          },
        },
        external: { station: s.manifest.id, op: m.name },
      });
    }
  }
  return out;
}

/** 一次调用实际起哪条操作：第三方工具落到 station_run。 */
export function callTarget(tool: ToolDef, params: ParamValues): { name: string; params: ParamValues } {
  if (!tool.external) return { name: tool.op!.name, params };
  return {
    name: 'station_run',
    params: {
      station: tool.external.station,
      op: tool.external.op,
      params: JSON.stringify(params),
      project_root: '.',
    },
  };
}

/** 这一档位的全部工具。root 给了时（编排档位），再加上项目里第三方站的工具。 */
export function describeTools(profile: Profile, root = ''): ToolDef[] {
  const out: ToolDef[] = [];
  const extras = profile === 'orchestrator' && root !== '' ? externalOps() : [];
  const entries = [...allOps().map((op) => ({ op, external: undefined as ToolDef['external'] })), ...extras];
  for (const { op, external } of entries) {
    if (!external && !opScopes(op).includes(profile)) continue;
    if (!external && profile === 'orchestrator' && !allowedForProjectFlow(op.name, root)) continue;
    // 制作端仍需 inspect / snapshot 验收，但不能把 scene_run 降成单纯的出片工具。
    const inspecting = op.name === 'hyperframes' && profile === 'orchestrator';
    const rendererHF = op.name === 'hyperframes' && profile === 'renderer';
    const shownOp = inspecting
      ? {
          ...op,
          summary: '检查镜头合成与预览帧；渲染请派发镜头任务',
          description: sceneDispatchNote,
          params: {
            ...op.params,
            subcommand: { ...op.params.subcommand, description: 'HyperFrames 检查子命令，例如 lint、check、snapshot' },
          },
          examples: (op.examples ?? []).filter((e) => !e.includes('"render"')),
        }
      : rendererHF
        ? {
            ...op,
            summary: '运行本机 HyperFrames 文档与检查命令（画面检查与单帧细节优先用 scene_preview_check）',
          }
        : op;
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    for (const [key, spec] of visibleParams(op)) {
      properties[key] = paramSchema(op, key, spec, profile);
      if (spec.required) required.push(key);
    }
    if (external || !instantOps.has(op.name)) properties.wait_seconds = waitSchema(op.name);
    out.push({
      name: op.name,
      profile,
      // 列表里只放一句话：全部工具的完整说明有好几万字，每次请求都塞进 agent 的上下文太浪费。
      description: shownOp.summary,
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      },
      op,
      help: helpText(shownOp),
      ...(external ? { external } : {}),
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.push(
    {
      name: 'job_wait',
      description:
        '接着等一个还没跑完的任务（上一次调用返回的任务号），返回它的新输出；跑完时给出结果。等渲染等长任务时直接省略 wait_seconds（一次等满上限），不要每隔几十秒短轮询，也不要在等待期间反复读 render-*.user.log。',
      inputSchema: {
        type: 'object',
        properties: { job: { type: 'string', description: '任务号' }, wait_seconds: waitSchema('job_wait') },
        required: ['job'],
        additionalProperties: false,
      },
      help: '',
    },
    {
      name: 'job_cancel',
      description: '停掉一个还没跑完的任务。',
      inputSchema: {
        type: 'object',
        properties: { job: { type: 'string', description: '任务号' } },
        required: ['job'],
        additionalProperties: false,
      },
      help: '',
    },
    {
      name: 'tool_help',
      description: '查一个工具的完整说明、参数与例子（参数怎么填、产出什么、和其他步骤的关系）。',
      inputSchema: {
        type: 'object',
        properties: { tool: { type: 'string', description: '工具名' } },
        required: ['tool'],
        additionalProperties: false,
      },
      help: '',
    },
  );
  return out;
}

/**
 * 校验一次调用的参数，返回交给执行进程的参数。hyperframes 另守子命令白名单：
 * 与渲染提示词的禁令同一份——远端渲染、改动已装技能、交互与遥测命令一律不给。
 */
export function prepareCall(tool: ToolDef, input: ParamValues): ParamValues {
  const op = tool.op!;
  const { wait_seconds: _wait, ...rest } = input;
  const params = normalizeToolParams(op, rest);
  if (op.name === 'hyperframes') {
    normalizeHyperFramesParams(tool.profile, params);
    if (Array.isArray(params.args) && params.args.length > 0) markParamProvided(params, 'args');
  }
  return params;
}
