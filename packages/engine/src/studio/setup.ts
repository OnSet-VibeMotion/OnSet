/**
 * 前置资源引导。移植自 internal/studio/setup.go。
 *
 * Studio 只读不下载（前置资源只由用户在终端里跑的 am setup 准备，见 ../prereqs）：
 * 网页列出缺哪几项、给出要复制的命令，用户跑完后重新检查。
 */
import { envMap } from '../envutil';
import { SetupCommand } from '../prereq';
import * as prereqs from '../prereqs';
import { methodNotAllowed, writeJSON } from './http';

/** /api/setup 的结果：前置资源的就绪状态，给首页与顶栏的引导用。 */
export interface SetupStatus {
  /** 做片必需的项（技能与 CLI）都已就绪；整片风格来源缺了只影响选风格。 */
  ready: boolean;
  items: prereqs.Status[];
  command: string;
}

function statusJSON(item: prereqs.Status): Record<string, unknown> {
  return {
    id: item.id,
    group: item.group,
    name: item.name,
    version: item.version || undefined,
    required: item.required,
    ready: item.ready,
    location: item.location,
  };
}

export function setupAPI(request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const resp: SetupStatus = { ready: true, items: prereqs.check(envMap()), command: SetupCommand };
  // 浏览器端到端测试不联网、也没有真实的前置资源：与跳过技能安装用同一个开关，
  // 当作全部就绪，不让引导挡住测试流程。
  if (process.env.AM_STUDIO_SKIP_SKILL_INSTALL === '1') for (const item of resp.items) item.ready = true;
  for (const item of resp.items) if (item.required && !item.ready) resp.ready = false;
  return writeJSON(200, { ready: resp.ready, items: resp.items.map(statusJSON), command: resp.command });
}
