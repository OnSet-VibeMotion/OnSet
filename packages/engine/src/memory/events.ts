// 时间线事件。单独成文件，免得各文件互相引用 store.ts 时在模块初始化阶段成环。
import { sortedKeys } from '../gojson';

/** 时间线上的一条事件。 */
export interface Event {
  time: string;
  type: string;
  /** 0 表示没有（omitempty）。 */
  snapshot?: number;
  summary: string;
  /**
   * 事件所属的项目名（经历、导入）；整理、考试、快照这类记忆库级事件为空。
   * 记忆库所有项目共用，Studio 据此只显示当前项目的经历。
   */
  project?: string;
  /** Go 的 map[string]any；值已是可交给 gojson 的 JSON 值（nil 切片写成 null）。 */
  detail?: Record<string, unknown> | null;
}

// 时间线事件类型。
export const EventEpisode = 'episode';
export const EventConsolidate = 'consolidate';
export const EventTrial = 'trial';
export const EventDraftReject = 'draft_rejected';
export const EventExam = 'exam';
export const EventPromote = 'promote';
export const EventReject = 'reject';
export const EventDormant = 'dormant';
export const EventRollback = 'rollback';
export const EventManualEdit = 'manual_edit';
export const EventSnapshot = 'snapshot';

/** Event 的 JSON（字段顺序与 omitempty 同 Go；detail 是 map，按键排序）。 */
export function eventToJSON(e: Event): Record<string, unknown> {
  const detail = e.detail && Object.keys(e.detail).length > 0 ? sortedKeys(e.detail) : undefined;
  return {
    time: e.time,
    type: e.type,
    snapshot: e.snapshot ? e.snapshot : undefined,
    summary: e.summary,
    project: e.project || undefined,
    detail,
  };
}


/** 用户亲口说出、当场记下的偏好。 */
export const EventRemember = 'remember';
