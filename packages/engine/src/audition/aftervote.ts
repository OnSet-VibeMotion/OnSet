/**
 * 评判之后的善后，命令行（scene_audition_vote）与客户端（POST /api/auditions/{编号}/vote）走同一个函数：
 * 记进跨项目的评判记录、同步范例库、人评考试的结论落到记忆上。
 */
import path from 'node:path';
import * as memory from '../memory';
import { load as loadScene } from '../scene';
import { recordVerdict, type Audition } from './audition';
import { applyExam, type ExamOutcome } from './exam';
import { syncExemplar } from './exemplars';

export function afterVote(root: string, memDir: string, a: Audition): { exam: ExamOutcome | null; warnings: string[] } {
  const warnings: string[] = [];
  const project = memory.projectName(root);
  try {
    recordVerdict(memDir, project, a, root);
  } catch (e) {
    warnings.push(`评判没能记进记忆库：${(e as Error).message}`);
  }
  let text = '';
  try {
    text = loadScene(path.join(root, a.scene_dir)).text;
  } catch {
    text = '';
  }
  try {
    syncExemplar(memDir, root, project, a, text);
  } catch (e) {
    warnings.push(`范例库没能更新：${(e as Error).message}`);
  }
  const exam = a.exam ? applyExam(memory.open(memDir), root, a) : null;
  return { exam, warnings };
}
