/**
 * 编排工具与 Studio 网页之间的两条通道。移植自 internal/studio/view.go。
 *
 * 与 am studio show 共用的部分（页面表、请求校验、收件目录）已在 ../studioview，这里只做
 * Go 版 studio 包里的同名入口：ValidateViewRequest、WriteViewRequest、drainViewInbox、viewInbox、
 * ViewState.Describe，免得两份实现漂移。
 */
import * as studioview from '../studioview';
import { studioRoot } from './turns';

export { KindView as kindView, ViewInboxEnv, ViewPages, ViewPollInterval, ViewProjectEnv, viewInteraction, viewPage } from '../studioview';
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
