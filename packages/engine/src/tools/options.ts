/**
 * 各家工具的调用选项：推理强度、快速模式、上下文长度……每家支持的不一样，写法也不一样。
 *
 * 选项与模型一样跟着工具走（模型名只对那一家有意义，选项也是）：设置里的 ORCHESTRATOR_OPTIONS / RENDERER_OPTIONS /
 * OPTIMIZER_OPTIONS 只在写它的那一层、工具也是现在这一家时才用（config.load 的 modelFor），会话里的选项跟着会话选的工具。
 * 存成一行文字 `effort=high,fast=on`（formatAgentOptions），键与取值都只用字母、数字与 . _ -，原样进环境变量与配置文件。
 *
 * 2026-11 逐家实测（各 CLI 的 --help 与真实调用）：
 * - claude 2.1：`--effort low|medium|high|xhigh|max`；快速模式是设置项 fastMode，经 --settings 给（账号没开通时
 *   输出流的 fast_mode_state 是 off、附 fast_mode_disabled_reason，不报错）。
 * - codex 0.163：`-c model_reasoning_effort=…`，可选档位按模型（`codex debug models` 的 supported_reasoning_levels）；
 *   快速模式是服务档位 `-c service_tier="priority"`（目录里的 service_tiers：id priority、名字 Fast；不支持的档位只告警）。
 *   app-server 走 thread/start 的 serviceTier 与 turn/start 的 effort（agentrun/codexapp.ts）。
 * - qoder / qoder-intl 1.1.89：`--reasoning-effort auto|none|low|medium|high|xhigh|max|ultracode`、`--context-window <正整数>`
 *   （每个模型能用的上下文长度由服务端给，命令行列不出来，界面给常用的几档并可手填）。
 * - codebuddy 2.184：`--effort minimal|low|medium|high|xhigh|max`。
 * - opencode 2.1：推理档位是模型名后面的 `#变体`（`provider/model#high`），没有单独的参数；没选模型时无从附加。
 * - mcode（MiniMax Code）0.6.12：exec 的 `--effort default|low|medium|high|xhigh|max`，ACP 里是会话选项 thinkingEffort；
 *   只有模型表里报了档位的模型能调（M3 不能，M3.1-Flash 能），不支持时整轮报错，所以按模型收窄（perModel）。
 * - director（制作人，pi）：thinkingLevel off|minimal|low|medium|high|xhigh|max，经 stdin 的请求给。
 */

export type AgentOptions = Record<string, string>;

export interface OptionChoice {
  value: string;
  label: string;
}

export interface AgentOptionSpec {
  key: string;
  label: string;
  hint: string;
  /** choice：在 choices 里挑；toggle：on / off；number：正整数，presets 是常用的几档。 */
  kind: 'choice' | 'toggle' | 'number';
  choices?: OptionChoice[];
  presets?: OptionChoice[];
  /** 要先选了模型才有用（opencode 的变体附在模型名后面）。 */
  requiresModel?: boolean;
  /** 可选档位按模型变：界面用模型列表里那个模型的 efforts 收窄 choices（codex）。 */
  perModel?: boolean;
}

const effortLabels: Record<string, string> = {
  auto: '自动',
  none: '不推理',
  off: '不思考',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '极限（自动分派子任务）',
  ultracode: '极限（ultracode）',
};

function effort(values: string[], hint: string, extra: Partial<AgentOptionSpec> = {}): AgentOptionSpec {
  return { key: 'effort', label: '推理强度', hint, kind: 'choice', choices: values.map((value) => ({ value, label: effortLabels[value] ?? value })), ...extra };
}

function fast(hint: string): AgentOptionSpec {
  return { key: 'fast', label: '快速模式', hint, kind: 'toggle' };
}

const contextPresets: OptionChoice[] = [
  { value: '128000', label: '128K' },
  { value: '200000', label: '200K' },
  { value: '256000', label: '256K' },
  { value: '1000000', label: '1M' },
];

/** 一家工具支持哪些选项；不认识的工具没有。顺序就是界面上的顺序。 */
export function agentOptionSpecs(tool: string): AgentOptionSpec[] {
  switch (tool) {
    case 'claude':
      return [
        effort(['low', 'medium', 'high', 'xhigh', 'max'], '越高想得越久、越费额度；不选由 Claude Code 按模型决定'),
        fast('同一模型输出更快，按更高的价格计费；账号没开通时不生效'),
      ];
    case 'codex':
      return [
        effort(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], '越高想得越久、越费额度；可选档位随模型变，不选用 Codex 自己的设置', { perModel: true }),
        fast('优先处理（Fast 档位），更快、更耗用量；模型不支持时自动忽略'),
      ];
    case 'qoder':
    case 'qoder-intl':
      return [
        effort(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], '越高想得越久、越费额度；可选档位随模型变，不选用模型自己的默认', { perModel: true }),
        {
          key: 'context',
          label: '上下文长度',
          hint: '一次能带进去的内容（token）；只对支持的模型生效，不选用模型自己的默认',
          kind: 'number',
          presets: contextPresets,
          // 每个模型能选的长度由 Qoder 的模型表给（ModelOption.contextWindows），界面按它收窄。
          perModel: true,
        },
      ];
    case 'codebuddy':
      return [effort(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], '越高想得越久、越费额度；不选由 CodeBuddy 按模型决定')];
    case 'opencode':
      return [effort(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], '附在模型名后（provider/model#high），要先选模型；不是每个模型都有这些档位', { requiresModel: true })];
    case 'mcode':
      // 只有部分模型能调（MiniMax-M3 不能，M3.1-Flash 能），不支持的档位 mcode 直接报错；模型表（tools/mcodemodels.ts）按模型收窄。
      return [effort(['low', 'medium', 'high', 'xhigh', 'max'], '越高想得越久、越费额度；只有部分模型能调，不选用模型自己的默认', { perModel: true })];
    case 'director':
      return [{ ...effort(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], '只对支持思考的模型生效；不选按模型默认'), label: '思考强度' }];
    default:
      return [];
  }
}

const tokenRe = /^[A-Za-z0-9._-]+$/;

/** 选项文字的写法对不对（不看工具）：空，或逗号分隔的 键=值。 */
export function validOptionsText(text: string): boolean {
  if (text === '') return true;
  if (text.length > 200) return false;
  return text.split(',').every((pair) => {
    const at = pair.indexOf('=');
    return at > 0 && tokenRe.test(pair.slice(0, at)) && tokenRe.test(pair.slice(at + 1));
  });
}

/** 解析 `effort=high,fast=on`；写坏的项跳过（校验在写入时做，见 validateAgentOptions）。 */
export function parseAgentOptions(text: string | undefined): AgentOptions {
  const out: AgentOptions = {};
  for (const pair of (text ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (tokenRe.test(key) && tokenRe.test(value)) out[key] = value;
  }
  return out;
}

/** 写回一行文字：键按字母排，空值不写。fast=off 照写：会话里用它盖掉设置里的 fast=on（mergeAgentOptions）。 */
export function formatAgentOptions(options: AgentOptions): string {
  return Object.keys(options)
    .filter((key) => options[key] !== '')
    .sort()
    .map((key) => `${key}=${options[key]}`)
    .join(',');
}

/** 一家工具的选项文字合不合法；不合法返回原因，合法返回空串。 */
export function validateAgentOptions(tool: string, text: string): string {
  if (!validOptionsText(text)) return `选项写法不对：${text}（写成 effort=high,fast=on）`;
  const specs = agentOptionSpecs(tool);
  for (const [key, value] of Object.entries(parseAgentOptions(text))) {
    const spec = specs.find((s) => s.key === key);
    if (!spec) return `${tool} 没有选项 ${key}`;
    switch (spec.kind) {
      case 'toggle':
        if (value !== 'on' && value !== 'off') return `${spec.label}只能是 on 或 off`;
        break;
      case 'number':
        if (!/^[1-9][0-9]{0,8}$/.test(value)) return `${spec.label}要是正整数`;
        break;
      case 'choice':
        // codex 的档位按模型变（新模型会多出新档位），只查写法。
        // codex、qoder 的档位按模型变（新模型会多出新档位），只查写法。
        if (!spec.perModel && !spec.choices?.some((c) => c.value === value)) return `${spec.label}只能是 ${spec.choices?.map((c) => c.value).join(' ')}`;
        if (!/^[a-z]+$/.test(value)) return `${spec.label}写法不对：${value}`;
        break;
    }
  }
  return '';
}

/** 会话里选的选项逐项盖在设置上：设置给 effort=high,fast=on、会话给 fast=off，结果是 effort=high,fast=off。 */
export function mergeAgentOptions(base: string, over: string): string {
  return formatAgentOptions({ ...parseAgentOptions(base), ...parseAgentOptions(over) });
}

/** 只留这家工具认识、取值合法的项：设置写错了、或换了工具带过来的，调用时一律不传。 */
export function effectiveOptions(tool: string, text: string | AgentOptions | undefined): AgentOptions {
  const parsed = typeof text === 'string' || text === undefined ? parseAgentOptions(text) : text;
  const out: AgentOptions = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (validateAgentOptions(tool, `${key}=${value}`) === '') out[key] = value;
  }
  return out;
}

/** 命令行上的参数（claude、qoder、codebuddy；codex 的见 codexOptionOverrides）。 */
export function optionArgs(tool: string, options: AgentOptions): string[] {
  const o = effectiveOptions(tool, options);
  switch (tool) {
    case 'claude':
    case 'codebuddy':
    case 'mcode':
      return o.effort ? ['--effort', o.effort] : [];
    case 'qoder':
    case 'qoder-intl':
      return [...(o.effort ? ['--reasoning-effort', o.effort] : []), ...(o.context ? ['--context-window', o.context] : [])];
    default:
      return [];
  }
}

/** codex 的服务档位：快速模式是 priority（模型目录里叫 Fast）。 */
export const CodexFastTier = 'priority';

/** codex 的 -c 覆盖项（exec 与 exec resume 都认）。 */
export function codexOptionOverrides(options: AgentOptions): string[] {
  const o = effectiveOptions('codex', options);
  const out: string[] = [];
  if (o.effort) out.push('-c', 'model_reasoning_effort=' + JSON.stringify(o.effort));
  if (o.fast === 'on') out.push('-c', 'service_tier=' + JSON.stringify(CodexFastTier));
  return out;
}

/** claude 的设置项：快速模式开着时给 {fastMode: true}，并进 --settings。 */
export function claudeOptionSettings(options: AgentOptions): Record<string, unknown> {
  return effectiveOptions('claude', options).fast === 'on' ? { fastMode: true } : {};
}

/** opencode 的模型名：推理档位写成 #变体 附在后面；没选模型、或模型名里已经带了变体时不加。 */
export function opencodeModel(model: string, options: AgentOptions): string {
  const variant = effectiveOptions('opencode', options).effort;
  if (!variant || model === '' || model.includes('#')) return model;
  return model + '#' + variant;
}
