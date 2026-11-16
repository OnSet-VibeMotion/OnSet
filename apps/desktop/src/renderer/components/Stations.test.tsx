// @vitest-environment jsdom
/*
 * 插件（Stations.tsx）：设置页「我的插件」的添加、详情与设置、要你点的操作，插件页面与嵌入小窗的宿主一侧的桥，
 * 以及第三方站声明的状态在对话顶上的「现在在哪」「接下来」。
 *
 * 后端换成 testing.tsx 的路由表，插件取 packages/engine/src/flow/testdata/fake-publisher 那份假发布、
 * 按 studio/stations.ts 的 stationJSON 写成界面拿到的样子。页面在沙箱 iframe 里，这里不加载它：
 * 宿主一侧的桥只认来自那个 iframe 的消息，测试就以 iframe 的 contentWindow 为来源发请求、在它上面收回答。
 * 真页面里的 SDK、CSP、页面经 /station-ui 加载、钩子与插件操作真的跑起来，留在 e2e/stations.spec.mjs。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, reply, type MockRequest } from '../testing';
import { PluginSettings, StationPage, StationSlots, setStationPages } from './Stations';
import { slashCommands } from './chat/complete';
import { Chat } from './Chat';
import type { ProgressState, StationInfo, StationOp, StationPreview, StationRun, StationsResponse, Task } from '../types';

const folder = '/Users/me/插件/本地插件 #1';

function op(over: Partial<StationOp> & Pick<StationOp, 'name' | 'summary'>): StationOp {
  return { tool: '', description: '', trigger: 'user', project: true, list: false, form: true, params: [], ...over };
}

/** 假发布装上之后 /api/stations 里的样子（studio/stations.ts 的 stationJSON）。 */
function fakePublisher(over: Partial<StationInfo> = {}): StationInfo {
  const page = (id: string, label: string, entry: string) => ({ id, label, tab: `x:fake-publisher:${id}`, url: `/station-ui/fake-publisher/${entry}`, reads: ['publish.md'] });
  return {
    id: 'fake-publisher',
    name: '假发布',
    version: '0.1.0',
    description: '',
    builtin: false,
    contents: null,
    source: `link:${folder}`,
    commit: '',
    linked: true,
    experimental: ['hooks', 'schedules', 'slots', 'commands'],
    replaces: '',
    after: 'publish',
    prompt: '发布前请用户在发布页点「把成片发到平台」。\n',
    nodes: [{ id: 'auto-publish', label: '自动发布', step: 'publish', gate: false }],
    pages: [page('dashboard', '发布看板', 'ui/index.html'), page('mini', '发布小窗', 'ui/slot.html')],
    skins: [],
    ops: [
      op({ name: 'send', summary: '把成片发到平台（测试用：只写回执，不联网）', params: [{ key: 'platform', type: 'string', description: '平台，例如 douyin', required: true }] }),
      op({ name: 'status', tool: 'x_fake_publisher_status', summary: '查看发布回执', trigger: 'agent' }),
      op({ name: 'on_event', tool: 'x_fake_publisher_on_event', summary: '记下发生了什么事件（测试用）', trigger: 'agent' }),
      op({ name: 'speak', tool: 'x_fake_publisher_speak', summary: '把一段文字读成配音（测试用，不出声）', trigger: 'agent' }),
      op({ name: 'scribble', summary: '顺手记一笔（测试用：会写一个没声明的文件）' }),
      op({ name: 'login', summary: '登录平台账号（测试用：只写插件的数据目录）', project: false, params: [{ key: 'name', type: 'string', description: '账号备注名', required: false }] }),
      op({ name: 'accounts', summary: '已登录的账号', project: false, list: true }),
      op({ name: 'logout', summary: '退出账号', project: false, form: false }),
    ],
    settings: [
      { key: 'platform', label: '默认平台', type: 'select', description: '再发一次时发到哪', options: ['douyin', 'bilibili'], default: 'douyin', value: 'douyin' },
      { key: 'token', label: '平台令牌', type: 'secret', description: '测试用，只检查有没有填', options: [], set: false },
    ],
    permissions: { project: true, network: [], uses: ['review'] },
    hooks: [
      { on: 'gate.confirmed', op: 'on_event' },
      { on: 'film.approved', op: 'on_event' },
    ],
    schedules: [{ every_minutes: 30, op: 'on_event' }],
    inserts: ['render'],
    provides: { tts: '假配音', align: '' },
    renderer_skills: [{ name: 'caption-kit', summary: '字幕卡片的写法', scenes: 'opt-in' }],
    film_styles: '假风格库',
    flow: { name: '快剪', stations: ['intake', 'render', 'assemble', 'review', 'fake-publisher'], first_tab: 'x:fake-publisher:dashboard' },
    slots: [{ at: 'publish', page: 'mini', height: 140, tab: 'x:fake-publisher:mini', url: '/station-ui/fake-publisher/ui/slot.html' }],
    commands: [{ name: 'fabu', description: '打开发布看板', page: 'dashboard', prompt: '', tab: 'x:fake-publisher:dashboard' }],
    ...over,
  };
}

/** 取回给你看的实情（flow.StationPreview）：本机目录。 */
function preview(): StationPreview {
  const s = fakePublisher();
  return {
    id: s.id,
    name: s.name,
    version: s.version,
    description: '',
    source: `link:${folder}`,
    commit: '',
    linked: true,
    ops: s.ops.map((o) => ({ name: o.name, summary: o.summary, trigger: o.trigger, tool: o.tool })),
    ops_trust: '它的操作是在你电脑上运行的程序，能读写你的文件、能联网；片场只限制它拿不到项目 .env 与片场的凭据，并在它写了声明范围之外的项目文件时告诉你。',
    page_permissions: [],
    permissions: s.permissions,
    reads: ['publish.md'],
    pages: ['发布看板', '发布小窗'],
    experimental: s.experimental,
    hooks: [{ on: 'gate.confirmed', label: '你确认一个审核关卡后', op: 'on_event', summary: '记下发生了什么事件（测试用）' }],
    schedules: [],
    renderer_skills: s.renderer_skills,
    rerender_all: false,
    flow: '快剪',
    film_styles: '假风格库',
    skins: [],
    provides: s.provides,
    replaces: '',
    after: 'publish',
    nodes: ['自动发布'],
    inserts: ['render'],
  };
}

function task(id: string, status: Task['status'], over: Partial<Task> = {}): Task {
  return { task_id: id, type: 'station', status, progress: status === 'succeeded' ? 1 : 0, message: '', created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:00Z', ...over };
}

function run(over: Partial<StationRun>): StationRun {
  return { task_id: 't', at: new Date().toISOString(), ok: true, text: '', ...over };
}

const stations = (...list: StationInfo[]): StationsResponse => ({ stations: list, problems: [] });

const myPlugins = () => document.querySelector<HTMLElement>('section.stations[aria-label="我的插件"]')!;

/** 等假发布的卡片出现在「我的插件」里。 */
const pluginCard = () =>
  waitFor(
    () => {
      const el = myPlugins().querySelector<HTMLElement>('li[data-station="fake-publisher"]');
      expect(el).not.toBeNull();
      return el!;
    },
    { timeout: 3000 },
  );

afterEach(() => {
  delete window.onset;
  setStationPages([]);
});

describe('添加插件', () => {
  it('选本地文件夹、看过实情再装上；没有 Git 也行，本机目录没有「更新」', async () => {
    const user = userEvent.setup();
    // 系统文件夹选择器：依次取消、选错目录、选对目录。
    const picks: (string | null)[] = [null, '/Users/me/插件', folder];
    window.onset = { desktop: true, platform: 'darwin', selectDirectory: async () => picks.shift() ?? null };
    let installed = false;
    const backend = mockApi({
      '/api/stations': () => stations(...(installed ? [fakePublisher()] : [])),
      'POST /api/stations': (req: MockRequest) => ({ task_id: (req.body as { source: string }).source === `link:${folder}` ? 'fetch-ok' : 'fetch-bad' }),
      // 选错目录：沿用清单校验，取回失败。
      '/api/tasks/fetch-bad': task('fetch-bad', 'failed', { error: '/Users/me/插件 里没有 onset-station.json' }),
      '/api/tasks/fetch-ok': task('fetch-ok', 'succeeded', { result: { staged: 'st-1', preview: preview() } }),
      'POST /api/stations/staged/st-1/install': () => {
        installed = true;
        return { task_id: 'install' };
      },
      '/api/tasks/install': task('install', 'succeeded'),
      'POST /api/stations/fake-publisher/remove': () => {
        installed = false;
        return { task_id: 'remove' };
      },
      '/api/tasks/remove': task('remove', 'succeeded'),
    });
    render(<PluginSettings version={0} />);
    const box = within(myPlugins());
    const source = box.getByLabelText('插件来源') as HTMLInputElement;
    await user.type(source, 'github:someone/plugin');

    // 取消选择：来源不变，什么都没取。
    await user.click(box.getByRole('button', { name: '选择本地文件夹' }));
    await waitFor(() => expect(box.getByRole('button', { name: '选择本地文件夹' })).toHaveProperty('disabled', false));
    expect(source.value).toBe('github:someone/plugin');

    // 选错目录：清单校验失败，不装，也不影响下一次选择。
    await user.click(box.getByRole('button', { name: '选择本地文件夹' }));
    await waitFor(() => expect(source.value).toBe('link:/Users/me/插件'));
    await user.click(box.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(myPlugins().textContent).toContain('里没有 onset-station.json'), { timeout: 3000 });
    expect(backend.count('POST /api/stations/staged/st-1/install')).toBe(0);

    await user.click(box.getByRole('button', { name: '选择本地文件夹' }));
    await waitFor(() => expect(source.value).toBe(`link:${folder}`));
    await user.click(box.getByRole('button', { name: '添加' }));
    const confirm = await screen.findByRole('alertdialog', { name: '确认添加插件' }, { timeout: 3000 });
    expect(confirm.textContent).toContain(folder);
    expect(confirm.textContent).toContain('改动立即生效');
    expect(confirm.textContent).toContain('本机目录');
    // 实情：要你点的、页面能做的、接进来的地方、实验性能力。
    expect(confirm.textContent).toContain('把成片发到平台');
    expect(confirm.textContent).toContain('能读写你的文件、能联网');
    expect(confirm.querySelector('.staged-page-perms')?.textContent).toContain('镜头、制作进度、发布信息的概况');
    expect(confirm.querySelector('.staged-page-perms')?.textContent).toContain('整片复查');
    expect(confirm.textContent).toContain('你确认一个审核关卡后');
    expect(confirm.textContent).toContain('快剪（新建项目时在「做法」里选）');
    expect(confirm.textContent).toContain('接在「发布」后面');
    expect(confirm.textContent).toContain('用到了实验性能力：hooks');
    expect(confirm.textContent).toContain('对这台电脑上的所有项目生效');
    // 看过之前不装；看的时候「添加」不能再点。
    expect(backend.count('POST /api/stations/staged/st-1/install')).toBe(0);
    expect(box.getByRole('button', { name: '添加' })).toHaveProperty('disabled', true);

    await user.click(within(confirm).getByRole('button', { name: '装上' }));
    expect(screen.queryByRole('alertdialog', { name: '确认添加插件' })).toBeNull();
    const card = await pluginCard();
    expect(card.textContent).toContain('假发布');
    expect(card.textContent).toContain('第三方');
    expect(source.value).toBe('');
    // 本机目录改动立即生效：没有「更新」。
    expect(within(card).queryByRole('button', { name: '更新' })).toBeNull();

    await user.click(within(card).getByRole('button', { name: '去掉' }));
    await waitFor(() => expect(myPlugins().querySelector('li[data-station="fake-publisher"]')).toBeNull(), { timeout: 3000 });
    expect(backend.unmatched).toEqual([]);
  });
});

describe('详情与设置', () => {
  it('权限分页面与接进来的地方列出；密钥只写不读', async () => {
    const user = userEvent.setup();
    let current = fakePublisher();
    const backend = mockApi({
      '/api/stations': () => stations(current),
      'POST /api/stations/fake-publisher/settings': (req: MockRequest) => {
        const { key, value } = req.body as { key: string; value: unknown };
        current = { ...current, settings: current.settings.map((st) => (st.key !== key ? st : st.type === 'secret' ? { ...st, set: value !== '' } : { ...st, value: value as string })) };
        return {};
      },
      'POST /api/stations/fake-publisher/ops/accounts': { task_id: 'acc' },
      '/api/tasks/acc': task('acc', 'succeeded'),
    });
    render(<PluginSettings version={0} />);
    const card = await pluginCard();
    expect(card.textContent).toContain('还有设置没填');
    await user.click(within(card).getByRole('button', { name: '详情与设置' }));
    const detail = screen.getByRole('dialog', { name: '假发布 详情与设置' });
    // 页面的权限与插件接进来的地方分开列：页面在沙箱里，操作不在。
    expect(detail.querySelector('.station-page-perms')?.textContent).toContain('镜头、制作进度、发布信息的概况');
    expect(detail.querySelector('.station-page-perms')?.textContent).toContain('整片复查');
    expect(detail.querySelector('.station-perms:not(.station-page-perms)')?.textContent).toContain('你确认一个审核关卡后');
    expect(detail.querySelector('.station-perms:not(.station-page-perms)')?.textContent).toContain('客户端开着时每 30 分钟');
    expect(detail.querySelector('.station-trust')?.textContent).toContain('它的操作是在你电脑上运行的程序');
    expect(detail.querySelector('.station-experimental')?.textContent).toContain('用到了实验性能力：hooks');
    expect(detail.querySelector('.station-prompt')?.textContent).toContain('请用户在发布页点');
    // 没打开项目：页面打不开，针对项目的操作要先打开项目。
    expect(detail.textContent).toContain('打开一个项目后，可以在这里打开它的页面');
    expect(detail.textContent).toContain('「把成片发到平台」「顺手记一笔」针对项目执行，打开一个项目后在这里点');

    const token = detail.querySelector<HTMLElement>('[data-setting="token"]')!;
    expect(token.textContent).toContain('未填写');
    const save = within(token).getByRole('button', { name: '保存' });
    expect(save).toHaveProperty('disabled', true);
    await user.type(within(token).getByLabelText('平台令牌'), 'tok-e2e-secret');
    await user.click(save);
    await waitFor(() => expect(token.textContent).toContain('已填写'));
    expect(backend.calls.find((c) => c.path.endsWith('/settings'))?.body).toEqual({ key: 'token', value: 'tok-e2e-secret' });
    // 保存后输入框清空，界面上任何地方都没有密钥。
    expect((within(token).getByLabelText('平台令牌') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain('tok-e2e-secret');

    await user.selectOptions(within(detail).getByLabelText('默认平台'), 'bilibili');
    await waitFor(() => expect(backend.calls.filter((c) => c.path.endsWith('/settings')).map((c) => c.body)).toContainEqual({ key: 'platform', value: 'bilibili' }));
    await waitFor(() => expect(card.textContent).not.toContain('还有设置没填'));

    // 打开弹窗时自动读的账号列表要读完（不然轮询会落到下一个用例的后端上）。
    await waitFor(() => expect(backend.count('/api/tasks/acc')).toBeGreaterThan(0), { timeout: 3000 });
    await waitFor(() => expect(detail.textContent).not.toContain('正在读取…'));

    // Esc 只关这一层弹窗。
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '假发布 详情与设置' })).toBeNull();
    expect(card.textContent).toContain('第三方');
  });

  it('连点两下只跑一次；登录完自动刷新账号列表；打开项目后能打开它的页面', async () => {
    let accounts: { title: string; image?: string; actions?: unknown[] }[] = [];
    let accountsRun: StationRun | undefined;
    let n = 0;
    const backend = mockApi({
      '/api/stations': () => stations(fakePublisher({ ops: fakePublisher().ops.map((o) => (o.name === 'accounts' && accountsRun ? { ...o, last_run: accountsRun } : o)) })),
      'POST /api/stations/fake-publisher/ops/accounts': () => {
        accountsRun = run({ data: { items: accounts } });
        return { task_id: `acc-${++n}` };
      },
      'POST /api/stations/fake-publisher/ops/login': (req: MockRequest) => {
        accounts = [{ title: (req.body as { params: { name?: string } }).params.name || '小号', image: 'data:image/png;base64,AAAA' }];
        return { task_id: 'login' };
      },
      '/api/tasks/login': task('login', 'succeeded', { result: { message: '已登录：小号' } }),
    });
    for (let i = 1; i <= 5; i++) backend.set(`/api/tasks/acc-${i}`, task(`acc-${i}`, 'succeeded'));
    const openPage = vi.fn();
    render(<PluginSettings version={0} onOpenPage={openPage} />);
    await userEvent.click(within(await pluginCard()).getByRole('button', { name: '详情与设置' }));
    const detail = screen.getByRole('dialog', { name: '假发布 详情与设置' });
    // 打开弹窗时自动读一次账号列表。
    await waitFor(() => expect(detail.querySelector('.plugin-list[data-op="accounts"]')?.textContent).toContain('还没有。'), { timeout: 3000 });
    expect(backend.count('POST /api/stations/fake-publisher/ops/accounts')).toBe(1);
    // 只在卡片上的按钮（form: false）不出表单。
    expect(detail.querySelector('.station-op[data-op="logout"]')).toBeNull();
    expect(detail.querySelectorAll('.station-op')).toHaveLength(1);

    // 连点两下：按钮在重画成「不可点」之前还能收到第二下，第二次提交要被挡住。
    const login = within(detail.querySelector<HTMLElement>('.station-op[data-op="login"]')!).getByRole('button', { name: '登录平台账号' });
    act(() => {
      fireEvent.click(login);
      fireEvent.click(login);
    });
    await waitFor(() => expect(detail.querySelectorAll('.plugin-list[data-op="accounts"] .plugin-item')).toHaveLength(1), { timeout: 4000 });
    await waitFor(() => expect(detail.querySelector('.stations-result')?.textContent).toBe('已登录：小号'));
    const item = detail.querySelector<HTMLElement>('.plugin-list[data-op="accounts"] .plugin-item')!;
    expect(item.textContent).toContain('小号');
    expect(item.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    // 一次登录，加上登录完刷新一次账号列表。
    expect(backend.count('POST /api/stations/fake-publisher/ops/login')).toBe(1);
    expect(backend.count('POST /api/stations/fake-publisher/ops/accounts')).toBe(2);

    await userEvent.click(within(detail).getByRole('button', { name: '打开「发布看板」' }));
    expect(openPage).toHaveBeenCalledWith('x:fake-publisher:dashboard');
    expect(backend.unmatched).toEqual([]);
  });
});

/** 一个插件页面（或小窗）的宿主一侧：以 iframe 的身份发请求，在 iframe 上收宿主的回答。 */
function pageBridge(frame: HTMLIFrameElement) {
  const answers: { id?: number; ok?: boolean; ack?: boolean; result?: unknown; error?: string; type?: string }[] = [];
  frame.contentWindow!.addEventListener('message', (e) => answers.push(e.data));
  let next = 0;
  const ask = async (req: Record<string, unknown>) => {
    const id = ++next;
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { onset: 'station', id, ...req }, source: frame.contentWindow })));
    return id;
  };
  const answer = (id: number, timeout = 3000) =>
    waitFor(() => {
      const a = answers.find((x) => x.id === id && !x.ack);
      expect(a).toBeDefined();
      return a!;
    }, { timeout });
  return { ask, answer, answers };
}

describe('插件页面与小窗', () => {
  const project = { path: '/Users/me/示例', name: '示例' };

  beforeEach(() => {
    document.documentElement.style.setProperty('--accent', '#d9a35f');
  });
  afterEach(() => {
    document.documentElement.style.removeProperty('--accent');
  });

  it('嵌进发布页的小窗拿到嵌入位与设置（不含密钥），现读账号不用确认，能打开整页', async () => {
    const station = fakePublisher({
      settings: fakePublisher().settings.map((st) => (st.key === 'platform' ? { ...st, value: 'bilibili' } : { ...st, set: true })),
    });
    let accountsRun: StationRun | undefined;
    const backend = mockApi({
      '/api/stations': () => stations({ ...station, ops: station.ops.map((o) => (o.name === 'accounts' && accountsRun ? { ...o, last_run: accountsRun } : o)) }),
      'POST /api/stations/fake-publisher/ops/accounts': () => {
        accountsRun = run({ data: { items: [{ title: '小号' }] } });
        return { task_id: 'acc' };
      },
      '/api/tasks/acc': task('acc', 'succeeded'),
    });
    setStationPages([station]);
    const opened = vi.fn();
    const runAction = vi.fn();
    render(<StationSlots at="publish" context={{ scene: '' }} version={0} run={runAction} onQuick={vi.fn()} onOpen={opened} projectName={project.name} />);
    // 别的页面没有嵌入位就什么都不画。
    const slots = document.querySelector<HTMLElement>('.station-slots[data-slot="publish"]')!;
    expect(slots.textContent).toContain('发布小窗');
    expect(slots.textContent).toContain('第三方插件 · 假发布');
    const frame = slots.querySelector<HTMLIFrameElement>('.station-frame')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe('/station-ui/fake-publisher/ui/slot.html');
    expect(frame.parentElement?.style.height).toBe('140px');

    const page = pageBridge(frame);
    const info = (await page.answer(await page.ask({ type: 'info' }))).result as { project: string; page: string; context: Record<string, unknown>; settings: Record<string, unknown> };
    expect(info.context.slot).toBe('publish');
    expect(info.page).toBe('mini');
    expect(info.project).toBe('示例');
    expect(info.settings).toEqual({ platform: 'bilibili' });

    // 账号列表：先说收到了，跑完列表操作再从插件列表里取结果；不用用户确认。
    const listed = await page.ask({ type: 'list', op: 'accounts' });
    await waitFor(() => expect(page.answers.some((a) => a.id === listed && a.ack)).toBe(true));
    expect((await page.answer(listed)).result).toEqual({ items: [{ title: '小号' }] });
    expect(document.querySelector('.station-confirm')).toBeNull();
    // 不是列表操作的不给读。
    expect((await page.answer(await page.ask({ type: 'list', op: 'send' }))).error).toContain('没有列表操作 send');

    // 小窗里打开插件的整页；「单独打开」同理。
    expect((await page.answer(await page.ask({ type: 'open', page: 'dashboard' }))).result).toEqual({ opened: true });
    expect(opened).toHaveBeenCalledWith('x:fake-publisher:dashboard');
    await userEvent.click(screen.getByRole('button', { name: '单独打开' }));
    expect(opened).toHaveBeenLastCalledWith('x:fake-publisher:mini');

    // 别的来源发来的消息不理。
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { onset: 'station', id: 99, type: 'info' }, source: window })));
    await new Promise((r) => setTimeout(r, 20));
    expect(page.answers.some((a) => a.id === 99)).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
    expect(backend.unmatched).toEqual([]);
  });

  it('整页：配色、项目概况、读文件经宿主；执行与调用片场的操作先请用户确认；斜杠命令登记上', async () => {
    const station = fakePublisher();
    const backend = mockApi({
      '/api/state': { project: { id: 'p1', path: project.path, name: project.name, last_opened_at: '' }, metadata: { film_style: '' }, step: 'publish' },
      '/api/scenes': { scenes: [{ id: 'scene-001', directory: `${project.path}/scenes/scene-001`, duration_seconds: 4, exists: true, stale: false, output: 'scene-001.mp4' }] },
      '/api/progress': { mode: 'speech', current: 'publish', waiting_on: 'ai', turns: {}, stations: [{ id: 'publish', label: '发布', step: 'publish', status: 'todo', turns: [] }] },
      '/api/publish': { available: true, data: { platform: 'douyin' } },
      '/api/stations/fake-publisher/read': (req: MockRequest) =>
        req.query.get('path') === '.env' ? reply(403, { message: '这个插件没有声明会读 .env' }) : { path: req.query.get('path'), size: 42, text: '---\nplatform: douyin\n---\n' },
    });
    setStationPages([station]);
    // 插件的斜杠命令跟着插件表登记进对话的 / 补全。
    expect(slashCommands.find((c) => c.name === 'fabu')).toMatchObject({ label: '打开发布看板（插件）', plugin: { tab: 'x:fake-publisher:dashboard' } });
    const runAction = vi.fn();
    const quick = vi.fn();
    render(<StationPage tab="x:fake-publisher:dashboard" version={0} run={runAction} onQuick={quick} projectName={project.name} />);
    const host = document.querySelector<HTMLElement>('.station-page')!;
    expect(host.textContent).toContain('发布看板');
    expect(host.textContent).toContain('第三方插件 · 假发布');
    const page = pageBridge(host.querySelector<HTMLIFrameElement>('.station-frame')!);

    // 页面跟随宿主的配色。
    const theme = (await page.answer(await page.ask({ type: 'theme' }))).result as { vars: Record<string, string>; css: string };
    expect(theme.vars['--accent']).toBe('#d9a35f');
    expect(theme.css).toContain('button.primary');
    // 申请了看项目：只给摘要。
    const summary = (await page.answer(await page.ask({ type: 'project' }))).result as { name: string; scenes: { id: string; output: string }[]; progress: { current: string }; publish: unknown };
    expect(summary.scenes).toEqual([{ id: 'scene-001', duration_seconds: 4, rendered: true, stale: false, rendering: false, output: 'scenes/scene-001/scene-001.mp4' }]);
    expect(summary.progress.current).toBe('publish');
    expect(summary.publish).toEqual({ platform: 'douyin' });
    // 读文件经宿主的接口，后端拒绝的照实转给页面。
    expect(((await page.answer(await page.ask({ type: 'read', path: 'publish.md' }))).result as { size: number }).size).toBe(42);
    expect((await page.answer(await page.ask({ type: 'read', path: '.env' }))).error).toContain('没有声明会读 .env');

    // 执行本站的操作：先回「收到了」，在页面上方请用户确认。
    const send = await page.ask({ type: 'run', op: 'send', params: { platform: 'douyin' } });
    await waitFor(() => expect(page.answers.some((a) => a.id === send && a.ack)).toBe(true));
    const confirm = screen.getByRole('alertdialog', { name: '插件请求执行' });
    expect(confirm.textContent).toContain('「假发布」请求执行：把成片发到平台');
    expect(confirm.textContent).toContain('platform=douyin');
    // 确认条盖在页面上，不另起一行把 iframe 往下推：与 iframe 同在一个容器里。
    expect(confirm.parentElement).toBe(host.querySelector('.station-frame-wrap'));
    // 还在等用户时又来一个执行请求：直接拒掉。
    expect((await page.answer(await page.ask({ type: 'run', op: 'scribble' }))).error).toContain('上一个请求还在等用户确认');
    expect(runAction).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole('button', { name: '执行' }));
    expect(runAction).toHaveBeenCalledWith('/api/stations/fake-publisher/ops/send', { params: { platform: 'douyin' } });
    expect((await page.answer(send)).result).toEqual({ started: true });

    // 拒绝：页面拿到「没有同意」。
    const again = await page.ask({ type: 'run', op: 'send', params: { platform: 'douyin' } });
    await userEvent.click(within(await screen.findByRole('alertdialog', { name: '插件请求执行' })).getByRole('button', { name: '不执行' }));
    expect((await page.answer(again)).error).toBe('用户没有同意');

    // 调 onset 自带的操作：只能是申请过的，同样先确认。
    expect((await page.answer(await page.ask({ type: 'call', op: 'concat' }))).error).toContain('没有申请调用 concat');
    const review = await page.ask({ type: 'call', op: 'review', params: {} });
    const reviewConfirm = await screen.findByRole('alertdialog', { name: '插件请求执行' });
    expect(reviewConfirm.textContent).toContain('「假发布」请求调用片场的：整片复查');
    await userEvent.click(within(reviewConfirm).getByRole('button', { name: '不执行' }));
    expect((await page.answer(review)).error).toBe('用户没有同意');
    const review2 = await page.ask({ type: 'call', op: 'review', params: {} });
    await userEvent.click(within(await screen.findByRole('alertdialog', { name: '插件请求执行' })).getByRole('button', { name: '执行' }));
    expect(runAction).toHaveBeenLastCalledWith('/api/stations/fake-publisher/call/review', { params: {} });
    expect((await page.answer(review2)).ok).toBe(true);

    // 交给 AI：只填进对话框，不发送。
    expect((await page.answer(await page.ask({ type: 'ask', text: '帮我写一句抖音的发布语' }))).result).toEqual({ filled: true });
    expect(quick).toHaveBeenCalledWith('（来自插件「假发布」的页面）\n帮我写一句抖音的发布语', [], true);
    // 替用户发一条消息：要确认，确认了才发。
    const msg = await page.ask({ type: 'send', text: '帮我把发布标题改短一点' });
    const sendConfirm = await screen.findByRole('alertdialog', { name: '插件请求执行' });
    expect(sendConfirm.textContent).toContain('「假发布」想替你发一条消息给 AI');
    expect(sendConfirm.textContent).toContain('帮我把发布标题改短一点');
    await userEvent.click(within(sendConfirm).getByRole('button', { name: '执行' }));
    expect(quick).toHaveBeenLastCalledWith('（来自插件「假发布」的页面）\n帮我把发布标题改短一点', [], false);
    expect((await page.answer(msg)).result).toEqual({ sent: true });
    expect(backend.unmatched).toEqual([]);
  });

  it('插件去掉后，留着的页面说清楚它已经不在了', () => {
    setStationPages([]);
    render(<StationPage tab="x:fake-publisher:dashboard" version={0} run={vi.fn()} onQuick={vi.fn()} projectName="示例" />);
    expect(document.body.textContent).toContain('这个插件页面已经不在了');
  });
});

describe('第三方站声明的状态', () => {
  // 假发布用清单顶替内置「发布」（declared-state.json）：publish.md 是 pending_manual_checks 时，
  // /api/progress 给的就是这一份（studio/declared.test.ts 钉着后端怎么判）。
  const progress: ProgressState = {
    mode: 'speech',
    current: 'auto-publish',
    waiting_on: 'user',
    turns: { t1: ['review'] },
    stations: [
      { id: 'review', label: '复查', step: 'final', status: 'done', turns: [] },
      {
        id: 'auto-publish',
        label: '自动发布',
        step: 'publish',
        status: 'todo',
        detail: '还剩人工检查',
        page: 'x:fake-publisher:dashboard',
        turns: [],
        guide: {
          user: '发布前还剩几项人工检查：核对完告诉 AI，或者先记一笔。',
          actions: [
            { kind: 'draft', label: '核对完了', text: '发布前的人工检查我核对完了：' },
            { kind: 'op', label: '先记一笔', station: 'fake-publisher', op: 'scribble', summary: '顺手记一笔（测试用：会写一个没声明的文件）' },
            { kind: 'page', label: '看发布看板', page: 'x:fake-publisher:dashboard' },
          ],
        },
      },
    ],
  };

  it('说清在等你，「接下来」的按钮填输入框、先确认再执行插件操作、开插件页面', async () => {
    const user = userEvent.setup();
    mockApi({ '/api/sessions': [] });
    const runAction = vi.fn();
    const view = vi.fn();
    const openProgress = vi.fn();
    render(
      <Chat
        agents={null}
        choice={{ tool: 'claude', renderer: 'claude' }}
        onChoice={() => {}}
        sessions={[]}
        sessionId=""
        busy=""
        attachments={[]}
        projectPath="/Users/me/示例"
        onSession={() => {}}
        onSessionsChanged={() => {}}
        onRemoveAttachment={() => {}}
        onClearAttachments={() => {}}
        onFilesChanged={() => {}}
        onTurnEnd={() => {}}
        onOpenFile={() => {}}
        onAddAttachments={() => {}}
        scenes={[]}
        outbox={null}
        view={{ page: '' }}
        onView={view}
        tree={[]}
        run={runAction}
        progress={progress}
        jump={null}
        onProgress={openProgress}
      />,
    );
    const strip = document.getElementById('progress-strip')!;
    expect(strip.textContent).toContain('现在 · 自动发布');
    expect(strip.textContent).toContain('还剩人工检查，等你处理');
    expect(strip.className).toMatch(/waiting/);
    await user.click(strip);
    expect(openProgress).toHaveBeenCalled();

    const card = document.getElementById('next-step')!;
    expect(card.textContent).toContain('发布前还剩几项人工检查');
    // 填进输入框。
    await user.click(within(card).getByRole('button', { name: '核对完了' }));
    expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe('发布前的人工检查我核对完了：');
    // 插件的操作：先在卡片上问一次，点「执行」才跑。
    await user.click(within(card).getByRole('button', { name: '先记一笔' }));
    const confirm = within(card).getByRole('alertdialog', { name: '确认执行' });
    expect(confirm.textContent).toContain('执行插件操作「顺手记一笔（测试用：会写一个没声明的文件）」？');
    await user.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(within(card).queryByRole('alertdialog', { name: '确认执行' })).toBeNull();
    expect(runAction).not.toHaveBeenCalled();
    await user.click(within(card).getByRole('button', { name: '先记一笔' }));
    await user.click(within(card).getByRole('alertdialog', { name: '确认执行' }).querySelector<HTMLButtonElement>('button.primary')!);
    expect(runAction).toHaveBeenCalledWith('/api/stations/fake-publisher/ops/scribble', { params: {} });
    // 开插件页面。
    await user.click(within(card).getByRole('button', { name: '看发布看板' }));
    expect(view).toHaveBeenCalledWith({ page: 'x:fake-publisher:dashboard', target: undefined });
  });
});
