import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../Icon';
import type { RunAction } from '../Preview';
import { PluginGlyph } from './meta';
import { getLoadedStations, getStationPage } from './registry';
import { StationFrame } from './StationFrame';

interface PageProps {
  tab: string;
  version: number;
  run: RunAction;
  onQuick: (text: string, attachments: [], draftOnly?: boolean) => void;
  onOpen?: (tab: string) => void;
  projectName: string;
}

/** 插件自己的整页（画面面板里的一页）。 */
export function StationPage({ tab, ...rest }: PageProps) {
  const entry = getStationPage(tab);
  if (!entry) return <div className="empty">这个插件页面已经不在了（插件可能被去掉了）。</div>;
  const { station, page } = entry;
  return (
    <div className="station-page" data-station={station.id}>
      <div className="station-page-bar">
        <span className="station-icon">
          <PluginGlyph />
        </span>
        <strong>{page.label}</strong>
        <span className="station-badge">第三方插件 · {station.name}</span>
        <span className="spacer" />
        <span className="small muted">页面在沙箱里运行，读文件、执行操作都要经过这里</span>
      </div>
      <StationFrame station={station} page={page} context={{ slot: '' }} {...rest} />
    </div>
  );
}

/**
 * 嵌进自带页面的插件小窗（清单 slots）：at 是哪一页，context 是那一页正对着的东西（镜头编号等）。
 * 没有插件嵌在这里时什么都不画。
 */
export function StationSlots({
  at,
  context = {},
  ...rest
}: Omit<PageProps, 'tab'> & { at: string; context?: Record<string, unknown> }) {
  const slots = getLoadedStations().flatMap((station) =>
    station.slots
      .filter((sl) => sl.at === at)
      .map((sl) => ({ station, slot: sl, page: station.pages.find((p) => p.id === sl.page)! })),
  );
  if (slots.length === 0) return null;
  return (
    <div className="station-slots" data-slot={at}>
      {slots.map(({ station, slot, page }) => (
        <section key={station.id + slot.page} className="station-slot station-page" data-station={station.id}>
          <div className="station-page-bar">
            <span className="station-icon">
              <PluginGlyph />
            </span>
            <strong>{page.label}</strong>
            <span className="station-badge">第三方插件 · {station.name}</span>
            <span className="spacer" />
            {rest.onOpen && (
              <button className="link" onClick={() => rest.onOpen!(page.tab)}>
                单独打开
              </button>
            )}
          </div>
          <StationFrame
            station={station}
            page={page}
            context={{ slot: at, ...context }}
            height={slot.height}
            {...rest}
          />
        </section>
      ))}
    </div>
  );
}

/** 顶栏「页面」菜单里自带页面的图标。 */
const builtinPageIcons: Record<string, IconName> = {
  compose: 'layers',
  style: 'brush',
  motion: 'play',
  voice: 'mic',
  review: 'check',
  memory: 'brain',
  file: 'folder',
};

/**
 * 顶栏的「页面」菜单：五个制作步骤之外的页面（合成、风格、音色、复查、记忆，内置插件登记的页面）与第三方插件的页面
 * 不一个个摆在顶栏上（几个页面一摆，顶栏就乱、插件一多还会溢出），收进一个菜单，插件页面另起一组。
 * 当前开着的是菜单里的页面时，按钮显示那一页的名字。
 */
export function PageMenu({
  pages,
  tabs,
  current,
  onPick,
}: {
  pages: [string, string][];
  tabs: [string, string][];
  current: string;
  onPick: (tab: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (pages.length === 0 && tabs.length === 0) return null;
  const active = [...pages, ...tabs].find(([id]) => id === current);
  const item = (id: string, label: string, icon: ReactNode, owner?: string) => (
    <button
      key={id}
      role="menuitem"
      data-tab={id}
      className={id === current ? 'on' : ''}
      aria-current={id === current ? 'page' : undefined}
      onClick={() => {
        setOpen(false);
        onPick(id);
      }}
    >
      {icon}
      {label}
      {owner && <span className="page-menu-owner">{owner}</span>}
    </button>
  );
  return (
    <div className="page-menu" ref={root}>
      <button
        className={'page-menu-trigger' + (active ? ' on' : '')}
        id="page-menu-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        title="其他页面"
        onClick={() => setOpen(!open)}
      >
        <Icon name="pages" size={13} />
        <span>{active ? active[1] : '页面'}</span>
        <Icon name="chevron" size={10} />
      </button>
      {open && (
        <div className="page-menu-list" role="menu">
          {pages.map(([id, label]) =>
            item(
              id,
              label,
              <span className="page-icon">
                <Icon name={builtinPageIcons[id] ?? 'file'} size={13} />
              </span>,
            ),
          )}
          {tabs.length > 0 && pages.length > 0 && <div className="page-menu-sep" role="separator" />}
          {tabs.map(([id, label]) =>
            item(
              id,
              label,
              <span className="station-icon">
                <PluginGlyph />
              </span>,
              getStationPage(id)?.station.name ?? '',
            ),
          )}
        </div>
      )}
    </div>
  );
}
