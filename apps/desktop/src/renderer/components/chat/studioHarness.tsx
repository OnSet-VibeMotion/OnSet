/*
 * 对话区组件测试的共用后台：在 jsdom 里渲染整个 App（已经打开了一个口播项目），后端换成 testing.tsx 的路由表，
 * 会话事件放在一份事件库里——打开会话时一次取完历史（follow=0 的 SSE 正文），之后经 FakeEventSource 一条条推。
 *
 * 「重新加载」就是卸载后用同一份事件库再挂一次（remount）。
 * 只给 *.test.tsx 用，不进界面产物。
 */
import { act, render, waitFor, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from '../../app';
import { mockApi, useFakeEventSource, FakeEventSource } from '../../testing';
import type {
  Attachment,
  AgentsResponse,
  FilmStylesResponse,
  ModelsResponse,
  ProgressState,
  Project,
  ProjectFilmStyle,
  ProjectState,
  Scene,
  SceneActivity,
  SessionEvent,
  SessionMeta,
  SetupStatus,
  StationsResponse,
  StoryboardResponse,
  Task,
  TreeFile,
} from '../../types';

export const project: Project = { id: 'p1', path: '/Users/me/onset-studio-e2e-x', name: 'onset-studio-e2e-x', last_opened_at: '2026-11-17T00:00:00Z' };
export const sessionId = 's1';

/** 与 inspectProject 给口播项目的一样：flowView 的口播流程、宿主的页面表。 */
export function projectState(step = 'script', marked = false): ProjectState {
  return {
    project,
    metadata: { canvas: '1080x1440' },
    scenes: { total: 1, completed: 0, stale: 0 },
    step,
    step_marked: marked,
    flow: {
      id: 'speech',
      name: '口播',
      first_page: 'script',
      steps: ['script', 'storyboard', 'scene', 'final', 'publish'],
      hidden_pages: ['beat'],
      first_steps: ['script', 'beat'],
      land_page: '',
    },
    pages: [
      { id: 'progress', label: '制作路线' },
      { id: 'script', label: '口播稿' },
      { id: 'storyboard', label: '分镜' },
      { id: 'scene', label: '镜头' },
      { id: 'compose', label: '合成' },
      { id: 'final', label: '成片' },
      { id: 'style', label: '风格' },
      { id: 'voice', label: '音色' },
      { id: 'review', label: '复查' },
      { id: 'memory', label: '记忆' },
      { id: 'file', label: '文件' },
      { id: 'publish', label: '发布' },
    ],
  };
}

export const scene001: Scene = { id: 'scene-001', directory: 'scenes/scene-001', duration_seconds: 1, output: 'out.mp4', exists: false, stale: false, attempts: 0 };

export const agents: AgentsResponse = {
  agents: [
    { id: 'claude', label: 'Claude Code', command: 'claude', installed: true, renderer: true },
    { id: 'codex', label: 'Codex', command: 'codex', installed: true, renderer: true },
    { id: 'opencode', label: 'OpenCode', command: 'opencode', installed: true, renderer: true },
  ],
  orchestrator: 'claude',
  renderer: 'claude',
  orchestrator_model: '',
  renderer_model: '',
  global_renderer: 'claude',
};

export const setupReady: SetupStatus = { ready: true, items: [], command: 'onset setup' };

export function session(id = sessionId, patch: Partial<SessionMeta> = {}): SessionMeta {
  return { session_id: id, title: '对话', kind: 'chat', tool: 'claude', renderer: 'claude', created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:00Z', turns: [], ...patch };
}

/** 一条会话事件：seq 由事件库给，time 缺省是现在。 */
export type EventInput = Omit<SessionEvent, 'seq' | 'time'> & { time?: string };

export interface StudioOptions {
  state?: ProjectState;
  scenes?: Scene[];
  tree?: TreeFile[];
  progress?: ProgressState;
  filmStyles?: FilmStylesResponse;
  sessions?: SessionMeta[];
  tasks?: Task[];
  /** 打开项目时恢复哪个会话（localStorage 里记的那个）；空串是新对话。 */
  open?: string;
  /** 额外的路由（同名的盖掉缺省）。 */
  routes?: Record<string, unknown>;
}

/** 把事件写成 SSE 正文（后端 follow=0 时写完历史就结束）。 */
function sse(events: SessionEvent[]): string {
  return events.map((e) => `id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

export function createStudio(options: StudioOptions = {}) {
  const log = new Map<string, SessionEvent[]>();
  let sessions = options.sessions ?? [session()];
  let tasks = options.tasks ?? [];
  let state = options.state ?? projectState();
  let scenes = options.scenes ?? [scene001];
  const api = mockApi({
    '/api/projects': { projects: [project], current_project_id: project.id, summaries: {}, default_parent: '/Users/me' },
    '/api/agents': agents,
    // 模型下拉框：各家工具自己报的模型（claude 是帮助里写的别名）。
    '/api/agents/claude/models': { tool: 'claude', models: [{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }] } satisfies ModelsResponse,
    '/api/agents/codex/models': { tool: 'codex', models: [] } satisfies ModelsResponse,
    '/api/agents/opencode/models': { tool: 'opencode', models: [] } satisfies ModelsResponse,
    '/api/setup': setupReady,
    '/api/skills': { status: { installed: true, installing: false } },
    '/api/state': () => state,
    '/api/scenes': () => ({ scenes }),
    '/api/tree': { files: options.tree ?? [{ path: 'notes.md', size: 13, mtime: 1 }, { path: 'scenes/scene-001/prompt.md', size: 7, mtime: 1 }] },
    '/api/stations': { stations: [], problems: [] } satisfies StationsResponse,
    '/api/progress': options.progress ?? emptyProgress,
    '/api/sessions': () => ({ sessions, busy: '' }),
    '/api/tasks': () => ({ tasks }),
    '/api/film-styles': options.filmStyles ?? ({ sources: [], styles: [] } satisfies FilmStylesResponse),
    'POST /api/sessions/s1/turns': {},
    'POST /api/sessions/s1/cancel': {},
    ...options.routes,
  });
  // 历史一次取完（follow=0），不经路由表：路由表只回 JSON。
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'onset://app/');
    const m = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (m && url.searchParams.get('follow') === '0') return new Response(sse(log.get(m[1]) ?? []), { status: 200 });
    return inner(input, init);
  });
  useFakeEventSource();
  try {
    if (options.open !== '') localStorage.setItem('onset-studio-session:' + project.id, options.open ?? sessionId);
    else localStorage.removeItem('onset-studio-session:' + project.id);
    localStorage.removeItem('onset-studio.panel-open');
  } catch {
    // jsdom 总有 localStorage。
  }

  const append = (id: string, input: EventInput): SessionEvent => {
    const list = log.get(id) ?? [];
    const event = { time: new Date().toISOString(), ...input, seq: list.length + 1 } as SessionEvent;
    list.push(event);
    log.set(id, list);
    return event;
  };
  let view: RenderResult | null = null;

  return {
    api,
    /** 事先写进历史（打开会话前用）。 */
    seed(events: EventInput[], id = sessionId) {
      for (const e of events) append(id, e);
    },
    /** 后端推一条新事件：记进历史，并发给这个会话正开着的订阅，等它画出来。 */
    async emit(input: EventInput | EventInput[], id = sessionId) {
      await act(async () => {
        for (const one of Array.isArray(input) ? input : [input]) {
          const event = append(id, one);
          const source = [...FakeEventSource.all].reverse().find((s) => s.readyState !== 2 && s.url.includes(`/sessions/${id}/`));
          source?.emit(event, event.kind, String(event.seq));
        }
        // 订阅收到的事件攒到下一帧一起画。
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
    },
    /** 当前会话的订阅（断线、重连用）。 */
    source(id = sessionId) {
      return [...FakeEventSource.all].reverse().find((s) => s.readyState !== 2 && s.url.includes(`/sessions/${id}/`));
    },
    setSessions(next: SessionMeta[]) {
      sessions = next;
    },
    setTasks(next: Task[]) {
      tasks = next;
    },
    setState(next: ProjectState) {
      state = next;
    },
    setScenes(next: Scene[]) {
      scenes = next;
    },
    events(id = sessionId) {
      return log.get(id) ?? [];
    },
    render() {
      view = render(<App />);
      return view;
    },
    /** 重新加载：卸载后用同一份后台再挂一次。 */
    remount() {
      view?.unmount();
      view = render(<App />);
      return view;
    },
  };
}

/** 还没有任何站点信息的制作路线。 */
const emptyProgress: ProgressState = { mode: 'speech', stations: [], current: '', waiting_on: '', turns: {} };

/** 一轮常见的开头：用户的话与 turn-start。 */
export function turnStart(turn: string, text: string): EventInput[] {
  return [
    { kind: 'user', turn_id: turn, text },
    { kind: 'turn-start', turn_id: turn, status: 'running' },
  ];
}

/** 一轮做完：回复与 turn-end。 */
export function turnDone(turn: string, text: string, status = 'succeeded'): EventInput[] {
  return [
    { kind: 'text', turn_id: turn, text },
    { kind: 'turn-end', turn_id: turn, status },
  ];
}

/**
 * 后端写进用户消息的文字：用户的话后面接「用户引用的内容」一节。
 * 照 packages/engine/src/studio/sessions.ts 的 attachmentText 写（这里只有对话测试用到的引用）。
 */
export function userText(message: string, attachments: Attachment[] = []): string {
  let out = message;
  const refs = attachments.filter((a) => !a.upload && (a.quote || a.ref));
  if (refs.length > 0) {
    out += '\n\n用户引用的内容（这条消息说的就是这些）：';
    for (const a of refs) {
      out += '\n- ';
      if (a.quote) {
        out += (a.label || '一段文字') + (a.source ? `（${a.source}）` : '') + '：';
        for (const line of a.quote.trim().split('\n')) out += '\n  > ' + line;
      } else if (a.scene_id) out += `镜头 ${a.scene_id}`;
      else if (a.source) out += a.label ? `${a.label}（${a.source}）` : `文件 ${a.source}`;
    }
  }
  return out;
}

/** 界面发出的最后一条消息（POST /api/sessions/{id}/turns 的请求体）。 */
export function lastTurnRequest(api: { calls: { method: string; path: string; body: unknown }[] }, id = sessionId) {
  const call = [...api.calls].reverse().find((c) => c.method === 'POST' && c.path === `/api/sessions/${id}/turns`);
  return call?.body as { message: string; attachments: Attachment[]; view: { page: string } } | undefined;
}

/**
 * 镜头页（Preview 的 scene 一页）打开时自己要读的接口：还没有分镜计划、没装整片风格、从没渲染过的 scene-001。
 * 形状照 studio/storyboard.ts、filmstyle.ts、activity.ts。
 */
export const scenePageRoutes: Record<string, unknown> = {
  '/api/storyboard': {
    gate: { id: 'gate-storyboard' },
    plan_path: 'production/scene-plan.json',
    installed_styles: [],
    scenes: [{ id: 'scene-001', dir: 'scenes/scene-001', style: { key: '', kind: 'free', cn: '' }, text: 'hello', seconds: 1, prompt: { path: 'scenes/scene-001/prompt.md', content: 'before\n' }, created: true, rendered: false }],
  } satisfies StoryboardResponse,
  '/api/film-style': { installed: false } satisfies ProjectFilmStyle,
  '/api/scenes/scene-001/activity': { scene_id: 'scene-001', rendering: false, step_count: 0, steps: [] } satisfies SceneActivity,
};

/** 等某个元素出现（waitFor 只在回调抛错时重试，querySelector 返回 null 不算）。 */
export function findEl<T extends Element = HTMLElement>(selector: string, match?: (el: T) => boolean): Promise<T> {
  return waitFor(() => {
    const el = [...document.querySelectorAll<T>(selector)].find((x) => !match || match(x));
    if (!el) throw new Error(`页面上没有 ${selector}`);
    return el;
  });
}
