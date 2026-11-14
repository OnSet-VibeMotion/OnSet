/**
 * 人评考试：同一个镜头三份——学生不带新经验（control）、学生带新经验（trial）、老师（reference，公开作参照）。
 * 人从两份学生作品里选更好的（更接近老师的）一份：选中带经验的，经验生效，考试编号记进 verified_by；
 * 选中不带的，经验被拒；差不多或都不行，经验留在试用，再考一场。
 *
 * 画面好坏只有人判得了：这类经验（checked_by: audition.judged）机器考试考不了，只走这里。
 */
import * as memory from '../memory';
import { save, type Audition } from './audition';

export interface ExamOutcome {
  applied: 'promoted' | 'rejected' | 'undecided';
  /** 一句给人看的结论。 */
  summary: string;
  snapshot: number;
}

/** 评判之后把人评考试的结论落到记忆上，并写回 audition.json。不是人评考试或还没评判时返回 null。 */
export function applyExam(store: memory.Store, root: string, a: Audition): ExamOutcome | null {
  if (!a.exam || a.verdict === null) return null;
  const lessons = a.exam.lessons;
  let out: ExamOutcome;
  const picked = a.verdict.kind === 'winner' ? a.contestants.find((c) => c.slot === a.verdict!.winner) : undefined;
  if (picked?.role === 'trial') {
    const snapshot = memory.promoteExamined(store, lessons, a.id);
    out = { applied: 'promoted', summary: `你选了带经验的那份：${lessons.join('、')} 生效`, snapshot: snapshot.id };
  } else if (picked?.role === 'control') {
    for (const name of lessons) {
      const m = store.find(name);
      if (m !== null && m.status === memory.StatusTrial) memory.reject(store, name, `人评考试 ${a.id} 选了不带它的那份`);
    }
    out = { applied: 'rejected', summary: `你选了不带经验的那份：${lessons.join('、')} 不留`, snapshot: 0 };
  } else {
    out = { applied: 'undecided', summary: '差不多或都不行：经验留在试用，可以换个镜头再考一场', snapshot: 0 };
  }
  a.exam.applied = out.applied;
  save(root, a);
  return out;
}
