import fs from 'node:fs';
import path from 'node:path';
import { compareBytes, marshal } from '../gojson';
import { type Audition, contestantKey, toolKey, type VerdictKind, VerdictKinds } from './model';

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
  contestants: {
    slot: string;
    key: string;
    renderer: string;
    model: string;
    designer: string;
    outcome: string;
    problems: number;
    role: string;
  }[];
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
