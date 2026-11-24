import { useState } from 'react';
import { post } from '../../api';
import type { MarketItem } from '../../types';
import { PluginMarket, useMarket } from '../Market';
import { NativeDirectoryPicker } from '../NativeDirectoryPicker';
import type { RunAction } from '../Preview';
import { PluginGlyph, placement } from './meta';
import { BuiltinDetail, PluginDetailBody, PluginDialog } from './PluginDetails';
import { StagedConfirm, type StagedPlugin } from './StagedConfirm';
import { usePluginTask, useStations } from './useStations';

/** 设置页：内置功能与「我的插件」。插件装在这台电脑上，对所有项目生效；没有打开项目也能管。 */
/**
 * run 与 onOpenPage 只在打开了项目时给：要你点的操作是项目的写任务，插件的页面在项目的画面面板里打开。
 */
export function PluginSettings({
  version,
  onChanged,
  run,
  onOpenPage,
}: {
  version: number;
  onChanged?: () => void;
  run?: RunAction;
  onOpenPage?: (tab: string) => void;
}) {
  const [data, error, reload] = useStations(version);
  const [source, setSource] = useState('');
  const [open, setOpen] = useState<string>('');
  // 先取回、看清，再装：取回的插件放在暂存处，用户看过它自己的实情点「装上」才对所有项目生效。
  const [pending, setPending] = useState<StagedPlugin | null>(null);
  const market = useMarket(version);
  const task = usePluginTask(() => {
    reload();
    market.reload();
    onChanged?.();
  });
  const show = (result: unknown) => setPending(result as StagedPlugin);
  // 插件中心里的一版：同样只取到暂存给你看（/api/market 换成 station_add / station_update），点「装上」才装。
  const fromMarket = (kind: 'install' | 'update', item: MarketItem) => {
    if (!item.latest || pending !== null || task.busy !== '') return;
    task.start(
      `/api/market/${kind}`,
      kind === 'install' ? `取回「${item.name}」` : `取回「${item.name}」的新版本`,
      { id: item.id, commit: item.latest.commit },
      show,
    );
  };
  const marketUpdates = new Map(
    (market.data?.items ?? []).filter((it) => it.state === 'update').map((it) => [it.id, it]),
  );
  // 插件中心说装着的那一版撤回了、或插件不再维护：「我的插件」里也照实说一句。
  const marketWarnings = new Map(
    (market.data?.items ?? [])
      .filter((it) => it.state !== 'other_source' && (it.installed_yanked || (it.deprecated && it.installed_version)))
      .map((it) => [
        it.id,
        it.installed_yanked ? `这一版已被作者撤回：${it.installed_yanked}` : `作者已不再维护：${it.deprecated}`,
      ]),
  );
  const fetchPlugin = () => {
    const value = source.trim();
    if (value === '' || pending !== null || task.busy !== '') return;
    task.start('/api/stations', '取回插件', { source: value }, show);
  };
  const install = () => {
    if (!pending) return;
    task.start(
      `/api/stations/staged/${encodeURIComponent(pending.staged)}/install`,
      pending.preview.update ? '换上新版本' : '装上插件',
    );
    setPending(null);
    setSource('');
  };
  const cancel = () => {
    if (pending) void post(`/api/stations/staged/${encodeURIComponent(pending.staged)}/discard`).catch(() => {});
    setPending(null);
  };
  const builtins = (data?.stations ?? []).filter((s) => s.builtin);
  const thirdParty = (data?.stations ?? []).filter((s) => !s.builtin);
  return (
    <>
      {builtins.length > 0 && (
        <section className="stations builtin-stations" aria-label="内置功能">
          <div className="stations-head">
            <strong>内置功能</strong>
            <span>片场自带的功能，每个项目都有。用不用得上由片子的做法决定，点「详情」看它带了什么。</span>
          </div>
          <ul className="stations-list">
            {builtins.map((s) => (
              <li key={s.id} className="station-card" data-builtin={s.id}>
                <div className="station-row">
                  <span className="station-icon">
                    <PluginGlyph />
                  </span>
                  <div className="station-title">
                    <strong>{s.name}</strong>
                    <span>{s.description}</span>
                  </div>
                  {s.contents && (
                    <button className="link" onClick={() => setOpen(open === s.id ? '' : s.id)}>
                      {open === s.id ? '收起' : '详情'}
                    </button>
                  )}
                </div>
                {open === s.id && s.contents && <BuiltinDetail contents={s.contents} />}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="stations" aria-label="我的插件">
        <div className="stations-head">
          <strong>我的插件</strong>
          <span>
            装上别人写的制作步骤，例如自动发布、新的做法或风格。装一次，这台电脑上的所有项目都能用。插件不是片场自带的，由它的作者维护；装之前请确认来源可信，装完看一眼它要了哪些权限。
          </span>
        </div>
        {error && <div className="settings-error">{error}</div>}
        {task.busy && (
          <div className="stations-busy" role="status">
            {task.busy}…
          </div>
        )}
        {!task.busy && task.message && (
          <div className="stations-result" role="status">
            {task.message}
          </div>
        )}
        {data?.problems.map((p) => (
          <div className="stations-problem" key={p.id + p.message} data-problem={p.id}>
            <span>{p.message}</span>
            {p.id !== '' && (
              <span className="stations-problem-actions">
                {!p.linked && (
                  <button
                    className="link"
                    disabled={task.busy !== ''}
                    onClick={() =>
                      task.start(`/api/stations/${encodeURIComponent(p.id)}/update`, '取回新版本', {}, show)
                    }
                  >
                    更新
                  </button>
                )}
                <button
                  className="link danger"
                  disabled={task.busy !== ''}
                  onClick={() => task.start(`/api/stations/${encodeURIComponent(p.id)}/remove`, '去掉插件')}
                >
                  去掉
                </button>
              </span>
            )}
          </div>
        ))}
        {data && thirdParty.length > 0 && (
          <ul className="stations-list">
            {thirdParty.map((s) => {
              const needsSetup = s.settings.some((st) => st.type === 'secret' && !st.set);
              return (
                <li key={s.id} className="station-card" data-station={s.id}>
                  <div className="station-row">
                    <span className="station-icon">
                      <PluginGlyph />
                    </span>
                    <div className="station-title">
                      <strong>{s.name}</strong>
                      <span>
                        {placement(s)} · {s.version}
                        {needsSetup && <em className="station-needs"> · 还有设置没填</em>}
                      </span>
                      {marketWarnings.has(s.id) && <em className="station-warn">{marketWarnings.get(s.id)}</em>}
                    </div>
                    <span className="station-badge">第三方</span>
                    <button className="link" aria-haspopup="dialog" onClick={() => setOpen(s.id)}>
                      详情与设置
                    </button>
                    {marketUpdates.has(s.id) ? (
                      <button
                        className="link station-market-update"
                        disabled={task.busy !== '' || pending !== null}
                        onClick={() => fromMarket('update', marketUpdates.get(s.id)!)}
                      >
                        更新到 {marketUpdates.get(s.id)!.latest?.version}
                      </button>
                    ) : (
                      !s.linked && (
                        <button
                          className="link"
                          disabled={task.busy !== ''}
                          onClick={() =>
                            task.start(`/api/stations/${encodeURIComponent(s.id)}/update`, '取回新版本', {}, show)
                          }
                        >
                          更新
                        </button>
                      )
                    )}
                    <button
                      className="link danger"
                      disabled={task.busy !== ''}
                      onClick={() => task.start(`/api/stations/${encodeURIComponent(s.id)}/remove`, '去掉插件')}
                    >
                      去掉
                    </button>
                  </div>
                  {open === s.id && (
                    <PluginDialog station={s} onClose={() => setOpen('')}>
                      <PluginDetailBody station={s} run={run} onOpenPage={onOpenPage} onReload={reload} />
                    </PluginDialog>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="stations-add">
          {window.onset?.selectDirectory && (
            <NativeDirectoryPicker
              id="station-local-directory"
              value={source.replace(/^link:/, '')}
              label="选择本地文件夹"
              disabled={pending !== null || task.busy !== ''}
              onChange={(directory) => setSource(`link:${directory}`)}
            />
          )}
          <input
            aria-label="插件来源"
            placeholder="github:作者/仓库#版本，或本机目录的绝对路径"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') fetchPlugin();
            }}
          />
          <button
            className="primary"
            disabled={source.trim() === '' || pending !== null || task.busy !== ''}
            onClick={fetchPlugin}
          >
            添加
          </button>
        </div>
        <p className="stations-source-help">
          支持 Git 地址或本地文件夹。本地文件夹需包含 onset-station.json，无需 Git；选好后点「添加」查看插件详情。
        </p>
        {pending && <StagedConfirm staged={pending} onInstall={install} onCancel={cancel} />}
      </section>
      <PluginMarket
        market={market}
        busy={task.busy !== '' || pending !== null}
        onInstall={(it) => fromMarket('install', it)}
        onUpdate={(it) => fromMarket('update', it)}
      />
    </>
  );
}
