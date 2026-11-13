//
// Package memory 是渲染记忆：把每次渲染写成经历，整理成可检验的经验，
// 渲染前按镜头特征召回相关的几条注入提示词，经回放考试才转为长期记忆。
//
// 记忆属于 am，不属于某个渲染工具：存成纯文本放在用户级目录，召回在 am 侧
// 完成，所有渲染工具收到逐字相同的一段。设计见
// docs/superpowers/specs/2026-11-02-渲染记忆-design.md。
import crypto from 'node:crypto';
import { goTrimSpace } from '../gofmt';
import { goToLower } from './gostr';
import { decodeStrict, encodeMapping, type FieldSchema } from './yaml';

/** Kind 是记忆的层。经历不是 Memory，见 Episode。 */
export type Kind = string;

/** 经验：一条可由确定性校验器判定的约束。 */
export const KindLesson: Kind = 'lesson';
/** 偏好：人工反馈里的审美取向，无法机器判定，不参加考试。 */
export const KindPreference: Kind = 'preference';

/** 该层记忆在记忆库里的子目录。 */
export function kindDir(k: Kind): string {
  return k === KindPreference ? 'preferences' : 'lessons';
}

/** Status 是记忆的生命周期状态。 */
export type Status = string;

/** 只在考试里使用，不进入正式渲染。 */
export const StatusTrial: Status = 'trial';
/** 会被正式召回。 */
export const StatusActive: Status = 'active';
/** 考试未通过，保留原因，不会被召回。 */
export const StatusRejected: Status = 'rejected';
/** 已淡出或被修订取代，不再召回。 */
export const StatusDormant: Status = 'dormant';

export function validStatus(s: Status): boolean {
  return s === StatusTrial || s === StatusActive || s === StatusRejected || s === StatusDormant;
}

/**
 * Applies 是记忆的适用条件。features 与 keywords 都为空表示全局适用。
 *
 * renderers 与 models 是硬性范围，不参与打分之外的匹配：写了就只对这些渲染工具 /
 * 模型召回。同一类错误在不同模型上出现的频率差得很远，只在某个模型上成立的经验
 * 注入给别的模型，只会白占召回预算，甚至误导。
 *
 * 四项都是 omitempty，空数组与 Go 的 nil 等价。
 */
export interface Applies {
  features: string[];
  keywords: string[];
  /** 渲染工具 ID（codex、claude……），为空表示不限。 */
  renderers: string[];
  /**
   * 模型名，按不区分大小写的前缀匹配（gpt-6 匹配 gpt-6-astra），为空表示不限。
   * 当前模型未知时，限定了模型的记忆不召回。
   */
  models: string[];
}

export function newApplies(fields: Partial<Applies> = {}): Applies {
  return { features: [], keywords: [], renderers: [], models: [], ...fields };
}

export function appliesEmpty(a: Applies): boolean {
  return a.features.length === 0 && a.keywords.length === 0;
}

/** 报告记忆是否限定了渲染工具或模型。 */
export function appliesScoped(a: Applies): boolean {
  return a.renderers.length > 0 || a.models.length > 0;
}

/** 报告记忆是否适用于这个渲染工具与模型。 */
export function appliesInScope(a: Applies, renderer: string, model: string): boolean {
  if (a.renderers.length > 0 && !a.renderers.includes(renderer)) return false;
  if (a.models.length === 0) return true;
  return modelMatches(model, a.models);
}

/** 报告 model 是否命中 patterns 中任意一个（不区分大小写的前缀匹配）。 */
export function modelMatches(model: string, patterns: readonly string[]): boolean {
  model = goToLower(goTrimSpace(model));
  if (model === '') return false;
  for (const pattern of patterns) {
    const p = goToLower(goTrimSpace(pattern));
    if (p !== '' && model.startsWith(p)) return true;
  }
  return false;
}

/**
 * Meta 是记忆文件的 frontmatter。
 *
 * 效果统计不写在这里：它由经历聚合得出（见 stats.ts），并在生成快照时冻结进
 * 快照。写进记忆文件的话，并发渲染的镜头会同时改同一个文件，而且每次统计一变
 * 记忆内容摘要就变，所有召回它的镜头都会被判成 Stale。
 */
export interface Meta {
  name: string;
  description: string;
  status: Status;
  applies_when: Applies;
  /** 不是 omitempty：Go 的 nil 写成 null（JSON）/ [] （YAML）。 */
  checked_by: string[] | null;
  /** 只对偏好有意义：空表示全局，否则是项目目录名。 */
  scope: string;
  from_episodes: string[];
  verified_by: string[];
  /** 被本条修订的旧记忆名。本条生效时旧记忆转为沉睡。 */
  revises: string;
  rejected_reason: string;
}

/** Memory 是一条经验或偏好。 */
export interface Memory extends Meta {
  kind: Kind;
  body: string;
}

/** 零值记忆，调用方与测试构造时用。 */
export function newMemory(fields: Partial<Memory> = {}): Memory {
  return {
    name: '',
    description: '',
    status: '',
    applies_when: newApplies(),
    checked_by: null,
    scope: '',
    from_episodes: [],
    verified_by: [],
    revises: '',
    rejected_reason: '',
    kind: '',
    body: '',
    ...fields,
  };
}

/** 深拷贝一条记忆（Go 的值拷贝）。 */
export function cloneMemory(m: Memory): Memory {
  return {
    ...m,
    applies_when: {
      features: [...m.applies_when.features],
      keywords: [...m.applies_when.keywords],
      renderers: [...m.applies_when.renderers],
      models: [...m.applies_when.models],
    },
    checked_by: m.checked_by === null ? null : [...m.checked_by],
    from_episodes: [...m.from_episodes],
    verified_by: [...m.verified_by],
  };
}

function omitEmpty(list: string[]): string[] | undefined {
  return list.length > 0 ? list : undefined;
}

/** Memory 的 JSON（Go 的 json.Marshal(memory)：Meta 字段在前，再 kind、body）。 */
export function memoryToJSON(m: Memory): Record<string, unknown> {
  return {
    name: m.name,
    description: m.description,
    status: m.status,
    applies_when: {
      features: omitEmpty(m.applies_when.features),
      keywords: omitEmpty(m.applies_when.keywords),
      renderers: omitEmpty(m.applies_when.renderers),
      models: omitEmpty(m.applies_when.models),
    },
    checked_by: m.checked_by,
    scope: m.scope || undefined,
    from_episodes: omitEmpty(m.from_episodes),
    verified_by: omitEmpty(m.verified_by),
    revises: m.revises || undefined,
    rejected_reason: m.rejected_reason || undefined,
    kind: m.kind,
    body: m.body,
  };
}

const namePattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** 报告 name 能否作为记忆名（同时是文件名）。 */
export function validName(name: string): boolean {
  return namePattern.test(name);
}

const appliesSchema: FieldSchema = {
  struct: 'memory.Applies',
  fields: { features: 'strings', keywords: 'strings', renderers: 'strings', models: 'strings' },
};

const metaSchema = {
  struct: 'memory.Meta',
  fields: {
    name: 'string',
    description: 'string',
    status: 'string',
    applies_when: appliesSchema,
    checked_by: 'strings',
    scope: 'string',
    from_episodes: 'strings',
    verified_by: 'strings',
    revises: 'string',
    rejected_reason: 'string',
  } as Record<string, FieldSchema>,
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

/** 解析一个记忆文件。kind 由所在目录决定，不写在文件里。 */
export function parse(kind: Kind, content: string | Uint8Array): Memory {
  const text = (typeof content === 'string' ? content : Buffer.from(content).toString('utf8')).replaceAll('\r\n', '\n');
  if (!text.startsWith('---\n')) throw new Error('缺少 frontmatter（文件必须以 --- 开头）');
  const rest = text.slice('---\n'.length);
  const end = rest.indexOf('\n---\n');
  let front: string;
  let body = '';
  if (end >= 0) {
    front = rest.slice(0, end);
    body = rest.slice(end + '\n---\n'.length);
  } else if (rest.endsWith('\n---')) {
    front = rest.slice(0, -'\n---'.length);
  } else {
    throw new Error('frontmatter 没有以 --- 结束');
  }
  let raw: Record<string, unknown>;
  try {
    raw = decodeStrict(front, metaSchema);
  } catch (err) {
    throw new Error(`frontmatter 不合法：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const applies = (raw.applies_when ?? {}) as Record<string, unknown>;
  const checked = raw.checked_by;
  return {
    name: (raw.name as string | undefined) ?? '',
    description: (raw.description as string | undefined) ?? '',
    status: (raw.status as string | undefined) ?? '',
    applies_when: {
      features: strings(applies.features),
      keywords: strings(applies.keywords),
      renderers: strings(applies.renderers),
      models: strings(applies.models),
    },
    checked_by: Array.isArray(checked) ? (checked as string[]) : null,
    scope: (raw.scope as string | undefined) ?? '',
    from_episodes: strings(raw.from_episodes),
    verified_by: strings(raw.verified_by),
    revises: (raw.revises as string | undefined) ?? '',
    rejected_reason: (raw.rejected_reason as string | undefined) ?? '',
    kind,
    body: goTrimSpace(body),
  };
}

/** 把记忆写回文件内容。parse(format(m)) 与 m 等价。 */
export function format(m: Memory): string {
  const a = m.applies_when;
  const appliesZero = a.features.length === 0 && a.keywords.length === 0 && a.renderers.length === 0 && a.models.length === 0;
  const front = encodeMapping([
    ['name', m.name],
    ['description', m.description],
    ['status', m.status],
    [
      'applies_when',
      appliesZero
        ? undefined
        : [
            ['features', omitEmpty(a.features)],
            ['keywords', omitEmpty(a.keywords)],
            ['renderers', omitEmpty(a.renderers)],
            ['models', omitEmpty(a.models)],
          ],
    ],
    ['checked_by', m.checked_by ?? []],
    ['scope', m.scope || undefined],
    ['from_episodes', omitEmpty(m.from_episodes)],
    ['verified_by', omitEmpty(m.verified_by)],
    ['revises', m.revises || undefined],
    ['rejected_reason', m.rejected_reason || undefined],
  ]);
  return '---\n' + front + '---\n\n' + goTrimSpace(m.body) + '\n';
}

/**
 * 记忆「规则内容」的摘要：只含会进入提示词的部分（名字、描述、
 * 正文、适用条件与判定校验器），不含状态、来源与考试记录。
 *
 * 镜头的输入指纹用它：一条记忆从试用转为生效、补上一条来源经历，都不改变
 * 渲染器收到的文字，不该让召回它的镜头变成 Stale。
 */
export function ruleDigest(m: Memory): string {
  const a = m.applies_when;
  let text =
    `kind=${m.kind}\nname=${m.name}\ndescription=${m.description}\nfeatures=${a.features.join(',')}\nkeywords=${a.keywords.join(',')}\n` +
    `checked_by=${(m.checked_by ?? []).join(',')}\nscope=${m.scope}\n`;
  // 范围字段只在写了时计入，没写范围的老记忆摘要不变。
  if (appliesScoped(a)) text += `renderers=${a.renderers.join(',')}\nmodels=${a.models.join(',')}\n`;
  text += `\n${m.body}`;
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digestBytes(b: string | Uint8Array): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}
