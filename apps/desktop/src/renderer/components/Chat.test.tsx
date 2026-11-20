// @vitest-environment jsdom
/*
 * 对话主栏（Chat.tsx）在整个 App 里的行为：长对话一次画完并落在最新一轮、「回到最新」跟着滚动范围走、
 * 后台任务条、镜头页快捷指令、编排工具标的制作步骤。原来在 e2e/chat.spec.mjs、chat-scroll.spec.mjs 里。
 * 后台用 chat/studioHarness 的事件库代替，「重新加载」是用同一份事件库再挂一次 App。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStudio, type EventInput, findEl, projectState, scenePageRoutes, session, sessionId, turnDone, turnStart } from './chat/studioHarness';

const messages = () => document.getElementById('messages')!;
const tasksRegion = () => screen.queryByRole('region', { name: '正在执行的后台任务' });

async function send(text: string) {
  const user = userEvent.setup();
  await user.type(document.getElementById('prompt')!, text);
  await user.click(document.getElementById('send')!);
}

/**
 * jsdom 不排版：#messages 的滚动范围按测试给的高度算，scrollTop 夹在范围里，scrollTo 直接落到目标。
 * ResizeObserver 换成可以手动触发的：真浏览器里展开、收起只改变高度、不发 scroll 事件，靠它纠正按钮。
 */
function fakeScrollLayout(contentHeight: () => number, viewport = 500) {
  const tops = new WeakMap<Element, number>();
  const observers: { callback: ResizeObserverCallback }[] = [];
  const isLog = (el: Element) => el.id === 'messages';
  const proto = HTMLElement.prototype;
  const saved = {
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
    scrollTo: Element.prototype.scrollTo,
  };
  const max = () => Math.max(0, contentHeight() - viewport);
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get(this: Element) { return isLog(this) ? Math.max(contentHeight(), viewport) : 0; } });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get(this: Element) { return isLog(this) ? viewport : 0; } });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: Element) { return Math.min(tops.get(this) ?? 0, isLog(this) ? max() : 0); },
    set(this: Element, value: number) { tops.set(this, Math.max(0, Math.min(value, isLog(this) ? max() : 0))); },
  });
  proto.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options === 'object' && options.top !== undefined) this.scrollTop = options.top;
  } as Element['scrollTo'];
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.push(this); }
    observe() {}
    unobserve() {}
    disconnect() { observers.splice(observers.indexOf(this), 1); }
  });
  return {
    /** 布局变了（展开、收起、图片解码完）：通知还在观察的 ResizeObserver。 */
    relayout() {
      act(() => { for (const o of [...observers]) o.callback([], o as unknown as ResizeObserver); });
    },
    /** 用户把对话滚到某个位置。 */
    scrollTo(top: number) {
      messages().scrollTop = top;
      fireEvent.scroll(messages());
    },
    gap() {
      const el = messages();
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    },
    restore() {
      for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
        delete (proto as unknown as Record<string, unknown>)[key];
        if (saved[key]) Object.defineProperty(Element.prototype, key, saved[key]!);
      }
      proto.scrollTo = saved.scrollTo;
    },
  };
}

describe('Chat', () => {
  let layout: ReturnType<typeof fakeScrollLayout> | null = null;
  beforeEach(() => {
    layout = null;
  });
  afterEach(() => layout?.restore());

  // 重新打开一段长对话：历史一次画完、直接落在最新一轮，不是从第一条起一帧帧往下长、往下滚。
  test('reopening a long conversation lands on the latest turn at once', async () => {
    const turns = 8;
    const studio = createStudio({ sessions: [session(sessionId, { turns: Array.from({ length: turns }, (_, i) => `t${i + 1}`) })] });
    for (let i = 1; i <= turns; i++) studio.seed([...turnStart(`t${i}`, `第 ${i} 句话`), ...turnDone(`t${i}`, `第 ${i} 轮回复`)]);
    layout = fakeScrollLayout(() => document.querySelectorAll('.assistant-flow').length * 400);
    // 记下每次 DOM 变化后对话里有几轮：一帧帧补出来的话，这串数会从 1 慢慢涨到 8。
    const seen: number[] = [];
    const observer = new MutationObserver(() => {
      const n = document.querySelectorAll('.assistant-flow').length;
      if (n > 0 && seen[seen.length - 1] !== n) seen.push(n);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    studio.render();
    await waitFor(() => expect(document.querySelectorAll('.assistant-flow')).toHaveLength(turns));
    observer.disconnect();
    expect(seen).toEqual([turns]);
    expect(layout.gap()).toBeLessThanOrEqual(8);
    expect(document.querySelector('.intro')).toBeNull();
    expect(document.querySelectorAll('.done-line')).toHaveLength(turns);

    // 翻历史后，按钮与手动滚动都必须能回到最后一轮。
    layout.scrollTo(0);
    const jump = await screen.findByRole('button', { name: '回到最新' });
    await userEvent.setup().click(jump);
    expect(layout.gap()).toBeLessThanOrEqual(8);
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();

    layout.scrollTo(0);
    expect(await screen.findByRole('button', { name: '回到最新' })).toBeTruthy();
    layout.scrollTo(100_000);
    expect(layout.gap()).toBeLessThanOrEqual(8);
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();
    expect(studio.api.unmatched).toEqual([]);
  });

  // 原 chat-scroll.spec.mjs：展开、收起过程只改变滚动范围（不发 scroll 事件）时，「回到最新」也跟着变；历史里被拒的命令显示成失败。
  test('keeps the latest button in step with the scroll range when the process expands or collapses', async () => {
    const studio = createStudio({ sessions: [session(sessionId, { title: '滚动测试', turns: ['scroll-turn'] })] });
    const turn = 'scroll-turn';
    const events: EventInput[] = [
      { kind: 'user', turn_id: turn, text: '检查项目' },
      { kind: 'turn-start', turn_id: turn, status: 'running' },
      { kind: 'text', turn_id: turn, text: Array.from({ length: 30 }, (_, i) => `正在检查第 ${i + 1} 项。`).join('\n\n') },
      { kind: 'thinking', turn_id: turn, text: Array.from({ length: 60 }, (_, i) => `思考第 ${i + 1} 步。`).join('\n\n') },
      { kind: 'tool-call', turn_id: turn, tool: 'Read', call_id: 'read', input: { file_path: 'notes.md' } },
      { kind: 'tool-result', turn_id: turn, tool: 'Read', call_id: 'read', text: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行检查结果。`).join('\n') },
      // 一次被拒的命令：历史里要显示成失败，而不是一直在转。
      { kind: 'tool-call', turn_id: turn, tool: 'Bash', call_id: 'denied', input: { command: 'pwd' } },
      { kind: 'tool-result', turn_id: turn, tool: 'Bash', call_id: 'denied', text: 'denied', is_error: true },
      { kind: 'text', turn_id: turn, text: '检查完成，这是最新回复。' },
      { kind: 'turn-end', turn_id: turn, status: 'succeeded' },
    ];
    studio.seed(events.map((e) => ({ ...e, time: '2026-01-01T00:00:00Z' })));
    // 过程收起时整段对话正好放得下；展开后高出一截。
    layout = fakeScrollLayout(() => ((document.querySelector('.shell') as HTMLDetailsElement | null)?.open ? 2000 : 500));
    studio.render();
    await waitFor(() => expect(document.querySelector('.message.assistant')?.textContent).toContain('这是最新回复'));
    const user = userEvent.setup();
    const summary = () => document.querySelector('.shell > summary') as HTMLElement;
    await user.click(summary());
    expect(document.querySelectorAll('.tool.running')).toHaveLength(0);
    expect(document.querySelector('.tool.done')?.textContent).toContain('notes.md');
    expect(document.querySelector('.tool.failed')?.textContent).toContain('pwd');

    // 点开过程（点 summary 时停止跟随）：高度变了，「回到最新」出现。
    layout.relayout();
    expect(messages().scrollHeight - messages().clientHeight).toBeGreaterThan(500);
    expect(screen.getByRole('button', { name: '回到最新' })).toBeTruthy();
    // 在顶部收起过程：scrollTop 一直是 0，不会有 scroll 事件来纠正按钮。
    layout.scrollTo(0);
    await user.click(summary());
    layout.relayout();
    expect(messages().scrollHeight - messages().clientHeight).toBe(0);
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();

    // 再展开、翻上去：按钮能回到最新回复。
    await user.click(summary());
    layout.relayout();
    layout.scrollTo(0);
    await user.click(screen.getByRole('button', { name: '回到最新' }));
    expect(layout.gap()).toBeLessThanOrEqual(8);
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();
    expect(studio.api.unmatched).toEqual([]);
  });

  test('shows Claude background tasks, restores them on reload, and clears completed or stopped work', async () => {
    const studio = createStudio();
    studio.render();
    await screen.findByText('说说要做什么');
    await send('后台任务测试');
    await waitFor(() => expect(studio.api.calls.find((c) => c.method === 'POST' && c.path === '/api/sessions/s1/turns')?.body).toMatchObject({ message: '后台任务测试' }));
    // 后端把 Claude 的 task_started 整理成完整的后台任务清单（agentrun 的 BackgroundTasks）。
    await studio.emit([
      ...turnStart('t1', '后台任务测试'),
      { kind: 'background-tasks', turn_id: 't1', background_tasks: [{ id: 'a', description: '检查素材尺寸' }] },
      { kind: 'background-tasks', turn_id: 't1', background_tasks: [{ id: 'a', description: '检查素材尺寸' }, { id: 'b', description: '生成配音' }] },
      { kind: 'text', turn_id: 't1', text: '任务已交给后台处理。' },
    ]);
    let tasks = tasksRegion()!;
    expect(tasks.textContent).toContain('2 个后台任务正在执行');
    expect(tasks.textContent).toContain('检查素材尺寸');
    expect(tasks.textContent).toContain('生成配音');
    expect(messages().textContent).not.toContain('正在启动 AI');

    studio.remount();
    await waitFor(() => expect(tasksRegion()?.textContent).toContain('2 个后台任务正在执行'));
    // task_progress 带上进度，task_notification 结束配音。
    await studio.emit({ kind: 'background-tasks', turn_id: 't1', background_tasks: [{ id: 'a', description: '检查素材尺寸', activity: '正在核对封面图片' }] });
    tasks = tasksRegion()!;
    expect(tasks.textContent).toContain('1 个后台任务正在执行');
    expect(tasks.textContent).toContain('正在核对封面图片');
    expect(tasks.textContent).not.toContain('生成配音');
    await studio.emit({ kind: 'background-tasks', turn_id: 't1', background_tasks: [] });
    expect(tasksRegion()).toBeNull();
    await studio.emit({ kind: 'background-tasks', turn_id: 't1', background_tasks: [{ id: 'c', description: '整理检查报告' }] });
    expect(tasksRegion()?.textContent).toContain('整理检查报告');
    expect(tasksRegion()?.textContent).not.toContain('检查素材尺寸');

    // 停下这一轮：后端结束 CLI 进程、写 turn-end，后台任务随之清掉。
    await userEvent.setup().click(document.getElementById('cancel-turn')!);
    expect(studio.api.count('POST /api/sessions/s1/cancel')).toBe(1);
    await studio.emit({ kind: 'turn-end', turn_id: 't1', status: 'cancelled' });
    expect(tasksRegion()).toBeNull();
    studio.remount();
    await waitFor(() => expect(document.querySelector('.pause-line')).not.toBeNull());
    expect(tasksRegion()).toBeNull();
    expect(studio.api.unmatched).toEqual([]);
  });

  test('shows OpenCode child tasks and clears them when stopped', async () => {
    // 新对话：选了 opencode，建会话时带上。
    const studio = createStudio({
      open: '',
      sessions: [],
      routes: {
        'POST /api/sessions': (req: { body: unknown }) => {
          const created = session(sessionId, { tool: (req.body as { tool: string }).tool, title: '后台子任务挂起' });
          studio.setSessions([created]);
          return created;
        },
      },
    });
    studio.render();
    await screen.findByText('说说要做什么');
    const user = userEvent.setup();
    await waitFor(() => expect(document.querySelector('#agent-tool option[value="opencode"]')).not.toBeNull());
    await user.selectOptions(document.getElementById('agent-tool')!, 'opencode');
    await send('后台子任务挂起');
    await waitFor(() => expect(studio.api.count('POST /api/sessions/s1/turns')).toBe(1));
    expect(studio.api.calls.find((c) => c.method === 'POST' && c.path === '/api/sessions')?.body).toMatchObject({ tool: 'opencode' });
    // ACP 的子任务由 agentrun 的 ActiveTasks 整理成同一种事件。
    await studio.emit([...turnStart('t1', '后台子任务挂起'), { kind: 'background-tasks', turn_id: 't1', background_tasks: [{ id: 'sub', description: '核对分镜' }] }]);
    expect(tasksRegion()?.textContent).toContain('1 个后台任务正在执行');
    expect(tasksRegion()?.textContent).toContain('核对分镜');
    studio.remount();
    await waitFor(() => expect(tasksRegion()?.textContent).toContain('核对分镜'));
    await user.click(document.getElementById('cancel-turn')!);
    await studio.emit({ kind: 'turn-end', turn_id: 't1', status: 'cancelled' });
    expect(tasksRegion()).toBeNull();
    expect(document.querySelector('.pause-line')?.textContent).toContain('已停止');
    expect(studio.api.unmatched).toEqual([]);
  });

  test('sends a scene quick action to the orchestrator', async () => {
    const studio = createStudio({ routes: scenePageRoutes });
    studio.render();
    await screen.findByText('说说要做什么');
    const user = userEvent.setup();
    // 快捷指令收在镜头页的「⋯」菜单里；点步骤打开画面面板。
    await user.click(await findEl('[data-tab="scene"]'));
    await user.click(await findEl('.scene-menu summary'));
    const quick = await findEl('.quick-actions');
    await user.click(within(quick).getByRole('button', { name: '重做这个镜头' }));
    await waitFor(() => expect(studio.api.count('POST /api/sessions/s1/turns')).toBe(1));
    const sent = studio.api.calls.find((c) => c.path === '/api/sessions/s1/turns')!.body as { message: string };
    expect(sent.message).toContain('重做镜头 scene-001');
    await studio.emit([...turnStart('t1', sent.message), ...turnDone('t1', '换了一个方案')]);
    expect(document.querySelector('.message.user')?.textContent).toContain('重做镜头 scene-001');
    expect(document.querySelector('.done-line')?.textContent).toContain('已完成');
    expect(studio.api.unmatched).toEqual([]);
  });

  test('the orchestrator marks which production step the project is at', async () => {
    const studio = createStudio();
    studio.render();
    await screen.findByText('说说要做什么');
    const step = (id: string) => document.querySelector(`[data-tab="${id}"]`) as HTMLElement;
    // 没标过时按产物推：项目里还没有任何制作产物，算在第一步。
    await waitFor(() => expect(step('script').className).toMatch(/current/));
    await send('标步骤');
    // studio_step 经收件目录交给后端：后端记下 step.json，再发一条只标步骤的 view 事件。
    studio.setState(projectState('final', true));
    await studio.emit([
      ...turnStart('t1', '标步骤'),
      { kind: 'view', turn_id: 't1', text: '成片拼好了，等你试听', view: { page: '', step: 'final', note: '成片拼好了，等你试听' } },
      ...turnDone('t1', '成片拼好了'),
    ]);
    expect(messages().textContent).toContain('成片拼好了');
    await waitFor(() => expect(step('final').className).toMatch(/current/));
    expect(step('final').getAttribute('title')).toBe('AI 标记：现在在这一步');
    expect(step('scene').className).toMatch(/done/);
    expect(step('scene').querySelector('.step-no')?.textContent).toBe('✓');
    // 只标步骤不切页，回复下面也不留「↗ 页面」链接；面板仍是收起的。
    expect(document.getElementById('panel')).toBeNull();
    expect(document.querySelector('.view-links')).toBeNull();
    // 标记跟着项目走：重新加载后还在。
    studio.remount();
    await waitFor(() => expect(step('final').className).toMatch(/current/));
    expect(studio.api.unmatched).toEqual([]);
  });

  test('triggers manual session handoff via header button and /handoff command', async () => {
    const studio = createStudio({
      open: 's1',
      sessions: [
        {
          session_id: 's1',
          title: '整片制作',
          kind: 'production',
          tool: 'claude',
          created_at: '2026-11-20T00:00:00Z',
          updated_at: '2026-11-20T00:00:00Z',
          turns: ['t1'],
        },
      ],
      routes: {
        'POST /api/sessions/s1/handoff': { ok: true },
      },
    });
    studio.render();
    const btn = await findEl('#handoff-session');
    const user = userEvent.setup();
    await user.click(btn);
    await waitFor(() => expect(studio.api.count('POST /api/sessions/s1/handoff')).toBe(1));
    await send('/handoff');
    await waitFor(() => expect(studio.api.count('POST /api/sessions/s1/handoff')).toBe(2));
    expect(studio.api.unmatched).toEqual([]);
  });
});
