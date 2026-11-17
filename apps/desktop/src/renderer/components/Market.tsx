import { useEffect, useMemo, useState } from 'react';
import { api, errorText, post } from '../api';
import type { MarketItem, MarketResponse } from '../types';
import { Icon } from './Icon';

/**
 * 插件中心（/api/market）：浏览、搜索官方插件中心（或设置里填的目录）里的插件。
 * 装与更新不在这里另走一条路：点了交给设置页「我的插件」同一个两步流程——取到暂存、看实情、点「装上」才装（Stations.tsx）。
 * 目录从缓存立刻出来，后台刷新；刷新时每秒看一次，取不到时照实说原因，不挡住页面。
 */

/** 读插件中心；正在刷新时每秒再读一次，刷新完就停。 */
export function useMarket(version: number): { data: MarketResponse | null; error: string; reload: () => void; refresh: () => void } {
  const [data, setData] = useState<MarketResponse | null>(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    api<MarketResponse>('/api/market').then(
      (value) => {
        if (!alive) return;
        setData(value);
        setError('');
      },
      (err) => alive && setError(errorText(err)),
    );
    return () => {
      alive = false;
    };
  }, [version, nonce]);
  useEffect(() => {
    if (!data?.refreshing) return;
    const t = window.setTimeout(() => setNonce((n) => n + 1), 1000);
    return () => window.clearTimeout(t);
  }, [data]);
  const reload = () => setNonce((n) => n + 1);
  const refresh = () => {
    setData((d) => (d ? { ...d, refreshing: true, error: '' } : d));
    void post('/api/market/refresh', {}).then(reload, (err) => setError(errorText(err)));
  };
  return { data, error, reload, refresh };
}

/** 「3 小时前」这类说法。 */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 搜索：名字、说明、作者、标签、id，空格分开的每个词都要出现。 */
export function matchesQuery(item: MarketItem, query: string): boolean {
  const hay = [item.id, item.name, item.description, item.author.name, ...item.tags].join('\n').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

const stateNotes: Partial<Record<MarketItem['state'], string>> = {
  installed: '已装',
  other_source: '装着同名插件，但不是从这里装的',
  builtin: '和片场自带的功能同名，不能装',
};

function MarketCard({ item, busy, onInstall, onUpdate }: { item: MarketItem; busy: boolean; onInstall: () => void; onUpdate: () => void }) {
  const [iconFailed, setIconFailed] = useState(false);
  return (
    <li className="market-card" data-market={item.id} data-state={item.state}>
      <span className="market-icon">{item.icon && !iconFailed ? <img src={item.icon} alt="" onError={() => setIconFailed(true)} /> : <Icon name="plug" size={18} />}</span>
      <div className="market-body">
        <div className="market-title">
          <strong>{item.name}</strong>
          {item.latest && <span className="market-version">{item.latest.version}</span>}
          {item.author.name && <span className="market-author">{item.author.name}</span>}
        </div>
        <p>{item.description}</p>
        {item.tags.length > 0 && (
          <div className="market-tags">
            {item.tags.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        )}
        {item.state === 'incompatible' && <em className="market-note">要片场 {item.requires_onset} 或更新的版本，请先更新片场</em>}
        {item.state === 'update' && (
          <em className="market-note">
            已装 {item.installed_version}，有新版本 {item.latest?.version}
          </em>
        )}
        {stateNotes[item.state] && item.state !== 'installed' && <em className="market-note">{stateNotes[item.state]}</em>}
      </div>
      <div className="market-actions">
        {item.state === 'available' && (
          <button className="primary" disabled={busy} onClick={onInstall}>
            安装
          </button>
        )}
        {item.state === 'update' && (
          <button className="primary" disabled={busy} onClick={onUpdate}>
            更新
          </button>
        )}
        {item.state === 'installed' && <span className="market-installed">已装 {item.installed_version}</span>}
        {item.homepage && (
          <a className="link" href={item.homepage} target="_blank" rel="noreferrer">
            主页
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * busy：有插件任务在跑（取回、装上）或有待确认的插件时，按钮都不能点。onInstall / onUpdate 由设置页接到两步流程上。
 */
export function PluginMarket({
  market,
  busy,
  onInstall,
  onUpdate,
}: {
  market: ReturnType<typeof useMarket>;
  busy: boolean;
  onInstall: (item: MarketItem) => void;
  onUpdate: (item: MarketItem) => void;
}) {
  const { data, error, refresh } = market;
  const [query, setQuery] = useState('');
  const items = useMemo(() => (data?.items ?? []).filter((it) => matchesQuery(it, query)), [data, query]);
  return (
    <section className="stations market" aria-label="插件中心">
      <div className="stations-head">
        <strong>插件中心</strong>
        <span>
          别人写好、登记在插件中心的插件，每一版都钉在作者仓库的某个提交上。点「安装」会先取回给你看它要了什么，你点「装上」才装。
        </span>
      </div>
      <div className="market-bar">
        <label className="market-search">
          <Icon name="search" size={13} />
          <input aria-label="搜索插件" placeholder="搜索名字、作者或标签" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <span className="market-status" role="status">
          {data?.refreshing ? '正在刷新…' : data?.fetched_at ? `更新于 ${ago(data.fetched_at)}` : ''}
        </span>
        <button className="link" disabled={data?.refreshing === true} onClick={refresh}>
          刷新
        </button>
      </div>
      {(error || data?.error) && (
        <div className="market-error" role="alert">
          {data?.fetched_at ? '刷新插件中心没有成功，下面是上次取到的目录。' : '取不到插件中心的目录。'}
          <span>{error || data?.error}</span>
          <span>可以在「网络与更新」里填代理或换一个目录地址，再点「刷新」。</span>
        </div>
      )}
      {data && !data.fetched_at && !data.error && <div className="market-empty">{data.refreshing ? '正在取插件中心的目录…' : '还没有取过插件中心的目录。'}</div>}
      {data && data.fetched_at && items.length === 0 && <div className="market-empty">{query ? '没有找到匹配的插件。' : '插件中心里还没有插件。'}</div>}
      {items.length > 0 && (
        <ul className="market-list">
          {items.map((it) => (
            <MarketCard key={it.id} item={it} busy={busy} onInstall={() => onInstall(it)} onUpdate={() => onUpdate(it)} />
          ))}
        </ul>
      )}
    </section>
  );
}
