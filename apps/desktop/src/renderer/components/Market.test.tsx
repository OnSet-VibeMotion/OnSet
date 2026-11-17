// @vitest-environment jsdom
/*
 * 插件中心（Market.tsx）与它接进设置页「我的插件」的两步流程（Stations.tsx 的 PluginSettings）：
 * 搜索、安装与更新都只取回给你看（/api/market/install、/update 起 station_add / station_update 任务），
 * 点「装上」才走 /api/stations/staged/{编号}/install；取不到目录时说清原因、照旧显示上次的目录。
 */
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, reply, type MockRequest } from '../testing';
import { ago, matchesQuery, useMarket } from './Market';
import { PluginSettings } from './Stations';
import { MachineSettings } from './Settings';
import type { MachineSetting, MarketItem, MarketResponse, StationInfo, StationPreview, Task } from '../types';

const c1 = 'a'.repeat(40);
const c2 = 'b'.repeat(40);

function item(over: Partial<MarketItem> = {}): MarketItem {
  return {
    id: 'xiaohongshu-upload',
    name: '小红书上传助手',
    description: '在片场里上传成片与封面，最后由你发布',
    author: { name: '片场', url: '' },
    license: 'MIT',
    tags: ['发布', '小红书'],
    homepage: 'https://github.com/OnSet-VibeMotion/onset-plugin-xiaohongshu',
    source: 'github:OnSet-VibeMotion/onset-plugin-xiaohongshu',
    icon: '',
    screenshots: [],
    state: 'available',
    latest: { version: '0.3.6', ref: 'v0.3.6', commit: c1, requires_onset: '0.1.0', digest: '', yanked: '' },
    requires_onset: '',
    installed_version: '',
    installed_commit: '',
    installed_yanked: '',
    deprecated: '',
    maintainers: [],
    ...over,
  };
}

function marketOf(items: MarketItem[], over: Partial<MarketResponse> = {}): MarketResponse {
  return {
    catalog_url: 'https://raw.githubusercontent.com/OnSet-VibeMotion/onset-plugins/main/index.json',
    custom_url: false,
    fetched_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    refreshing: false,
    error: '',
    installed_error: '',
    onset_version: '2.1.0',
    items,
    ...over,
  };
}

function task(id: string, status: Task['status'], over: Partial<Task> = {}): Task {
  return { task_id: id, type: 'station', status, progress: 1, message: '', created_at: '', updated_at: '', ...over };
}

function preview(over: Partial<StationPreview> = {}): StationPreview {
  return {
    id: 'xiaohongshu-upload',
    name: '小红书上传助手',
    version: '0.3.6',
    description: '',
    source: `github:OnSet-VibeMotion/onset-plugin-xiaohongshu#${c1}`,
    commit: c1,
    linked: false,
    ops: [],
    ops_trust: '',
    page_permissions: [],
    permissions: { project: false, network: [], uses: [] },
    reads: [],
    pages: [],
    experimental: [],
    hooks: [],
    schedules: [],
    renderer_skills: [],
    rerender_all: false,
    flow: '',
    film_styles: '',
    skins: [],
    provides: { tts: '', align: '' },
    replaces: '',
    after: 'publish',
    nodes: ['上传到小红书'],
    inserts: [],
    ...over,
  };
}

function installed(version: string, commit: string): StationInfo {
  return {
    id: 'xiaohongshu-upload',
    name: '小红书上传助手',
    version,
    description: '',
    builtin: false,
    contents: null,
    source: `github:OnSet-VibeMotion/onset-plugin-xiaohongshu#${commit}`,
    commit,
    linked: false,
    experimental: [],
    replaces: '',
    after: 'publish',
    prompt: '',
    nodes: [],
    pages: [],
    skins: [],
    ops: [],
    settings: [],
    permissions: { project: false, network: [], uses: [] },
    hooks: [],
    schedules: [],
    inserts: [],
    provides: { tts: '', align: '' },
    renderer_skills: [],
    film_styles: '',
    flow: null,
    slots: [],
    commands: [],
  } as StationInfo;
}

const marketSection = () => screen.getByRole('region', { name: '插件中心' });

describe('插件中心', () => {
  it('从插件中心装：只取回目录里的那一版给你看，点「装上」才装', async () => {
    const user = userEvent.setup();
    let has = false;
    const backend = mockApi({
      '/api/stations': () => ({ stations: has ? [installed('0.3.6', c1)] : [], problems: [] }),
      '/api/market': () =>
        marketOf([
          item(has ? { state: 'installed', installed_version: '0.3.6', installed_commit: c1 } : {}),
          item({ id: 'bilibili', name: 'B 站投稿', tags: ['发布'], description: '投稿到 B 站' }),
        ]),
      'POST /api/market/install': (req: MockRequest) => ({ task_id: (req.body as { id: string }).id === 'xiaohongshu-upload' ? 'fetch' : 'other' }),
      '/api/tasks/fetch': task('fetch', 'succeeded', { result: { staged: 'st-1', preview: preview() } }),
      'POST /api/stations/staged/st-1/install': () => {
        has = true;
        return { task_id: 'install' };
      },
      '/api/tasks/install': task('install', 'succeeded'),
    });
    render(<PluginSettings version={0} />);
    const market = await waitFor(() => {
      const el = marketSection();
      expect(el.textContent).toContain('小红书上传助手');
      return el;
    });
    expect(market.textContent).toContain('更新于 3 小时前');

    // 搜索：名字、标签、作者都认。
    await user.type(within(market).getByLabelText('搜索插件'), '小红书');
    expect(market.querySelectorAll('li[data-market]')).toHaveLength(1);
    await user.clear(within(market).getByLabelText('搜索插件'));
    await user.type(within(market).getByLabelText('搜索插件'), '没有这个');
    expect(market.textContent).toContain('没有找到匹配的插件');
    await user.clear(within(market).getByLabelText('搜索插件'));

    const card = market.querySelector<HTMLElement>('li[data-market="xiaohongshu-upload"]')!;
    await user.click(within(card).getByRole('button', { name: '安装' }));
    // 只交 id 与 commit，来源由后端从目录算。
    expect(backend.calls.find((c) => c.path === '/api/market/install')?.body).toEqual({ id: 'xiaohongshu-upload', commit: c1 });
    const confirm = await screen.findByRole('alertdialog', { name: '确认添加插件' }, { timeout: 3000 });
    expect(confirm.textContent).toContain(c1.slice(0, 12));
    expect(backend.count('POST /api/stations/staged/st-1/install')).toBe(0);
    // 看的时候别的插件不能再点安装。
    expect(within(market.querySelector<HTMLElement>('li[data-market="bilibili"]')!).getByRole('button', { name: '安装' })).toHaveProperty('disabled', true);

    await user.click(within(confirm).getByRole('button', { name: '装上' }));
    await waitFor(() => expect(marketSection().querySelector('li[data-market="xiaohongshu-upload"]')?.textContent).toContain('已装 0.3.6'), { timeout: 3000 });
    expect(backend.unmatched).toEqual([]);
  });

  it('有新版本时在插件中心与「我的插件」里都能更新，同样先看差异', async () => {
    const user = userEvent.setup();
    const backend = mockApi({
      '/api/stations': () => ({ stations: [installed('0.3.6', c1)], problems: [] }),
      '/api/market': () => marketOf([item({ state: 'update', installed_version: '0.3.6', installed_commit: c1, latest: { version: '0.4.0', ref: 'v0.4.0', commit: c2, requires_onset: '', digest: '', yanked: '' } })]),
      'POST /api/market/update': { task_id: 'up' },
      '/api/tasks/up': task('up', 'succeeded', {
        result: {
          staged: 'st-2',
          preview: preview({
            version: '0.4.0',
            commit: c2,
            update: { id: 'xiaohongshu-upload', old_version: '0.3.6', new_version: '0.4.0', new_permissions: ['连网：https://edith.xiaohongshu.com'], new_experimental: [], experimental: [], changed: true, commit_before: c1, commit_after: c2 },
          }),
        },
      }),
      'POST /api/stations/staged/st-2/discard': {},
    });
    render(<PluginSettings version={0} />);
    const mine = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('li[data-station="xiaohongshu-upload"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const market = await waitFor(() => {
      const el = marketSection();
      expect(el.textContent).toContain('有新版本 0.4.0');
      return el;
    });
    // 插件中心有新版本时，「我的插件」的按钮换成插件中心的那一版，不按旧来源重取。
    const update = await within(mine).findByRole('button', { name: '更新到 0.4.0' });
    await user.click(update);
    expect(backend.calls.find((c) => c.path === '/api/market/update')?.body).toEqual({ id: 'xiaohongshu-upload', commit: c2 });
    expect(backend.count('POST /api/stations/xiaohongshu-upload/update')).toBe(0);
    const confirm = await screen.findByRole('alertdialog', undefined, { timeout: 3000 });
    expect(confirm.textContent).toContain('0.4.0');
    expect(confirm.textContent).toContain('edith.xiaohongshu.com');
    await user.click(within(confirm).getByRole('button', { name: /取消|不换|先不/ }));
    expect(backend.count('POST /api/stations/staged/st-2/discard')).toBe(1);
    expect(within(market).getByRole('button', { name: '更新' })).toHaveProperty('disabled', false);
  });

  it('取不到目录：说清原因、给出去哪改，照旧显示上次的目录；刷新时等它刷完', async () => {
    const user = userEvent.setup();
    let refreshing = false;
    const backend = mockApi({
      '/api/stations': { stations: [], problems: [] },
      '/api/market': () => marketOf([item({ state: 'incompatible', latest: null, requires_onset: '9.0.0' })], { refreshing, error: refreshing ? '' : '连不上 raw.githubusercontent.com（10 秒没有回应）' }),
      'POST /api/market/refresh': () => {
        refreshing = true;
        window.setTimeout(() => (refreshing = false), 300);
        return { refreshing: true };
      },
    });
    render(<PluginSettings version={0} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('刷新插件中心没有成功，下面是上次取到的目录');
    expect(alert.textContent).toContain('连不上 raw.githubusercontent.com');
    expect(alert.textContent).toContain('网络与更新');
    const card = marketSection().querySelector<HTMLElement>('li[data-market="xiaohongshu-upload"]')!;
    expect(card.textContent).toContain('要片场 9.0.0 或更新的版本');
    expect(within(card).queryByRole('button', { name: '安装' })).toBeNull();

    await user.click(within(marketSection()).getByRole('button', { name: '刷新' }));
    expect(marketSection().textContent).toContain('正在刷新');
    await waitFor(() => expect(backend.count('GET /api/market')).toBeGreaterThan(2), { timeout: 3000 });
    await waitFor(() => expect(within(marketSection()).getByRole('button', { name: '刷新' })).toHaveProperty('disabled', false), { timeout: 3000 });
  });

  it('从没取到目录时只说正在取，不显示空列表', async () => {
    mockApi({
      '/api/stations': { stations: [], problems: [] },
      '/api/market': marketOf([], { fetched_at: '', refreshing: true }),
    });
    render(<PluginSettings version={0} />);
    await waitFor(() => expect(marketSection().textContent).toContain('正在取插件中心的目录'));
  });
});

describe('撤回与不再维护', () => {
  it('装着的版本被撤回、插件不再维护时，两处都照实说；不再维护的不给装', async () => {
    mockApi({
      '/api/stations': () => ({ stations: [installed('0.3.6', c1)], problems: [] }),
      '/api/market': () =>
        marketOf([
          item({ state: 'update', installed_version: '0.3.6', installed_commit: c1, installed_yanked: '会删掉项目里的封面', latest: { version: '0.3.5', ref: 'v0.3.5', commit: c2, requires_onset: '', digest: '', yanked: '' } }),
          item({ id: 'old-one', name: '旧插件', state: 'unavailable', latest: null, deprecated: '作者改做新插件了' }),
        ]),
    });
    render(<PluginSettings version={0} />);
    const mine = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('li[data-station="xiaohongshu-upload"]');
      expect(el?.textContent).toContain('这一版已被作者撤回：会删掉项目里的封面');
      return el!;
    });
    // 撤回时给换回能用的一版，哪怕版本号更低。
    expect(within(mine).getByRole('button', { name: '更新到 0.3.5' })).toBeTruthy();
    const old = marketSection().querySelector<HTMLElement>('li[data-market="old-one"]')!;
    expect(old.textContent).toContain('作者已不再维护：作者改做新插件了');
    expect(within(old).queryByRole('button', { name: '安装' })).toBeNull();
  });
});

describe('小工具', () => {
  it('搜索每个词都要出现，不分大小写', () => {
    expect(matchesQuery(item(), '小红书 发布')).toBe(true);
    expect(matchesQuery(item(), 'XIAOHONGSHU')).toBe(true);
    expect(matchesQuery(item(), '抖音')).toBe(false);
  });

  it('多久以前', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(ago('2026-11-17T11:59:50Z', now)).toBe('刚刚');
    expect(ago('2026-11-17T11:30:00Z', now)).toBe('30 分钟前');
    expect(ago('2026-11-15T12:00:00Z', now)).toBe('2 天前');
  });
});

describe('网络与更新', () => {
  const rows = (over: Partial<MachineSetting> = {}): MachineSetting[] => [
    { key: 'NETWORK_PROXY', label: '代理', hint: '', placeholder: 'http://127.0.0.1:7890', value: '', overridden: false, ...over },
    { key: 'PLUGIN_CATALOG_URL', label: '插件中心地址', hint: '', placeholder: '', value: '', overridden: false },
  ];

  it('回车保存，写错了照实说，被环境变量盖住时提示', async () => {
    const user = userEvent.setup();
    const backend = mockApi({
      'POST /api/settings/global': (req: MockRequest) =>
        (req.body as { value: string }).value.startsWith('ftp') ? reply(400, { message: '代理写成 http://主机:端口、https://… 或 socks5://…' }) : req.body,
    });
    let saved = 0;
    const { rerender } = render(<MachineSettings rows={rows()} onSaved={() => saved++} />);
    const proxy = screen.getByLabelText('代理');
    await user.type(proxy, 'ftp://x{Enter}');
    await waitFor(() => expect(document.body.textContent).toContain('代理写成 http://主机:端口'));
    expect(saved).toBe(0);
    await user.clear(proxy);
    await user.type(proxy, 'http://127.0.0.1:7890{Enter}');
    await waitFor(() => expect(saved).toBe(1));
    expect(backend.calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ key: 'NETWORK_PROXY', value: 'http://127.0.0.1:7890' });
    expect(document.body.textContent).toContain('已保存');
    rerender(<MachineSettings rows={rows({ overridden: true })} onSaved={() => {}} />);
    expect(document.body.textContent).toContain('被电脑上的环境变量 NETWORK_PROXY 定死了');
  });
});


it('lets the user refresh again after polling or refresh requests fail', async () => {
  let fail = false;
  mockApi({
    '/api/market': () => { if (fail) throw new Error('offline'); return marketOf([], { refreshing: true }); },
    'POST /api/market/refresh': () => { throw new Error('offline'); },
  });
  const { result } = renderHook(() => useMarket(0));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  fail = true;
  act(() => result.current.reload());
  await waitFor(() => expect(result.current.error).toContain('offline'));
  expect(result.current.data?.refreshing).toBe(false);
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.data?.refreshing).toBe(false));
});
