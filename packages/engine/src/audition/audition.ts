/**
 * 试镜：同一个镜头、同一份冻结输入，交给几位选手（渲染工具 + 模型）各渲染一遍，由人盲评。
 *
 * 一场试镜是项目里的 production/studio/auditions/<编号>/：audition.json 记选手、结果与评判，
 * 每位选手一个子目录（盲评标号 A、B、C……），里面是冻结的镜头输入与它渲染出的东西。
 * 放在 Studio 的状态目录里：不进每轮对话的快照（渲染器写的合成代码不该算成一轮的改动），
 * 也不是项目的镜头（镜头列表、文件归站都跳过它）。
 *
 * 盲评靠后端：评判之前 blindJSON 不给选手是谁、用了多少 token、跑了多久，界面拿不到就漏不出去。
 * 评判同时追加进用户级的 auditions.jsonl（recordVerdict）：谁赢了谁跨项目累积，后面按它提议学习关系。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, ProjectSkippedDirs } from '../fsutil';
import { compareBytes, marshal, marshalIndent } from '../gojson';
import { features, freezeInput } from '../memory';
import { archiveAttempt, blockExtraInputDirs, DesignFile, frameSource, inputFiles, load as loadScene, RecordFile as RecordFileName, type Attempt, type Scene } from '../scene';
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

export function auditionDir(root: string, id: string): string {
  return path.join(root, Dir, id);
}

function slotName(i: number): string {
  return String.fromCharCode(65 + i);
}

function toSlash(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

/**
 * 镜头输入的摘要：声明过的输入文件（与指纹、冻结同一份清单）、就近的 frame.md 与扩展块要带的目录，按相对路径排序后连同内容一起算。
 * 按字节算：试镜比的是「这几份画面出自这份输入」，任何改动都该让采用停下来。
 */
export function inputDigest(sc: Scene): string {
  const files = new Map<string, string>();
  for (const rel of inputFiles(sc)) files.set(toSlash(rel), path.join(sc.directory, rel));
  const frame = frameSource(sc);
  if (frame) files.set('frame.md', path.join(frame.directory, frame.file));
  for (const rel of blockExtraInputDirs(sc)) {
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.set(toSlash(path.relative(sc.directory, full)), full);
      }
    };
    walk(path.join(sc.directory, rel));
  }
  const hash = crypto.createHash('sha256');
  for (const rel of [...files.keys()].sort(compareBytes)) {
    let body: Buffer;
    try {
      body = fs.readFileSync(files.get(rel)!);
    } catch {
      body = Buffer.from('');
      hash.update('missing:');
    }
    hash.update(rel + '\0' + String(body.length) + '\0');
    hash.update(body);
  }
  return hash.digest('hex');
}

export interface CreateOptions {
  withMemory: boolean;
  /** 人评考试：entries 里的 role 必须是一份 control、一份 trial、一份 reference。 */
  exam?: Omit<ExamInfo, 'applied'> | null;
  /** 测试用：固定时间与洗牌。 */
  now?: Date;
  shuffle?: <T>(list: T[]) => T[];
}

function randomShuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 建一场试镜：给选手随机分标号、把镜头输入冻结进每位选手的目录、写 audition.json。
 * root 是项目根，sc 是项目里的镜头。
 */
export function create(root: string, sc: Scene, entries: readonly Entry[], opts: CreateOptions): Audition {
  if (entries.length < MinContestants) throw new Error(`试镜至少要 ${MinContestants} 位选手`);
  if (entries.length > MaxContestants) throw new Error(`试镜最多 ${MaxContestants} 位选手`);
  const seen = new Set<string>();
  for (const e of entries) {
    const key = [e.renderer, e.model, e.designer?.renderer ?? '', e.designer?.model ?? '', e.role ?? ''].join('\0');
    if (seen.has(key)) throw new Error(`选手重复：${entryLabel(e)}`);
    seen.add(key);
  }
  if (opts.exam) {
    const roles = entries.map((e) => e.role ?? '').sort();
    if (roles.join(',') !== 'control,reference,trial') throw new Error('人评考试要一份不带经验、一份带经验、一份老师作参照');
  }
  const sceneDir = path.relative(root, sc.directory);
  if (sceneDir.startsWith('..') || path.isAbsolute(sceneDir)) throw new Error('镜头不在项目里');
  const now = opts.now ?? new Date();
  let id = 'audition-' + stamp(now);
  for (let n = 2; fs.existsSync(auditionDir(root, id)); n++) id = 'audition-' + stamp(now) + '-' + n;
  const dir = auditionDir(root, id);
  // 人评考试：两份学生作品洗牌后分到 A、B，老师作参照固定是 R。
  const students = (opts.shuffle ?? randomShuffle)(entries.filter((e) => e.role !== 'reference'));
  const order = opts.exam ? [...students, ...entries.filter((e) => e.role === 'reference')] : students;
  const contestants: Contestant[] = order.map((e, i) => {
    const slot = e.role === 'reference' ? 'R' : slotName(i);
    const workdir = path.join(dir, slot);
    freezeInput(sc, workdir);
    return {
      slot,
      renderer: e.renderer,
      model: e.model,
      designer: e.designer?.renderer ?? '',
      designer_model: e.designer?.model ?? '',
      role: e.role ?? '',
      actual_model: '',
      workdir: toSlash(path.relative(root, workdir)),
      status: 'pending',
      outcome: '',
      output: '',
      seconds: 0,
      usage: null,
      problems: null,
      checks: null,
      error: '',
    };
  });
  const a: Audition = {
    id,
    created_at: now.toISOString(),
    scene_id: sc.id,
    scene_dir: toSlash(sceneDir),
    features: features(sc),
    with_memory: opts.withMemory,
    input_digest: inputDigest(sc),
    contestants,
    verdict: null,
    adopted: null,
    exam: opts.exam ? { ...opts.exam, applied: '' } : null,
  };
  save(root, a);
  return a;
}

export function auditionToJSON(a: Audition): Record<string, unknown> {
  return {
    id: a.id,
    created_at: a.created_at,
    scene_id: a.scene_id,
    scene_dir: a.scene_dir,
    features: a.features,
    with_memory: a.with_memory,
    input_digest: a.input_digest,
    contestants: a.contestants.map((c) => ({ ...c })),
    verdict: a.verdict,
    adopted: a.adopted,
    exam: a.exam ?? undefined,
  };
}

export function save(root: string, a: Audition): void {
  const dir = auditionDir(root, a.id);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, File), marshalIndent(auditionToJSON(a)) + '\n');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strList(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
}

function parse(raw: unknown): Audition | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (str(o.id) === '' || !Array.isArray(o.contestants)) return null;
  const contestants: Contestant[] = [];
  for (const item of o.contestants) {
    if (item === null || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const status = str(c.status);
    contestants.push({
      slot: str(c.slot),
      renderer: str(c.renderer),
      model: str(c.model),
      designer: str(c.designer),
      designer_model: str(c.designer_model),
      role: ['control', 'trial', 'reference'].includes(str(c.role)) ? (str(c.role) as ExamRole) : '',
      actual_model: str(c.actual_model),
      workdir: str(c.workdir),
      status: status === 'running' || status === 'done' ? status : 'pending',
      outcome: str(c.outcome),
      output: str(c.output),
      seconds: typeof c.seconds === 'number' ? c.seconds : 0,
      usage: c.usage && typeof c.usage === 'object' ? (c.usage as Usage) : null,
      problems: strList(c.problems),
      checks: strList(c.checks),
      error: str(c.error),
    });
  }
  let verdict: Verdict | null = null;
  if (o.verdict && typeof o.verdict === 'object') {
    const v = o.verdict as Record<string, unknown>;
    const kind = str(v.kind) as VerdictKind;
    if (VerdictKinds.includes(kind)) verdict = { kind, winner: str(v.winner), note: str(v.note), at: str(v.at) };
  }
  let adopted: Adoption | null = null;
  if (o.adopted && typeof o.adopted === 'object') {
    const v = o.adopted as Record<string, unknown>;
    if (str(v.slot) !== '') adopted = { slot: str(v.slot), at: str(v.at) };
  }
  let exam: ExamInfo | null = null;
  if (o.exam && typeof o.exam === 'object') {
    const e = o.exam as Record<string, unknown>;
    const applied = str(e.applied);
    exam = {
      relation: str(e.relation),
      student: str(e.student),
      teacher: str(e.teacher),
      lessons: strList(e.lessons) ?? [],
      applied: applied === 'promoted' || applied === 'rejected' || applied === 'undecided' ? applied : '',
    };
  }
  return {
    exam,
    id: str(o.id),
    created_at: str(o.created_at),
    scene_id: str(o.scene_id),
    scene_dir: str(o.scene_dir),
    features: strList(o.features) ?? [],
    with_memory: o.with_memory !== false,
    input_digest: str(o.input_digest),
    contestants,
    verdict,
    adopted,
  };
}

const idPattern = /^audition-[0-9]{8}-[0-9]{6}(-[0-9]+)?$/;

/** 读一场试镜；编号写法不对或不存在时抛错。 */
export function load(root: string, id: string): Audition {
  if (!idPattern.test(id)) throw new Error(`试镜编号不对：${id}`);
  const file = path.join(auditionDir(root, id), File);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`试镜 ${id} 不存在`);
  }
  const a = parse(raw);
  if (a === null) throw new Error(`试镜 ${id} 的记录读不懂`);
  return a;
}

/** 项目里全部试镜，新的在前；读不懂的跳过。 */
export function list(root: string): Audition[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(root, Dir));
  } catch {
    return [];
  }
  const out: Audition[] = [];
  for (const name of names) {
    if (!idPattern.test(name)) continue;
    try {
      out.push(load(root, name));
    } catch {
      // 跳过。
    }
  }
  return out.sort((a, b) => compareBytes(b.id, a.id));
}

/** 选手目录里的镜头（读它渲染时的那份 scene.json）。 */
export function contestantScene(root: string, c: Contestant): Scene {
  return loadScene(path.join(root, c.workdir));
}

/** 一位选手渲染完：把尝试记录里的结果抄进来。 */
export function applyAttempt(root: string, c: Contestant, attempt: Attempt | null, error: string): void {
  c.status = 'done';
  c.outcome = attempt?.outcome ?? 'failed';
  c.actual_model = attempt?.model ?? '';
  c.seconds = attempt?.seconds ?? 0;
  c.usage = attempt?.usage ?? null;
  c.problems = attempt?.problems ?? null;
  c.checks = attempt?.checks ?? null;
  c.error = attempt?.error || error;
  c.output = '';
  try {
    const sc = contestantScene(root, c);
    const out = path.join(sc.directory, sc.output);
    if (fs.statSync(out).isFile()) c.output = toSlash(path.relative(root, out));
  } catch {
    // 没有产物。
  }
}

/** 评判之前给界面看的样子：只有标号、进度与有没有产物，看不出是谁。 */
export function blindJSON(a: Audition): Record<string, unknown> {
  const full = auditionToJSON(a);
  if (a.verdict !== null) return { ...full, blind: false };
  return {
    ...full,
    blind: true,
    // 人评考试：考的是谁、向谁学、考哪几条经验都公开（两份学生作品是同一个模型），只藏哪份带了经验。
    exam: a.exam ? { relation: a.exam.relation, student: a.exam.student, teacher: a.exam.teacher, lessons: a.exam.lessons, applied: '' } : undefined,
    contestants: a.contestants.map((c) =>
      // 老师那份是参照，本来就公开。
      c.role === 'reference'
        ? { ...c }
        : {
            slot: c.slot,
            status: c.status,
            // 成没成看得见（没有产物的格子总要说明为什么空着），查出几处问题、是谁、花了多少都不给。
            outcome: c.status === 'done' ? c.outcome : '',
            output: c.output,
          },
    ),
  };
}

export interface VoteInput {
  kind: string;
  winner?: string;
  note?: string;
}

/** 记下评判。已经评过的可以改判（以最后一次为准）；要选的胜者必须有产物。 */
export function vote(root: string, id: string, input: VoteInput, now = new Date()): Audition {
  const a = load(root, id);
  if (a.contestants.some((c) => c.status !== 'done')) throw new Error('还有选手没渲染完，等全部出结果再评');
  const kind = input.kind as VerdictKind;
  if (!VerdictKinds.includes(kind)) throw new Error(`评判只能是 ${VerdictKinds.join('、')}`);
  if (a.exam && (a.exam.applied === 'promoted' || a.exam.applied === 'rejected')) throw new Error('这场人评考试的结论已经生效，不能改判；要再考就再开一场');
  let winner = '';
  if (kind === 'winner') {
    winner = input.winner ?? '';
    const c = a.contestants.find((x) => x.slot === winner);
    if (!c) throw new Error(`没有 ${winner} 这位选手`);
    if (c.output === '') throw new Error(`${winner} 没有产物，不能选它`);
    if (c.role === 'reference') throw new Error('老师那份是参照，从两份学生作品里选');
  }
  a.verdict = { kind, winner, note: (input.note ?? '').trim().slice(0, 500), at: now.toISOString() };
  save(root, a);
  return a;
}

// ---- 用户级的评判记录（跨项目） ----

export const VerdictLogFile = 'auditions.jsonl';

/** 评判记录的一行：谁对谁、在什么题材上、结果如何。 */
export interface VerdictRecord {
  at: string;
  project: string;
  /** 项目目录（绝对路径）：向老师学时要回去读两边的代码。 */
  project_dir: string;
  /** 普通试镜为空，人评考试是 exam。 */
  purpose: string;
  audition: string;
  scene_id: string;
  features: string[];
  with_memory: boolean;
  kind: VerdictKind;
  /** 胜者的「渲染工具/模型」；tie、none 时为空。 */
  winner: string;
  /** 胜者的标号（人评考试里两份学生作品同名，要靠它分）。 */
  winner_slot?: string;
  note: string;
  contestants: { slot: string; key: string; renderer: string; model: string; designer: string; outcome: string; problems: number; role: string }[];
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
export function contestantKey(c: Pick<Contestant, 'renderer' | 'model' | 'actual_model'> & Partial<Pick<Contestant, 'designer' | 'designer_model'>>): string {
  const own = toolKey(c.renderer, c.model !== '' ? c.model : c.actual_model);
  return c.designer ? own + '<' + toolKey(c.designer, c.designer_model ?? '') : own;
}

/**
 * 把一次评判追加进用户级的记录（dir 是记忆库目录）。同一场试镜改判时追加新的一行，读的时候以最后一行为准。
 */
export function recordVerdict(dir: string, project: string, a: Audition, projectDir = ''): void {
  if (a.verdict === null) return;
  const winner = a.verdict.kind === 'winner' ? a.contestants.find((c) => c.slot === a.verdict!.winner) : undefined;
  const row: VerdictRecord = {
    at: a.verdict.at,
    project,
    project_dir: projectDir,
    purpose: a.exam ? 'exam' : '',
    audition: a.id,
    scene_id: a.scene_id,
    features: a.features,
    with_memory: a.with_memory,
    kind: a.verdict.kind,
    winner: winner ? contestantKey(winner) : '',
    winner_slot: winner?.slot ?? '',
    note: a.verdict.note,
    contestants: a.contestants.map((c) => ({
      slot: c.slot,
      key: contestantKey(c),
      renderer: c.renderer,
      model: c.model !== '' ? c.model : c.actual_model,
      designer: c.designer ? toolKey(c.designer, c.designer_model) : '',
      outcome: c.outcome,
      problems: c.problems?.length ?? 0,
      role: c.role,
    })),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, VerdictLogFile), marshal(row) + '\n');
}

/** 读出全部评判记录；同一个项目的同一场试镜只留最后一行。 */
export function readVerdicts(dir: string): VerdictRecord[] {
  let body: string;
  try {
    body = fs.readFileSync(path.join(dir, VerdictLogFile), 'utf8');
  } catch {
    return [];
  }
  const latest = new Map<string, VerdictRecord>();
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line) as VerdictRecord;
      if (typeof row.audition !== 'string' || !VerdictKinds.includes(row.kind)) continue;
      latest.set(row.project + '\0' + row.audition, row);
    } catch {
      // 跳过坏行。
    }
  }
  return [...latest.values()].sort((a, b) => compareBytes(a.at, b.at));
}

// ---- 采用 ----

/**
 * 把一位选手渲染出的东西搬进项目里的镜头：先把镜头现有的产物与日志归档（与重渲染同一个归档函数），
 * 再拷入选手目录里除冻结输入以外的全部文件（产物、合成代码、日志、尝试记录）。
 * 渲染记录不拷：它按选手目录算，要由调用方按项目里的镜头重写（scene.json 的 renderer 也由调用方改）。
 *
 * 只采用评判过、产物合格的选手；镜头输入在试镜之后改过时拒绝——那几份画面已经不对应现在的镜头。
 */
export function adoptFiles(root: string, a: Audition, slot: string, target: Scene, now = new Date()): { contestant: Contestant; files: string[] } {
  if (a.verdict === null) throw new Error('先评判再采用：评判之前看不出选手是谁');
  const c = a.contestants.find((x) => x.slot === slot);
  if (c && c.role !== '') throw new Error('人评考试的作品不换进镜头：它只用来决定经验留不留');
  if (!c) throw new Error(`没有 ${slot} 这位选手`);
  if (c.outcome !== 'succeeded' || c.output === '') throw new Error(`${slot} 没有合格的产物，不能采用`);
  if (path.resolve(target.directory) !== path.resolve(root, a.scene_dir)) throw new Error('试镜的镜头与要采用的镜头不是同一个');
  if (inputDigest(target) !== a.input_digest) {
    throw new Error(`镜头 ${a.scene_id} 在试镜之后改过，这几份画面已经不对应现在的镜头；重新试镜`);
  }
  const source = contestantScene(root, c);
  // 不拷的是冻结进来的输入（按项目里的镜头算）；选手自己的设计稿（两段式）要跟着产物一起换进去。
  const skipFiles = new Set<string>(['scene.json', 'frame.md', RecordFileName, ...inputFiles(target).map(toSlash).filter((f) => f !== DesignFile)]);
  const skipDirs = blockExtraInputDirs(source).map(toSlash);
  archiveAttempt(target);
  const copied: string[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => compareBytes(x.name, y.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = toSlash(path.relative(source.directory, full));
      if (entry.isDirectory()) {
        if (ProjectSkippedDirs.has(entry.name) || skipDirs.some((d) => rel === d || rel.startsWith(d + '/'))) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || skipFiles.has(rel) || entry.name.endsWith('.live.json') || entry.name.startsWith('design-')) continue;
      const dest = path.join(target.directory, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
      copied.push(rel);
    }
  };
  walk(source.directory);
  a.adopted = { slot, at: now.toISOString() };
  save(root, a);
  return { contestant: c, files: copied };
}
