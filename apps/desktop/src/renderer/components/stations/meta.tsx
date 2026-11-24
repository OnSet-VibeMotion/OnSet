import { api, post } from '../../api';
import type { StationInfo, StationRun, Task } from '../../types';
import { pluginVerb } from '../chat/model';

export const stepNames: Record<string, string> = {
  beat: '节拍',
  script: '口播稿',
  storyboard: '分镜',
  scene: '镜头',
  final: '成片',
  publish: '发布',
};

/** 站点 id 的说法（认得的步骤名，否则原样）。 */
export const stepLabel = (id: string) => stepNames[id] ?? id;

export const eventNames: Record<string, string> = {
  'turn.finished': '每轮对话结束后',
  'task.finished': '每个任务跑完后',
  'gate.confirmed': '你确认一个审核关卡后',
  'film.approved': '你确认成片可用后',
};

export const opNames: Record<string, string> = {
  scene_run: '渲染一个镜头',
  scene_run_all: '渲染全部镜头',
  scene_frames: '给镜头抽帧',
  concat: '拼接母版',
  review: '整片复查',
  validate_video: '成片校验',
  film_style_use: '换整片风格',
  voice_save: '存一个音色',
};

/**
 * 插件的操作是电脑上的普通程序，清单管不住它：添加前、详情里都照实说（与 station_add 的输出同一句话，
 * 引擎里是 flow.OpsTrustNotice）。页面的权限另列，不混成一张表，免得让人以为操作也受限。
 */
export const opsTrust =
  '它的操作是在你电脑上运行的程序，能读写你的文件、能联网；片场只限制它拿不到项目 .env 与片场的凭据，并在它写了声明范围之外的项目文件时告诉你。';

/** 插件图标：一块拼图，表示「接进来的一站」。 */
export function PluginGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M9 3.5a2 2 0 0 1 4 0V5h3.5A1.5 1.5 0 0 1 18 6.5V10h1.5a2 2 0 0 1 0 4H18v3.5a1.5 1.5 0 0 1-1.5 1.5H13v-1.5a2 2 0 0 0-4 0V19H5.5A1.5 1.5 0 0 1 4 17.5V14h1.5a2 2 0 0 0 0-4H4V6.5A1.5 1.5 0 0 1 5.5 5H9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 这一站放在制作路线的哪里，用用户的话说。 */
export function placement(s: StationInfo): string {
  const steps = [...new Set(s.nodes.map((n) => stepNames[n.step] ?? n.step))];
  const where = steps.length > 0 ? `在「${steps.join('、')}」这一步` : '不在制作路线上显示';
  return s.replaces ? `${where}，替换自带的这一站` : where;
}

/** 页面申请的权限：页面在沙箱里，只能做这些。已装的插件与取回待装的（reads 另给）用同一种说法。 */
export function pagePermissionLines(s: {
  browser?: StationInfo['browser'];
  permissions: StationInfo['permissions'];
  pages?: StationInfo['pages'];
  reads?: string[];
}): [string, string][] {
  const out: [string, string][] = [];
  const reads = s.reads ?? [...new Set((s.pages ?? []).flatMap((p) => p.reads))];
  if (s.browser) out.push(['客户端内网页', s.browser.origins.join('、') + '（账号登录独立保存）']);
  if (s.permissions.project) out.push(['看项目', '镜头、制作进度、发布信息的概况']);
  if (reads.length > 0) out.push(['读文件', reads.join('、')]);
  if (s.permissions.network.length > 0) {
    out.push(['联网', s.permissions.network.map((o) => o.replace(/^https?:\/\//, '')).join('、')]);
  }
  if (s.permissions.uses.length > 0) {
    out.push(['请你确认后执行', s.permissions.uses.map((u) => opNames[u] ?? pluginVerb(u) ?? u).join('、')]);
  }
  return out;
}

/** 插件接进来的地方（自动执行、提供配音、给渲染器的技能……），用用户的话列出来。 */
export function permissionLines(s: StationInfo): [string, string][] {
  const out: [string, string][] = [];
  for (const h of s.hooks) {
    const op = s.ops.find((o) => o.name === h.op);
    out.push(['自动执行', `${eventNames[h.on] ?? h.on}：${op?.summary ?? h.op}`]);
  }
  if (s.provides?.tts) out.push(['提供配音', `${s.provides.tts}（在设置的「配音」里选它）`]);
  if (s.provides?.align) out.push(['提供字幕对齐', `${s.provides.align}（在设置的「字幕对齐」里选它）`]);
  for (const rs of s.renderer_skills ?? []) {
    out.push([
      '给渲染器的技能',
      `${rs.name}：${rs.summary}（${rs.scenes === 'all' ? '每个镜头都用，装上后所有项目里已渲染的镜头都要重渲染' : 'AI 点名的镜头才用'}）`,
    ]);
  }
  if (s.film_styles) out.push(['整片风格库', `${s.film_styles}（新建项目和「风格」里都能选到）`]);
  if ((s.skins ?? []).length > 0) out.push(['界面皮肤', `${s.skins.join('、')}（在设置的「外观」里选）`]);
  if (s.flow) out.push(['新的做法', `${s.flow.name}（新建项目时在「做法」里选）`]);
  if ((s.inserts ?? []).length > 0) out.push(['补充制作说明', `往这几个阶段里加了说明：${s.inserts.join('、')}`]);
  for (const sc of s.schedules ?? []) {
    const op = s.ops.find((o) => o.name === sc.op);
    const every = sc.every_minutes % 60 === 0 ? `${sc.every_minutes / 60} 小时` : `${sc.every_minutes} 分钟`;
    out.push(['定时执行', `客户端开着时每 ${every}：${op?.summary ?? sc.op}`]);
  }
  return out;
}

/** 发起一条插件操作并等它跑完（不需要项目的操作是用户级任务，设置里没打开项目也能跑）。 */
export async function runAndWait(path: string, payload: Record<string, unknown>): Promise<Task> {
  const { task_id } = await post<{ task_id: string }>(path, payload);
  for (;;) {
    await new Promise((r) => window.setTimeout(r, 400));
    const t = await api<Task>(`/api/tasks/${encodeURIComponent(task_id)}`);
    if (t.status === 'succeeded' || t.status === 'failed' || t.status === 'cancelled') return t;
  }
}

/** 插件写了它没声明会写的项目文件：照实列出来。文件已经写了，客户端撤销不了，只能告诉用户怎么恢复。 */
export function ScopeWarning({ run, label }: { run?: StationRun; label?: string }) {
  const files = run?.out_of_scope ?? [];
  if (files.length === 0) return null;
  const more = run?.out_of_scope_more ?? 0;
  const reserved = new Set(run?.reserved ?? []);
  return (
    <div className="station-scope" role="alert">
      <strong>
        {label ? `${label}：` : ''}
        {reserved.size > 0
          ? '它写了片场自己的文件，这次按失败处理'
          : `它改了 ${files.length + more} 个没声明会写的文件`}
      </strong>
      <ul>
        {files.map((f) => (
          <li key={f} className={reserved.has(f) ? 'reserved' : undefined}>
            {f}
          </li>
        ))}
        {more > 0 && <li className="more">……另有 {more} 个</li>}
      </ul>
      <span>文件已经写了。不该改的话，可以回退那一轮对话，或者用 git 恢复。</span>
    </div>
  );
}
