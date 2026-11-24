import type { StationPreview } from '../../types';
import { pagePermissionLines, stepLabel } from './meta';

/** 取回的插件、还没装上：/api/stations 任务的 result（studio/stations.ts，flow.StationPreview）。 */
export interface StagedPlugin {
  staged: string;
  preview: StationPreview;
}

/** 装上之前给你看这个插件的实情：它的操作、页面能做的、接进来的地方、还在试验的能力。点「装上」才对所有项目生效。 */
export function StagedConfirm({
  staged,
  onInstall,
  onCancel,
}: {
  staged: StagedPlugin;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const p = staged.preview;
  const u = p.update;
  const tools = p.ops.filter((o) => o.trigger === 'agent');
  const buttons = p.ops.filter((o) => o.trigger === 'user');
  const pagePerms = pagePermissionLines({ browser: p.browser, permissions: p.permissions, reads: p.reads });
  const rows: [string, string][] = [];
  if (p.replaces) rows.push(['制作路线', `顶替自带的「${p.replaces}」：${p.nodes.join('、')}`]);
  else if (p.nodes.length > 0) {
    rows.push([
      '制作路线',
      `${p.after ? `接在「${stepLabel(p.after)}」后面` : p.flow ? '只在它带来的做法里' : '每个项目的最后'}：${p.nodes.join('、')}`,
    ]);
  }
  if (p.flow) rows.push(['新的做法', `${p.flow}（新建项目时在「做法」里选）`]);
  if (p.film_styles) rows.push(['整片风格库', p.film_styles]);
  if ((p.skins ?? []).length > 0) {
    // 皮肤可以用插件自己的页面换掉桌宠，那个页面能替你答批准、发话、停下（不再另外确认）。
    const petNote = p.pages.length > 0 ? '；带页面的皮肤会用它换掉桌宠，选了之后它能替你答批准、发话和停下' : '';
    rows.push(['界面皮肤', `${p.skins.length} 套（装上后在设置的「外观」里选${petNote}）`]);
  }
  if (p.provides.tts) rows.push(['提供配音', p.provides.tts]);
  if (p.provides.align) rows.push(['提供字幕对齐', p.provides.align]);
  for (const h of p.hooks) rows.push(['自动执行', `${h.label}：${h.summary}`]);
  for (const sc of p.schedules) {
    rows.push([
      '定时执行',
      `客户端开着时每 ${sc.every_minutes % 60 === 0 ? `${sc.every_minutes / 60} 小时` : `${sc.every_minutes} 分钟`}：${sc.summary}`,
    ]);
  }
  for (const rs of p.renderer_skills) {
    rows.push([
      '给渲染器的技能',
      `${rs.name}：${rs.summary}（${rs.scenes === 'all' ? '每个镜头都用' : 'AI 点名的镜头才用'}）`,
    ]);
  }
  if (p.inserts.length > 0) rows.push(['补充制作说明', `往这几个阶段里加了说明：${p.inserts.join('、')}`]);
  return (
    <div className="stations-confirm staged-confirm" role="alertdialog" aria-label="确认添加插件" data-staged={p.id}>
      <div className="staged-head">
        <strong>{p.name}</strong>
        <span className="mono">
          {p.id} · {p.version}
          {p.commit ? ` · ${p.commit.slice(0, 12)}` : p.linked ? ' · 本机目录' : ''}
        </span>
        {p.description && <span>{p.description}</span>}
      </div>
      {p.linked && (
        <p className="staged-local">
          直接加载本地文件夹：{p.source.replace(/^link:/, '')}
          。改动立即生效，请保留这个文件夹；移动或删除后插件将无法使用。
        </p>
      )}
      {u && (
        <p className="staged-update">
          {u.changed
            ? `新版本：${u.old_version || '（本机已没有原来那一版）'} → ${u.new_version}`
            : `已是来源上的最新版本（${u.new_version}）`}
          {u.new_permissions.length > 0 && <> · 新申请：{u.new_permissions.join('、')}</>}
          {u.new_experimental.length > 0 && <> · 新用到的实验性能力：{u.new_experimental.join('、')}</>}
        </p>
      )}
      <dl className="station-perms">
        {tools.length > 0 && (
          <div>
            <dt>AI 能用的</dt>
            <dd>{tools.map((o) => o.summary).join('；')}</dd>
          </div>
        )}
        {buttons.length > 0 && (
          <div>
            <dt>要你点的</dt>
            <dd>{buttons.map((o) => o.summary).join('；')}</dd>
          </div>
        )}
      </dl>
      {p.ops_trust && <p className="station-trust">{p.ops_trust}</p>}
      {pagePerms.length > 0 && (
        <>
          <div className="station-prompt-label">它的页面能做的（在沙箱里，只能做这些）</div>
          <dl className="station-perms staged-page-perms">
            {pagePerms.map(([k, v]) => (
              <div key={k + v}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {rows.length > 0 && (
        <>
          <div className="station-prompt-label">它接进来的地方</div>
          <dl className="station-perms">
            {rows.map(([k, v]) => (
              <div key={k + v}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {p.experimental.length > 0 && (
        <p className="station-experimental">用到了实验性能力：{p.experimental.join('、')}，以后的版本可能调整</p>
      )}
      <p>
        装上后对这台电脑上的所有项目生效。
        {p.rerender_all && (
          <strong className="staged-rerender">
            它给每个镜头都带上渲染技能：所有项目里已经渲染好的镜头都会标成要重新渲染。
          </strong>
        )}
      </p>
      <div>
        <button className="primary" onClick={onInstall}>
          {u ? '换上' : '装上'}
        </button>
        <button onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}
