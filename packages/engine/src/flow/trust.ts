/**
 * 添加第三方站时告诉用户的实话：页面与操作的能力不一样，分开说。
 * - 页面在沙箱里（iframe sandbox、CSP、postMessage 桥），只能做清单里申请过的事（reads、network、uses、project）；
 * - 操作是用户电脑上的普通程序，清单管不住它。onset 只做到不把凭据交给它、事后列出越界写入（scope.ts）。
 * station_add 的输出与客户端设置页（Stations.tsx）用同一句话。
 */
import type { Manifest } from './external';

export const OpsTrustNotice =
  '它的操作是在你电脑上运行的程序，能读写你的文件、能联网；片场只限制它拿不到项目 .env 与片场的凭据，并在它写了声明范围之外的项目文件时告诉你。';

/** 页面申请的权限，一项一行（「看项目：……」）。 */
export function pagePermissionLines(m: Manifest): string[] {
  const out: string[] = [];
  const reads = [...new Set(m.pages.flatMap((p) => p.reads))];
  if (m.browser) out.push(`客户端内网页：${m.browser.origins.join('、')}（账号登录独立保存；仅用户操作可控制页面）`);
  if (m.permissions.project) out.push('看项目：镜头、制作进度、发布信息的概况');
  if (reads.length > 0) out.push(`读文件：${reads.join('、')}`);
  if (m.permissions.network.length > 0) out.push(`联网：${m.permissions.network.join('、')}`);
  if (m.permissions.uses.length > 0) out.push(`请你确认后执行：${m.permissions.uses.join('、')}`);
  return out;
}
