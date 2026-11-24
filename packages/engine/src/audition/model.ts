import path from 'node:path';
import type { Usage } from '../tools';

/** 试镜在项目里的目录（相对项目根）。 */
export const Dir = 'production/studio/auditions';
export const File = 'audition.json';
/** 一场最少两位、最多六位选手：再多一屏放不下，也看不过来。 */
export const MinContestants = 2;
export const MaxContestants = 6;

/** 选手在渲染中、已经出结果（成或不成）。 */
export type ContestantStatus = 'pending' | 'running' | 'done';

/** 人评考试里一份作品的角色：学生不带新经验、学生带新经验、老师（参照，公开）。 */
export type ExamRole = 'control' | 'trial' | 'reference';

export interface Contestant {
  /** 盲评标号：A、B、C……，创建时随机分给选手，与报名顺序无关；人评考试的参照是 R。 */
  slot: string;
  renderer: string;
  /** 指定的模型；空是那家工具自己的默认。 */
  model: string;
  /** 两段式：先由这位写设计稿（渲染工具，空是没有设计者），再由选手照着做。 */
  designer: string;
  designer_model: string;
  /** 人评考试里的角色；普通试镜为空。 */
  role: ExamRole | '';
  /** 渲染时实际用的模型（从输出流读到的），读不到为空。 */
  actual_model: string;
  /** 选手的目录，相对项目根。 */
  workdir: string;
  status: ContestantStatus;
  /** 尝试记录的 outcome：succeeded、verification_failed、failed……还没出结果为空。 */
  outcome: string;
  /** 产物，相对项目根；没有产物时为空。 */
  output: string;
  seconds: number;
  usage: Usage | null;
  problems: string[] | null;
  checks: string[] | null;
  error: string;
}

/** 评判：选出一位、差不多、都不行。 */
export type VerdictKind = 'winner' | 'tie' | 'none';
export const VerdictKinds: readonly VerdictKind[] = ['winner', 'tie', 'none'];

export interface Verdict {
  kind: VerdictKind;
  /** kind 为 winner 时是胜者的标号。 */
  winner: string;
  /** 一句说明（为什么选它、哪里不行），可空。 */
  note: string;
  at: string;
}

export interface Adoption {
  slot: string;
  at: string;
}

/** 人评考试：哪条学习关系、考哪几条试用经验、各份的角色与结论。 */
export interface ExamInfo {
  /** 学习关系的编号（learning.ts）。 */
  relation: string;
  student: string;
  teacher: string;
  lessons: string[];
  /** promoted（选中带经验的那份，经验生效）、rejected（选中不带的那份，经验被拒）、undecided（差不多或都不行）；还没评为空。 */
  applied: '' | 'promoted' | 'rejected' | 'undecided';
}

export interface Audition {
  id: string;
  created_at: string;
  scene_id: string;
  /** 镜头目录，相对项目根。 */
  scene_dir: string;
  /** 镜头特征（memory.features），按题材累积胜负用。 */
  features: string[];
  /** 选手是否各自带上按自己召回的记忆；false 时谁都不带，只比模型本身。 */
  with_memory: boolean;
  /** 冻结时镜头输入的摘要：采用胜者前核对镜头这期间没改过。 */
  input_digest: string;
  contestants: Contestant[];
  verdict: Verdict | null;
  adopted: Adoption | null;
  /** 人评考试的设置；普通试镜为 null。 */
  exam: ExamInfo | null;
}

/** 报名的选手：渲染工具与可选的模型，可选的设计者（两段式），人评考试里的角色。 */
export interface Entry {
  renderer: string;
  model: string;
  designer?: { renderer: string; model: string } | null;
  role?: ExamRole;
}

export interface CreateOptions {
  withMemory: boolean;
  /** 人评考试：entries 里的 role 必须是一份 control、一份 trial、一份 reference。 */
  exam?: Omit<ExamInfo, 'applied'> | null;
  /** 测试用：固定时间与洗牌。 */
  now?: Date;
  shuffle?: <T>(list: T[]) => T[];
}

export interface VoteInput {
  kind: string;
  winner?: string;
  note?: string;
}

function parseTool(text: string, whole: string): { renderer: string; model: string } {
  const s = text.trim();
  const at = s.indexOf(':');
  const renderer = (at < 0 ? s : s.slice(0, at)).trim();
  const model = at < 0 ? '' : s.slice(at + 1).trim();
  if (renderer === '') throw new Error(`选手写法不对：${whole}（应为「渲染工具[:模型]」，两段式写「实现者<设计者」）`);
  return { renderer, model };
}

/**
 * 解析「渲染工具[:模型]」，两段式写「实现者<设计者」（两边都是「渲染工具[:模型]」）。
 * 模型名里可以有斜杠（opencode 的「服务商/模型」），所以只按第一个冒号切。
 */
export function parseEntry(text: string): Entry {
  const lt = text.indexOf('<');
  if (lt < 0) return parseTool(text, text);
  const implementer = parseTool(text.slice(0, lt), text);
  return { ...implementer, designer: parseTool(text.slice(lt + 1), text) };
}

export function entryLabel(e: Pick<Entry, 'renderer' | 'model'>): string {
  return e.model === '' ? e.renderer : `${e.renderer} · ${e.model}`;
}

export function auditionDir(root: string, id: string): string {
  return path.join(root, Dir, id);
}

export function toSlash(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

/** 「渲染工具/模型」；模型为空时只写渲染工具。渲染工具名里没有斜杠，按第一个斜杠切得回来（splitKey）。 */
export function toolKey(renderer: string, model: string): string {
  return model === '' ? renderer : renderer + '/' + model;
}

export function splitKey(key: string): { renderer: string; model: string } {
  const at = key.indexOf('/');
  return at < 0 ? { renderer: key, model: '' } : { renderer: key.slice(0, at), model: key.slice(at + 1) };
}

/**
 * 选手在统计里的名字：指定了模型用指定的，否则用实际读到的，都没有就只写渲染工具。
 * 两段式的选手写成「实现者<设计者」：照别人的设计稿做出来的，不算实现者自己的本事。
 */
export function contestantKey(
  c: Pick<Contestant, 'renderer' | 'model' | 'actual_model'> & Partial<Pick<Contestant, 'designer' | 'designer_model'>>,
): string {
  const own = toolKey(c.renderer, c.model !== '' ? c.model : c.actual_model);
  return c.designer ? own + '<' + toolKey(c.designer, c.designer_model ?? '') : own;
}
