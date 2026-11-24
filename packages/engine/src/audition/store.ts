import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { type Attempt, load as loadScene, type Scene } from '../scene';
import type { Usage } from '../tools';
import {
  type Adoption,
  type Audition,
  auditionDir,
  type Contestant,
  Dir,
  type ExamInfo,
  type ExamRole,
  File,
  toSlash,
  type Verdict,
  type VerdictKind,
  VerdictKinds,
  type VoteInput,
} from './model';

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
  return { ...loadScene(path.join(root, c.workdir)), audition: true };
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
    exam: a.exam
      ? {
          relation: a.exam.relation,
          student: a.exam.student,
          teacher: a.exam.teacher,
          lessons: a.exam.lessons,
          applied: '',
        }
      : undefined,
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

/** 记下评判。已经评过的可以改判（以最后一次为准）；要选的胜者必须有产物。 */
export function vote(root: string, id: string, input: VoteInput, now = new Date()): Audition {
  const a = load(root, id);
  if (a.contestants.some((c) => c.status !== 'done')) throw new Error('还有选手没渲染完，等全部出结果再评');
  const kind = input.kind as VerdictKind;
  if (!VerdictKinds.includes(kind)) throw new Error(`评判只能是 ${VerdictKinds.join('、')}`);
  if (a.exam && (a.exam.applied === 'promoted' || a.exam.applied === 'rejected')) {
    throw new Error('这场人评考试的结论已经生效，不能改判；要再考就再开一场');
  }
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
