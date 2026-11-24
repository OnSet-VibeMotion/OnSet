import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { BuiltinContents, StationInfo } from '../../types';
import { Icon } from '../Icon';
import type { RunAction } from '../Preview';
import { opsTrust, PluginGlyph, pagePermissionLines, permissionLines, placement } from './meta';
import { PluginActions } from './PluginActions';
import { StationSettingsForm } from './StationSettingsForm';

/** 内置功能带了什么：它在片场里登记的站点、工具、渲染技能、页面与流程，用用户的话列出。 */
export function BuiltinDetail({ contents }: { contents: BuiltinContents }) {
  const rows: [string, string][] = [];
  if (contents.flows.length > 0) rows.push(['做法', contents.flows.join('、')]);
  if (contents.nodes.length > 0) rows.push(['制作路线', contents.nodes.join('、')]);
  if (contents.ops.length > 0) rows.push(['AI 能用的', contents.ops.map((o) => o.verb || o.summary).join('；')]);
  if (contents.skills.length > 0) rows.push(['给渲染器的技能', contents.skills.join('、')]);
  if (contents.blocks.length > 0) rows.push(['镜头里的设定', contents.blocks.join('、')]);
  if (contents.pages.length > 0) rows.push(['页面', contents.pages.join('、')]);
  if (contents.film_styles.length > 0) rows.push(['整片风格库', contents.film_styles.join('、')]);
  if ((contents.skins ?? []).length > 0) rows.push(['界面皮肤', contents.skins.join('、')]);
  if (rows.length === 0) return null;
  return (
    <div className="station-detail builtin-detail">
      <dl className="station-perms">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * 一个第三方插件的「详情与设置」：盖在设置窗口上的弹窗（挂到 body 上，不受设置窗口的滚动与裁切）。
 * Esc、点背景、「关闭」都只关这一层，设置窗口留着。
 */
export function PluginDialog({
  station,
  onClose,
  children,
}: {
  station: StationInfo;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop plugin-dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section
        className="modal plugin-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${station.name} 详情与设置`}
        data-station={station.id}
      >
        <header className="modal-head">
          <span className="station-icon">
            <PluginGlyph />
          </span>
          <div className="plugin-dialog-title">
            <h2>{station.name}</h2>
            <span>
              {placement(station)} · {station.version}
            </span>
          </div>
          <span className="station-badge">第三方</span>
          <span className="spacer" />
          <button className="ghost icon" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <div className="stations plugin-dialog-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

export function PluginDetailBody({
  station,
  run,
  onOpenPage,
  onReload,
}: {
  station: StationInfo;
  run?: RunAction;
  onOpenPage?: (tab: string) => void;
  onReload: () => void;
}) {
  const perms = permissionLines(station);
  const pagePerms = pagePermissionLines(station);
  return (
    <div className="station-detail">
      <StationSettingsForm station={station} onSaved={onReload} />
      {station.pages.length > 0 && (
        <div className="station-page-links">
          <div className="station-prompt-label">它的页面</div>
          {onOpenPage ? (
            <div className="station-page-buttons">
              {station.pages.map((p) => (
                <button key={p.tab} onClick={() => onOpenPage(p.tab)}>
                  打开「{p.label}」
                </button>
              ))}
            </div>
          ) : (
            <span className="station-perms-note">打开一个项目后，可以在这里打开它的页面。</span>
          )}
        </div>
      )}
      <PluginActions station={station} run={run} onDone={onReload} />
      <dl>
        <dt>来源</dt>
        <dd className="mono">
          {station.source}
          {station.commit ? ` · ${station.commit.slice(0, 12)}` : station.linked ? ' · 本机目录，改动立即生效' : ''}
        </dd>
        {station.experimental.length > 0 && (
          <>
            <dt>实验性</dt>
            <dd className="station-experimental">
              用到了实验性能力：{station.experimental.join('、')}，以后的版本可能调整
            </dd>
          </>
        )}
        {station.ops.some((o) => o.trigger === 'agent') && (
          <>
            <dt>AI 能用的</dt>
            <dd>
              {station.ops
                .filter((o) => o.trigger === 'agent')
                .map((o) => o.summary)
                .join('；')}
            </dd>
          </>
        )}
        {station.ops.some((o) => o.trigger === 'user') && (
          <>
            <dt>要你点的</dt>
            <dd>
              {station.ops
                .filter((o) => o.trigger === 'user')
                .map((o) => o.summary)
                .join('；')}
            </dd>
          </>
        )}
        {station.pages.length > 0 && (
          <>
            <dt>页面</dt>
            <dd>{station.pages.map((p) => p.label).join('、')}</dd>
          </>
        )}
      </dl>
      {station.ops.length > 0 && (
        <>
          <div className="station-prompt-label">它的操作</div>
          <p className="station-trust">{opsTrust}</p>
        </>
      )}
      {pagePerms.length > 0 && (
        <>
          <div className="station-prompt-label">它的页面能做的</div>
          <dl className="station-perms station-page-perms">
            {pagePerms.map(([k, v]) => (
              <div key={k + v}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <span className="station-perms-note">页面在沙箱里运行，只能做上面这些；读文件、执行操作都要经过片场。</span>
        </>
      )}
      {perms.length > 0 && (
        <>
          <div className="station-prompt-label">它接进来的地方</div>
          <dl className="station-perms">
            {perms.map(([k, v]) => (
              <div key={k + v}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {station.prompt && (
        <>
          <div className="station-prompt-label">它交给 AI 的说明</div>
          <pre className="station-prompt">{station.prompt}</pre>
        </>
      )}
    </div>
  );
}
