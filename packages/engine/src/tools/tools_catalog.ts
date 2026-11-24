import { Tool as DirectorToolName } from '../director';

export const UserMessageMarker = '[[USER_MESSAGE]]';

/**
 * 所有合法的 AI CLI 工具名集合。
 * config、scene 等包共用此集合，新增工具时只需改这一处（加上
 * rendererInvocation、orchestratorInvocation、projectRulesFilename 的 switch）。
 * Go 里是 map[string]bool，这里用 Set：普通对象会让 "constructor" 之类的键查出真值。
 */
export const ValidTools: ReadonlySet<string> = new Set([
  'codex',
  'claude',
  'qoder',
  'qoder-intl',
  'codebuddy',
  'opencode',
  'mcode',
  'agy',
  'director',
]);

/**
 * 能当渲染工具的工具；RENDERER、scene.json 的 renderer、记忆的 applies_when.renderers 按这张表校验。
 */
export const ValidRenderers: ReadonlySet<string> = new Set([
  'codex',
  'claude',
  'qoder',
  'qoder-intl',
  'codebuddy',
  'opencode',
  'mcode',
  'agy',
  'director',
]);

/**
 * Qoder 有两个版本，账号与服务互不相通：国内版 `qoder`（命令 qoderclicn，状态在 ~/.qoder-cn）与国际版
 * `qoder-intl`（命令 qodercli，状态在 ~/.qoder）。两者的参数、输出流、会话与设置写法逐项相同（1.1.89 实测
 * --help 只差国内版多一个 config 子命令），所以除了命令名一律按同一家处理。
 */
export function isQoder(tool: string): boolean {
  return tool === 'qoder' || tool === 'qoder-intl';
}

/** Qoder 两个版本各自的命令名。 */
export function qoderBinary(tool: string): string {
  return tool === 'qoder-intl' ? 'qodercli' : 'qoderclicn';
}

/** 制作人的工具名（director.Tool）。 */
export const DirectorTool = DirectorToolName;

/** 按 claude 系 stream-json 解析的工具：制作人照这个格式输出，见 director。 */
export function claudeLikeStream(tool: string): boolean {
  return tool === 'claude' || isQoder(tool) || tool === 'codebuddy' || tool === DirectorTool;
}

/**
 * 各家指定模型的参数；model 为空时什么都不加，用那家工具自己的默认模型。
 * codex 用 -c model=…（TOML 字符串）而不是 -m：它是全局配置覆盖，exec 与 exec resume 都认。
 */
export function modelArgs(tool: string, model: string): string[] {
  if (model === '') return [];
  switch (tool) {
    case 'director':
      // 模型在 stdin 的请求里给（director.Request.model）。
      return [];
    case 'codex':
      return ['-c', 'model=' + JSON.stringify(model)];
    case 'qoder':
    case 'qoder-intl':
    case 'opencode':
      return ['-m', model];
    default:
      return ['--model', model];
  }
}

/** Claude Code 主会话缓存时长的开关（v2.1.242 起认，旧版本忽略）。 */
export const ClaudeCacheTTLEnv = 'CLAUDE_CODE_PROMPT_CACHE_TTL';

/**
 * 编排长会话要的额外环境：claude 的主会话缓存改成 1 小时。
 *
 * Claude Code 用 API key、云服务商或按量计费时，非交互（-p）的主会话缓存默认只活 5 分钟，订阅登录才默认 1 小时
 * （code.claude.com/docs/en/prompt-caching）。编排一轮里常常等镜头渲染十几分钟，缓存一过期，下一次调用就按 1.25 倍
 * 写入价把几十万 token 的整段上下文重写一遍；1 小时缓存写入是 2 倍、读两次就回本。2026-11 本机（订阅登录）实测
 * 编排与渲染的缓存写入本来就全是 1 小时的，所以这只对按 API 计费的用户有影响。
 * 只给编排：渲染器的调用一步接一步、很少空闲超过 5 分钟，写入价翻倍反而更贵。用户自己设了就不动。
 */
export function longSessionEnv(tool: string, env: Record<string, string | undefined>): Record<string, string> {
  if (tool !== 'claude' || (env[ClaudeCacheTTLEnv] ?? '') !== '') return {};
  return { [ClaudeCacheTTLEnv]: '1h' };
}

/**
 * 报告该工具能否由调用方预先指定新会话的 id。
 * codex 与 opencode 不能，它们的 id 要从输出流的第一条事件里读。
 */
export function presetSessionID(tool: string): boolean {
  return tool === 'claude' || isQoder(tool) || tool === 'codebuddy';
}

export interface Invocation {
  argv: string[];
  /** 要写进 stdin 的内容；空串表示不写。 */
  stdin: string;
  /** 要加进子进程环境的变量（opencode 的工具服务经 OPENCODE_CONFIG_CONTENT 给）。 */
  env?: Record<string, string>;
}

/**
 * 返回该工具会自动从工作目录向上递归读取的项目级指令文件名。
 *
 * 名字必须逐个工具核对，不能统一成 AGENTS.md：Claude Code 官方文档明写
 * "Claude Code reads CLAUDE.md, not AGENTS.md"，CodeBuddy 读的是产品名派生的
 * CODEBUDDY.md。写错文件名不会报错，只会让规则静默失效。
 */
export function projectRulesFilename(tool: string): string {
  switch (tool) {
    case 'codex':
    case 'qoder':
    case 'qoder-intl':
    case 'opencode':
    case 'mcode':
    case 'agy':
    case 'director':
      return 'AGENTS.md';
    case 'claude':
      return 'CLAUDE.md';
    case 'codebuddy':
      return 'CODEBUDDY.md';
    default:
      throw new Error(`未知工具：${tool}`);
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function extractUserMessages(tool: string, line: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (parsed !== null && !asObject(parsed)) return [];
  const event = asObject(parsed) ?? {};
  const texts: string[] = [];
  switch (tool) {
    case 'codex': {
      const item = asObject(event.item);
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
        texts.push(item.text);
      }
      break;
    }
    case 'claude':
    case 'qoder':
    case 'qoder-intl':
    case 'codebuddy':
    case 'director': {
      const content = asObject(event.message)?.content;
      if (event.type === 'assistant' && Array.isArray(content)) {
        for (const raw of content) {
          const block = asObject(raw);
          if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        }
      }
      break;
    }
    case 'opencode': {
      const part = asObject(event.part);
      if (event.type === 'text' && typeof part?.text === 'string') texts.push(part.text);
      break;
    }
    case 'mcode': {
      const item = asObject(event.item);
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.content === 'string') {
        texts.push(item.content);
      }
      break;
    }
    case 'agy': {
      const res = asObject(event.result);
      if (event.event === 'result' && typeof res?.response === 'string') texts.push(res.response);
      break;
    }
  }
  const messages: string[] = [];
  for (const text of texts) {
    for (const l of text.split('\n')) {
      if (l.startsWith(UserMessageMarker)) messages.push(l.slice(UserMessageMarker.length));
    }
  }
  return messages;
}
