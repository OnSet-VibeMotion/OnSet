/**
 * 学习关系：谁（学生）向谁（老师）学、在哪类镜头上学。老师不写死，由人在试镜里的评判定：
 * 评判记录（auditions.jsonl）里两两比出胜负，胜负悬殊的提议成一条关系，人确认了才算数。
 *
 * 关系存在记忆库目录的 learning.json：与评判记录一样跨项目，模型的长短处不随项目变。
 * 选手的名字是「渲染工具/模型」（contestantKey）；两段式的选手（「实现者<设计者」）不进关系的统计：
 * 照别人的设计稿做出来的，说明不了实现者自己的本事，它们只进按镜头分派的推荐。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { modelMatches } from '../memory';
import { splitKey, type VerdictRecord } from './audition';

export const LearningFile = 'learning.json';

/** 提议的门槛：至少比过几场、老师的胜率至少多少。样本不够照样列出，标「样本少」，由人决定。 */
export const ProposalMinMatches = 3;
export const ProposalMinRate = 0.7;

export interface Relation {
  id: string;
  /** 学生与老师：「渲染工具/模型」。学生的模型按前缀匹配（与记忆的 applies_when.models 同一规则）。 */
  student: string;
  teacher: string;
  /** 只在这几类镜头上学；空是所有镜头。 */
  features: string[];
  created_at: string;
  note: string;
}

interface Dismissed {
  student: string;
  teacher: string;
  features: string[];
}

export interface Learning {
  relations: Relation[];
  dismissed: Dismissed[];
}

function file(dir: string): string {
  return path.join(dir, LearningFile);
}

export function loadLearning(dir: string): Learning {
  try {
    const raw = JSON.parse(fs.readFileSync(file(dir), 'utf8')) as Partial<Learning>;
    return {
      relations: Array.isArray(raw.relations) ? raw.relations.filter((r) => r && typeof r.id === 'string') : [],
      dismissed: Array.isArray(raw.dismissed) ? raw.dismissed : [],
    };
  } catch {
    return { relations: [], dismissed: [] };
  }
}

function saveLearning(dir: string, l: Learning): void {
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(file(dir), marshalIndent({ relations: l.relations, dismissed: l.dismissed }) + '\n');
}

function sameFeatures(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort(compareBytes).join(',') === [...b].sort(compareBytes).join(',');
}

/** 人确认一条学习关系。同一对、同一组题材已有时原样返回。 */
export function confirmRelation(dir: string, input: { student: string; teacher: string; features?: string[]; note?: string }, now = new Date()): Relation {
  const student = input.student.trim();
  const teacher = input.teacher.trim();
  if (student === '' || teacher === '') throw new Error('学生与老师都要写');
  if (student === teacher) throw new Error('学生和老师不能是同一个');
  if (student.includes('<') || teacher.includes('<')) throw new Error('照别人的设计稿做的组合不能当学生或老师');
  const features = [...new Set(input.features ?? [])].sort(compareBytes);
  const l = loadLearning(dir);
  const existing = l.relations.find((r) => r.student === student && r.teacher === teacher && sameFeatures(r.features, features));
  if (existing) return existing;
  const r: Relation = { id: 'rel-' + crypto.randomBytes(4).toString('hex'), student, teacher, features, created_at: now.toISOString(), note: (input.note ?? '').slice(0, 300) };
  l.relations.push(r);
  l.dismissed = l.dismissed.filter((d) => !(d.student === student && d.teacher === teacher && sameFeatures(d.features, features)));
  saveLearning(dir, l);
  return r;
}

export function removeRelation(dir: string, id: string): void {
  const l = loadLearning(dir);
  const next = l.relations.filter((r) => r.id !== id);
  if (next.length === l.relations.length) throw new Error(`学习关系 ${id} 不存在`);
  saveLearning(dir, { ...l, relations: next });
}

export function findRelation(dir: string, id: string): Relation {
  const r = loadLearning(dir).relations.find((x) => x.id === id);
  if (!r) throw new Error(`学习关系 ${id} 不存在`);
  return r;
}

/** 不要这条提议：以后不再提（确认同一条时会撤销这个决定）。 */
export function dismissProposal(dir: string, input: Dismissed): void {
  const l = loadLearning(dir);
  const features = [...new Set(input.features)].sort(compareBytes);
  if (!l.dismissed.some((d) => d.student === input.student && d.teacher === input.teacher && sameFeatures(d.features, features))) {
    l.dismissed.push({ student: input.student, teacher: input.teacher, features });
    saveLearning(dir, l);
  }
}

/** 学生这一方是不是这个渲染工具 + 模型（模型按前缀匹配；关系里没写模型时只看渲染工具）。 */
export function studentMatches(student: string, renderer: string, model: string): boolean {
  const s = splitKey(student);
  if (s.renderer !== renderer) return false;
  return s.model === '' || modelMatches(model, [s.model]);
}

function plain(key: string): boolean {
  return key !== '' && !key.includes('<');
}

/** 一场普通试镜里两位（不是两段式）的胜负：a 赢 1、b 赢 -1、差不多 0；说明不了的为 null。 */
function outcome(v: VerdictRecord, a: string, b: string): 1 | -1 | 0 | null {
  if (v.purpose === 'exam' || v.kind === 'none') return null;
  const keys = v.contestants.map((c) => c.key);
  if (!keys.includes(a) || !keys.includes(b)) return null;
  if (v.kind === 'tie') return 0;
  if (v.winner === a) return 1;
  if (v.winner === b) return -1;
  // 第三位赢了：这两位谁好说不清。
  return null;
}

export interface Proposal {
  student: string;
  teacher: string;
  /** 只在这类镜头上（空是全部）。 */
  features: string[];
  matches: number;
  teacher_wins: number;
  student_wins: number;
  ties: number;
  /** 老师的胜率（差不多算半场）。 */
  rate: number;
  /** 样本够、胜率够：可以放心确认。 */
  enough: boolean;
  auditions: string[];
}

function pairStats(rows: readonly VerdictRecord[], a: string, b: string, feature: string): Omit<Proposal, 'student' | 'teacher' | 'features' | 'enough' | 'rate'> & { aWins: number; bWins: number } {
  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  const auditions: string[] = [];
  for (const v of rows) {
    if (feature !== '' && !v.features.includes(feature)) continue;
    const o = outcome(v, a, b);
    if (o === null) continue;
    auditions.push(v.audition);
    if (o === 1) aWins++;
    else if (o === -1) bWins++;
    else ties++;
  }
  return { aWins, bWins, ties, matches: aWins + bWins + ties, teacher_wins: 0, student_wins: 0, auditions };
}

/**
 * 从评判记录里提议学习关系：每一对普通选手比过的场次里，赢得多的一方当老师。
 * 先看全部镜头，再看每一类题材——总体上说不清、某一类题材上很清楚的（三维场景里 A 明显更好），单独提一条。
 * 已经确认的与人说过不要的不再提。
 */
export function proposals(rows: readonly VerdictRecord[], learning: Learning): Proposal[] {
  const keys = new Set<string>();
  const features = new Set<string>();
  for (const v of rows) {
    if (v.purpose === 'exam') continue;
    for (const c of v.contestants) if (plain(c.key)) keys.add(c.key);
    for (const f of v.features) features.add(f);
  }
  const list = [...keys].sort(compareBytes);
  const out: Proposal[] = [];
  const taken = (student: string, teacher: string, fs: string[]) =>
    learning.relations.some((r) => r.student === student && r.teacher === teacher && sameFeatures(r.features, fs)) ||
    learning.dismissed.some((d) => d.student === student && d.teacher === teacher && sameFeatures(d.features, fs));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]];
      let overallEnough = false;
      for (const feature of ['', ...[...features].sort(compareBytes)]) {
        const st = pairStats(rows, a, b, feature);
        if (st.matches === 0 || st.aWins === st.bWins) continue;
        const teacher = st.aWins > st.bWins ? a : b;
        const student = teacher === a ? b : a;
        const teacherWins = Math.max(st.aWins, st.bWins);
        const studentWins = Math.min(st.aWins, st.bWins);
        const rate = (teacherWins + st.ties / 2) / st.matches;
        const enough = st.matches >= ProposalMinMatches && rate >= ProposalMinRate;
        if (feature === '') overallEnough = enough;
        // 分题材的只在总体说不清、这一类说得清时提，免得一对选手刷出一排。
        else if (overallEnough || !enough) continue;
        const fs = feature === '' ? [] : [feature];
        if (taken(student, teacher, fs)) continue;
        out.push({ student, teacher, features: fs, matches: st.matches, teacher_wins: teacherWins, student_wins: studentWins, ties: st.ties, rate, enough, auditions: st.auditions });
      }
    }
  }
  return out.sort((x, y) => Number(y.enough) - Number(x.enough) || y.rate - x.rate || y.matches - x.matches);
}

export interface ProgressPoint {
  at: string;
  audition: string;
  /** 从学生这边看：win、loss、tie。 */
  result: 'win' | 'loss' | 'tie';
  /** 到这一场为止最近 5 场里学生对老师的胜率（差不多算半场）。 */
  rate: number;
}

export interface ExamPoint {
  at: string;
  audition: string;
  /** trial：选中了带经验的那份；control：选中了不带的；tie：差不多或都不行。 */
  result: 'trial' | 'control' | 'tie';
}

export interface Progress {
  relation: string;
  points: ProgressPoint[];
  exams: ExamPoint[];
}

const progressWindow = 5;

function relevant(r: Relation, v: VerdictRecord): boolean {
  return r.features.length === 0 || r.features.some((f) => v.features.includes(f));
}

/** 学生对老师的盲评胜率怎么随时间变：学生在逼近老师时，曲线往上走。 */
export function progress(rows: readonly VerdictRecord[], r: Relation): Progress {
  const points: ProgressPoint[] = [];
  const exams: ExamPoint[] = [];
  const recent: number[] = [];
  for (const v of [...rows].sort((x, y) => compareBytes(x.at, y.at))) {
    if (!relevant(r, v)) continue;
    if (v.purpose === 'exam') {
      const exam = v.contestants.find((c) => c.role === 'trial');
      if (!exam) continue;
      // 这场考的是不是这条关系：学生是同一个、老师作参照。
      if (!v.contestants.some((c) => c.role === 'reference' && c.key === r.teacher)) continue;
      const result: ExamPoint['result'] = v.kind !== 'winner' ? 'tie' : exam.slot === winnerSlot(v) ? 'trial' : 'control';
      exams.push({ at: v.at, audition: v.audition, result });
      continue;
    }
    const student = v.contestants.find((c) => plain(c.key) && studentMatchesKey(r.student, c.key));
    if (!student) continue;
    const o = outcome(v, student.key, r.teacher);
    if (o === null) continue;
    recent.push(o === 1 ? 1 : o === 0 ? 0.5 : 0);
    if (recent.length > progressWindow) recent.shift();
    points.push({ at: v.at, audition: v.audition, result: o === 1 ? 'win' : o === -1 ? 'loss' : 'tie', rate: recent.reduce((x, y) => x + y, 0) / recent.length });
  }
  return { relation: r.id, points, exams };
}

/** 人评考试的评判记录里胜者是哪一格（winner 记的是「渲染工具/模型」，两份学生作品同名，要靠 winner_slot）。 */
function winnerSlot(v: VerdictRecord): string {
  return v.winner_slot ?? '';
}

function studentMatchesKey(student: string, key: string): boolean {
  const k = splitKey(key);
  return studentMatches(student, k.renderer, k.model);
}

export interface Recommendation {
  key: string;
  /** 在这类镜头上出场几次、赢了几次（差不多算半场）。 */
  appearances: number;
  wins: number;
  rate: number;
}

/**
 * 按镜头分派：在和这个镜头有共同题材的试镜里（镜头没有特征时看全部），谁赢得最多。
 * 只是推荐，换不换由人定；出场不到两次的不推荐。两段式的组合也在内（「实现者<设计者」）。
 */
export function recommend(rows: readonly VerdictRecord[], features: readonly string[], limit = 3): Recommendation[] {
  const stats = new Map<string, { appearances: number; wins: number }>();
  for (const v of rows) {
    if (v.purpose === 'exam' || v.kind === 'none') continue;
    if (features.length > 0 && !features.some((f) => v.features.includes(f))) continue;
    for (const c of v.contestants) {
      if (c.key === '') continue;
      const st = stats.get(c.key) ?? { appearances: 0, wins: 0 };
      st.appearances++;
      if (v.kind === 'winner' && v.winner === c.key) st.wins++;
      else if (v.kind === 'tie') st.wins += 0.5;
      stats.set(c.key, st);
    }
  }
  return [...stats.entries()]
    .filter(([, st]) => st.appearances >= 2)
    .map(([key, st]) => ({ key, appearances: st.appearances, wins: st.wins, rate: st.wins / st.appearances }))
    .sort((a, b) => b.rate - a.rate || b.appearances - a.appearances || compareBytes(a.key, b.key))
    .slice(0, limit);
}
