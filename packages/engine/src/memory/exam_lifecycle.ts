import { EventDormant, EventPromote, EventReject } from './events';
import {
  cloneMemory,
  type Memory,
  type Status,
  StatusActive,
  StatusDormant,
  StatusRejected,
  StatusTrial,
} from './memory';
import type { Snapshot } from './snapshot';
import type { Store } from './store';

/**
 * 人评考试（audition 包）通过：把这几条试用经验转为生效，考试编号记进 verified_by，快照不标「未经考试」。
 */
export function promoteExamined(s: Store, names: readonly string[], examID: string): Snapshot {
  if (examID === '') throw new Error('人评考试要有编号');
  const list: Memory[] = [];
  for (const name of names) {
    const m = s.find(name);
    if (m === null || m.status !== StatusTrial) throw new Error(`${name} 不是试用中的记忆`);
    list.push(m);
  }
  return promoteList(s, list, examID);
}

/** 把试用记忆转为生效并生成快照；修订生效时被修订的旧记忆转为沉睡。 */
export function promoteList(s: Store, list: readonly Memory[], examID: string): Snapshot {
  const names: string[] = [];
  for (const m of list) {
    setStatus(s, m, StatusActive, '', examID);
    names.push(m.name);
    if (m.revises !== '') {
      const old = s.find(m.revises);
      if (old !== null && old.status === StatusActive) {
        setStatus(s, old, StatusDormant, '', '');
        s.log({
          time: '',
          type: EventDormant,
          summary: `${old.name} 被修订 ${m.name} 取代，转为沉睡`,
          detail: { memory: old.name, replaced_by: m.name },
        });
      }
    }
  }
  const unverified = examID === '';
  let summary = '生效：' + names.join('、');
  summary += examID !== '' ? '（' + examID + ' 通过）' : '（人工确认，未经考试）';
  const snapshot = s.takeSnapshot(EventPromote, summary, unverified);
  s.log({
    time: '',
    type: EventPromote,
    snapshot: snapshot.id,
    summary,
    detail: { memories: names.length > 0 ? names : null, exam: examID },
  });
  return snapshot;
}

/** 改一条记忆的状态并写回（不改调用方手里的那份）。 */
export function setStatus(s: Store, original: Memory, status: Status, reason: string, examID: string): void {
  const m = cloneMemory(original);
  m.status = status;
  if (status === StatusRejected) m.rejected_reason = reason;
  else if (status === StatusActive) m.rejected_reason = '';
  if (examID !== '' && !m.verified_by.includes(examID)) m.verified_by = [...m.verified_by, examID];
  s.write(m);
  if (status === StatusRejected) {
    s.log({ time: '', type: EventReject, summary: `${m.name} 被拒：${reason}`, detail: { memory: m.name } });
  }
}

/**
 * 人工确认一条试用记忆生效（偏好只能走这里；经验通常由考试转为生效，
 * 人工确认的快照会标为未经考试）。
 */
export function promote(s: Store, name: string): Snapshot {
  const m = s.find(name);
  if (m === null) throw new Error(`记忆 ${name} 不存在`);
  if (m.status !== StatusTrial) throw new Error(`${name} 的状态是 ${m.status}，只有试用中的记忆能确认生效`);
  return promoteList(s, [m], '');
}

/** 人工拒绝一条试用记忆。 */
export function reject(s: Store, name: string, reason: string): void {
  const m = s.find(name);
  if (m === null) throw new Error(`记忆 ${name} 不存在`);
  if (m.status !== StatusTrial) throw new Error(`${name} 的状态是 ${m.status}，只有试用中的记忆能拒绝`);
  setStatus(s, m, StatusRejected, reason === '' ? '人工拒绝' : reason, '');
}

/** 让一条生效记忆转为沉睡，并生成快照。 */
export function retire(s: Store, name: string, reason: string): Snapshot {
  const m = s.find(name);
  if (m === null) throw new Error(`记忆 ${name} 不存在`);
  if (m.status !== StatusActive) throw new Error(`${name} 的状态是 ${m.status}，只有生效记忆能转为沉睡`);
  setStatus(s, m, StatusDormant, '', '');
  s.log({
    time: '',
    type: EventDormant,
    summary: `${name} 转为沉睡：${reason === '' ? '人工确认' : reason}`,
    detail: { memory: name },
  });
  return s.takeSnapshot(EventDormant, name + ' 转为沉睡', false);
}
