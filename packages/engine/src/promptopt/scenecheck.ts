/**
 * 镜头画面描述检查：评估一个镜头的 prompt.md，判断要不要改，要改时给出改写稿。
 *
 * 结果先存成草稿（production/studio/prompt-checks/<镜头编号>.json，客户端状态目录，不进轮次快照），
 * 用户看过差异点「采用」才写进 prompt.md（applyCheck）。草稿记着当时 prompt.md 的摘要，
 * 之后 prompt.md 被改过就拒绝采用：那份改写稿是对着旧稿写的。提示词在 assets/optimizer/scene-check.md。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { extractJSONObject } from './extract';
import { inventedPaths, missing, missingRestrictions, sceneKeeps } from './guard';
import { fillTemplate, readTemplate } from './template';

/** 评估维度，顺序即界面上的顺序。 */
export const Dimensions = ['intent', 'concreteness', 'pacing', 'continuity', 'ambiguity'] as const;
export type Dimension = (typeof Dimensions)[number];

export const DimensionLabels: Record<Dimension, string> = {
  intent: '文意对应',
  concreteness: '画面具体度',
  pacing: '时长匹配',
  continuity: '交接与连贯',
  ambiguity: '歧义控制',
};

export type Decision = 'skip' | 'minor' | 'rewrite';

/** 交接：手法与靠什么接过去。 */
export interface HandoffEvidence {
  peer: string;
  device?: string;
  bridge?: string;
  style_shift?: string;
}

/** 给模型看的材料：只给这一镜的证据，不给整个项目。 */
export interface SceneEvidence {
  scene: {
    id: string;
    text?: string;
    seconds?: number;
    chapter?: string;
    summary?: string;
    visual_role?: string;
    style?: string;
  };
  handoff_in?: HandoffEvidence;
  handoff_out?: HandoffEvidence;
  neighbors?: { id: string; position: string; summary?: string; visual_role?: string }[];
  treatment?: string;
  canvas?: { width: number; height: number; fps: number };
  prompt: string;
}

/** treatment.md 只给这么多字：它是全片的设定，太长会把这一镜的材料淹掉。 */
export const TreatmentLimit = 6000;

export interface CheckResult {
  scores: Record<Dimension, number>;
  issues: string[];
  decision: Decision;
  /** 改写稿；skip 时没有，核对不合格时也没有（见 rejected）。 */
  prompt?: string;
  /** 改写稿为什么没有采用（漏了要保留的内容、编了素材……）。 */
  rejected?: string[];
}

export function buildCheckPrompt(evidence: SceneEvidence, retryNote = ''): string {
  const e: SceneEvidence = { ...evidence };
  if (e.treatment) {
    const chars = [...e.treatment];
    if (chars.length > TreatmentLimit) e.treatment = chars.slice(0, TreatmentLimit).join('') + '\n……（后面省略）';
  }
  let prompt = fillTemplate(readTemplate('scene-check.md'), e);
  if (retryNote !== '') prompt += `\n## 上一次的问题\n\n${retryNote}\n`;
  return prompt;
}

/** 回复不合格，整份都不能用（没有 JSON、维度不全）。 */
export class CheckRejected extends Error {
  constructor(
    message: string,
    readonly retryNote: string,
  ) {
    super(message);
    this.name = 'CheckRejected';
  }
}

/** 改写稿与原稿比，有哪些不合格；空数组是合格。 */
export function rewriteProblems(original: string, rewritten: string): string[] {
  const problems: string[] = [];
  const lost = missing(sceneKeeps(original), rewritten);
  if (lost.length > 0) problems.push(`漏掉了要原样保留的内容：${lost.join('、')}`);
  const loosened = missingRestrictions(original, rewritten);
  if (loosened.length > 0) problems.push(`丢掉了这些限制要求：${loosened.join(' / ')}`);
  const invented = inventedPaths(original, rewritten);
  if (invented.length > 0) problems.push(`出现了原稿没有的素材文件：${invented.join('、')}`);
  const before = [...original.trim()].length;
  const after = [...rewritten].length;
  if (after > Math.max(before * 2.5, before + 200)) problems.push(`改写稿太长（${after} 字，原稿 ${before} 字）`);
  if (before >= 80 && after < before * 0.5) problems.push(`改写稿删得太多（${after} 字，原稿 ${before} 字）`);
  return problems;
}

/**
 * 解析模型的回复。没有 JSON 或维度不全时抛 CheckRejected；改写稿不合格时不抛错，
 * 结果里去掉改写稿、在 rejected 里写明原因——评估本身仍然有用。
 */
export function parseCheck(raw: string, original: string): CheckResult {
  const obj = extractJSONObject(raw, 'scores');
  if (!obj) throw new CheckRejected('回复里没有要求的 JSON 对象', '只输出一个 JSON 对象（scores、issues、decision、prompt），前后不要写别的话。');
  const rawScores = obj.scores && typeof obj.scores === 'object' ? (obj.scores as Record<string, unknown>) : {};
  const scores = {} as Record<Dimension, number>;
  const absent: string[] = [];
  for (const d of Dimensions) {
    const v = rawScores[d];
    if (typeof v !== 'number' || !Number.isFinite(v)) absent.push(d);
    else scores[d] = Math.round(Math.min(100, Math.max(0, v)));
  }
  if (absent.length > 0) throw new CheckRejected(`评分缺了 ${absent.join('、')}`, `scores 必须有这五项数字：${Dimensions.join('、')}。`);
  const decision: Decision = obj.decision === 'skip' || obj.decision === 'minor' || obj.decision === 'rewrite' ? obj.decision : 'minor';
  const issues = Array.isArray(obj.issues) ? obj.issues.filter((i): i is string => typeof i === 'string' && i.trim() !== '').map((i) => i.trim()).slice(0, 3) : [];
  const result: CheckResult = { scores, issues, decision };
  if (decision === 'skip') return result;
  const rewritten = typeof obj.prompt === 'string' ? obj.prompt.trim() : '';
  if (rewritten === '' || rewritten === original.trim()) return { ...result, decision: 'skip' };
  const problems = rewriteProblems(original, rewritten);
  if (problems.length > 0) return { ...result, rejected: problems };
  return { ...result, prompt: rewritten.endsWith('\n') ? rewritten : rewritten + '\n' };
}

/**
 * 检查一次：整份回复不合格，或改写稿没过核对时，带着原因再试一次；第二次的改写稿仍不合格就只给评估。
 * call 是一次模型调用。
 */
export async function check(evidence: SceneEvidence, call: (prompt: string) => Promise<string>): Promise<CheckResult> {
  let note = '';
  for (let attempt = 0; ; attempt++) {
    const raw = await call(buildCheckPrompt(evidence, note));
    let result: CheckResult;
    try {
      result = parseCheck(raw, evidence.prompt);
    } catch (err) {
      if (!(err instanceof CheckRejected) || attempt >= 1) throw err;
      note = err.retryNote;
      continue;
    }
    if (!result.rejected || attempt >= 1) return result;
    note = `改写稿没有采用：${result.rejected.join('；')}。改写时把这些原样保留，宁可少改。`;
  }
}

// —— 草稿 ——

/** 草稿目录：客户端状态目录下，不进轮次快照，回退一轮不会动它。 */
export function checksDir(root: string): string {
  return path.join(root, 'production', 'studio', 'prompt-checks');
}

export interface PromptCheck extends CheckResult {
  /** 镜头编号。 */
  scene: string;
  /** 镜头目录，相对项目根。 */
  dir: string;
  /** 检查时 prompt.md 的 sha256。 */
  base_sha256: string;
  checked_at: string;
  tool: string;
  model: string;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function checkFile(root: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.')) throw new Error(`镜头编号不能用作文件名：${id}`);
  return path.join(checksDir(root), `${id}.json`);
}

export function writeCheck(root: string, check: PromptCheck): void {
  const file = checkFile(root, check.scene);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(check, null, 2) + '\n');
}

export function readCheck(root: string, id: string): PromptCheck | null {
  try {
    return JSON.parse(fs.readFileSync(checkFile(root, id), 'utf8')) as PromptCheck;
  } catch {
    return null;
  }
}

export function removeCheck(root: string, id: string): void {
  fs.rmSync(checkFile(root, id), { force: true });
}

/** 镜头目录里的 prompt.md；没有时为 null。 */
export function readPromptFile(sceneDir: string): string | null {
  try {
    return fs.readFileSync(path.join(sceneDir, 'prompt.md'), 'utf8');
  } catch {
    return null;
  }
}

/** 检查过之后 prompt.md 又被改过：草稿是对着旧稿写的，不能再采用。 */
export function checkOutdated(root: string, check: PromptCheck): boolean {
  const current = readPromptFile(path.join(root, check.dir));
  return current === null || sha256(current) !== check.base_sha256;
}

/** 采用草稿里的改写稿：核对 prompt.md 没变过，写进去，删掉草稿。返回写入的文件（相对项目根）。 */
export function applyCheck(root: string, id: string): string {
  const draft = readCheck(root, id);
  if (!draft) throw new Error(`${id} 没有待采用的检查结果，请先检查画面描述`);
  if (!draft.prompt) throw new Error(`${id} 的检查结果里没有可以采用的改写稿`);
  if (checkOutdated(root, draft)) throw new Error(`${id} 的 prompt.md 在检查之后改过了，这份改写稿是对着旧稿写的：请重新检查`);
  const rel = path.posix.join(draft.dir, 'prompt.md');
  atomicWrite(path.join(root, draft.dir, 'prompt.md'), draft.prompt);
  removeCheck(root, id);
  return rel;
}
