/**
 * 编排工具与 Studio 网页之间的两条通道。移植自 internal/studio/view.go。
 *
 * 与 am studio show 共用的部分（页面表、请求校验、收件目录）已在 ../studioview，这里只做
 * Go 版 studio 包里的同名入口：ValidateViewRequest、WriteViewRequest、drainViewInbox、viewInbox、
 * ViewState.Describe，免得两份实现漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as studioview from '../studioview';
import { studioRoot } from './turns';

export { KindView as kindView, StepIDs, ViewInboxEnv, ViewPages, ViewPollInterval, ViewProjectEnv, viewInteraction, viewPage } from '../studioview';
export type { ViewPage, ViewRequest, ViewState } from '../studioview';

/** ViewState.Describe：把用户在看的位置写成一句话，附在发给编排工具的消息后面。 */
export const describeView = studioview.describeView;

/** ValidateViewRequest 检查页面与对象：镜头要存在，文件要在项目里且不是 .env。 */
export const validateViewRequest = studioview.validateViewRequest;

/** WriteViewRequest 把请求放进这一轮的收件目录。不在 Studio 里（没有收件目录）时返回 false。 */
export const writeViewRequest = studioview.writeViewRequest;

/** drainViewInbox 按写入顺序读出并删除收件目录里的请求；读不懂的直接丢掉。 */
export const drainViewInbox = studioview.drainViewInbox;

/** viewInbox 是一轮对话的收件目录，在 Studio 状态目录里（不进快照）。 */
export function viewInbox(project: string, turnID: string): string {
  return studioview.viewInbox(studioRoot(project), turnID);
}

/** 编排工具最近一次标出的制作步骤（studio_step），记在 Studio 状态目录里，跟着项目走。 */
export interface StepMark {
  step: string;
  at: string;
}

function stepMarkPath(project: string): string {
  return path.join(studioRoot(project), 'step.json');
}

export function writeStepMark(project: string, step: string, now = new Date()): void {
  if (!studioview.StepIDs.includes(step)) return;
  const file = stepMarkPath(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ step, at: now.toISOString() }) + '\n');
}

export function readStepMark(project: string): StepMark | null {
  try {
    const v = JSON.parse(fs.readFileSync(stepMarkPath(project), 'utf8')) as Partial<StepMark>;
    if (typeof v.step === 'string' && studioview.StepIDs.includes(v.step)) return { step: v.step, at: typeof v.at === 'string' ? v.at : '' };
  } catch {
    // 还没标过。
  }
  return null;
}
