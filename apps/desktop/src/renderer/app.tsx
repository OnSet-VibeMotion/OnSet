import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, forUser, post } from './api';
import { Chat, type Outbox } from './components/Chat';
import { Home, type ProjectSummary } from './components/Home';
import { Onboarding, shouldOnboard } from './components/Onboarding';
import { SkillsPill, type SkillsStatus } from './components/SkillsPill';
import { SetupGuide, useSetup } from './components/SetupGuide';
import { Settings } from './components/Settings';
import { Icon } from './components/Icon';
import { Preview, stepTabs, tabs, visibleTabs, type Tab } from './components/Preview';
import { pageView } from './components/pageViews';
import { scriptFinalPath } from './components/Script';
import { storyboardFiles } from './components/Storyboard';
import { currentSummary } from './components/Progress';
import { isStationTab, PluginMenu, setStationPages, stationPageLabel } from './components/Stations';
import type { StationsResponse } from './types';

const tabLabel = (id: Tab) => tabs.find(([t]) => t === id)?.[1] ?? stationPageLabel(id) ?? id;

/** 画幅写成比例（1080x1440 → 3:4），帧率不在顶栏里出现。 */
function canvasLabel(canvas: string): string {
  const m = /^(\d+)\s*[x×]\s*(\d+)/.exec(canvas);
  if (!m) return canvas;
  const [w, h] = [Number(m[1]), Number(m[2])];
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h) || 1;
  return `${w / g}:${h / g}`;
}

/** 有专门页面的项目文件：口播稿开口播稿页，分镜计划与处理方案开分镜页，publish.md 开发布页，不在文件页里显示原文。 */
const pageForFile = (path: string): 'script' | 'storyboard' | 'publish' | null =>
  path === scriptFinalPath ? 'script' : storyboardFiles.includes(path) ? 'storyboard' : path === 'publish.md' ? 'publish' : null;
import { ContextMenu } from './components/ContextMenu';
import { MarkdownContext } from './components/chat/Markdown';
import { setPluginVerbs } from './components/chat/model';
import { ProjectDialog } from './components/ProjectDialog';
import { Tasks } from './components/Tasks';
import { BrandMark } from './components/BrandMark';
import { canReveal, revealInFinder, revealLabel, setRevealErrorHandler } from './reveal';
import type {
  AgentChoice,
  AgentsResponse,
  Attachment,
  Project,
  ProgressState,
  ProjectState,
  ProjectUsage,
  Scene,
  SessionMeta,
  Task,
  TreeFile,
  ViewRequest,
} from './types';

const SESSION_KEY = 'am-studio-session:';
const PANEL_OPEN_KEY = 'am-studio.panel-open';
const PANEL_WIDTH_KEY = 'am-studio.panel-width:';

/** 看画面的页面面板默认宽一些，读文字的页面窄一些；宽度按这两类分别记住。 */
type PanelKind = 'media' | 'doc';
const panelKind = (tab: Tab): PanelKind => (['scene', 'compose', 'final', 'review', 'style'].includes(tab) || pageView(tab)?.media || isStationTab(tab) ? 'media' : 'doc');
const panelDefault: Record<PanelKind, number> = { media: 0.58, doc: 0.45 };
/** 对话栏最窄 420px，面板最窄 360px：拖动时两边都夹住。 */
const minChat = 420;
const minPanel = 360;

function readNumber(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return value > 0 && value < 1 ? value : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 记不住只是下次回到默认值。
  }
}

function remember(projectId: string, sessionId: string) {
  try {
    if (sessionId) localStorage.setItem(SESSION_KEY + projectId, sessionId);
    else localStorage.removeItem(SESSION_KEY + projectId);
  } catch {
    // 隐私模式下 localStorage 不可用，只是少了「记住上次的会话」。
  }
}

function recall(projectId: string): string {
  try {
    return localStorage.getItem(SESSION_KEY + projectId) ?? '';
  } catch {
    return '';
  }
}

export function App() {
  const [connected, setConnected] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [summaries, setSummaries] = useState<Record<string, ProjectSummary>>({});
  const [defaultParent, setDefaultParent] = useState('');
  const [homeAgents, setHomeAgents] = useState<AgentsResponse | null>(null);
  const [skills, setSkills] = useState<SkillsStatus | null>(null);
  // 前置资源（安装页或 am setup 准备）：缺了在顶栏提示，点开就是安装页。
  const setup = useSetup();
  const [setupOpen, setSetupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 顶栏只数要一起装的（必需项与配音、对齐工具）；节拍环境、风格来源这些按需的另算。
  const setupCore = setup.status?.items.filter((item) => !item.ready && (item.required || item.group === 'tts' || item.group === 'align')).length ?? 0;
  const setupMissing = setup.status?.items.filter((item) => !item.ready).length ?? 0;
  const setupRequiredMissing = setup.status ? !setup.status.ready : false;
  // 首页：没有打开项目时总是显示；打开项目后点左上角也能回到首页。
  const [homeOpen, setHomeOpen] = useState(false);
  const [currentId, setCurrentId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<ProjectState | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [tree, setTree] = useState<TreeFile[]>([]);
  // 制作路线：每一站做没做、现在在哪；对话顶上的一行与每轮结尾的标签也用它。
  const [route, setRoute] = useState<ProgressState | null>(null);
  // 从制作路线跳到对话里的某一轮：nonce 让同一轮能再跳一次。
  const [jump, setJump] = useState<{ turn: string; nonce: number } | null>(null);
  /**
   * 项目的流程（片型）声明：第一步是哪一页、有哪些步骤、哪些页用不上、没有镜头时落在哪一页。
   * 第三方流程的第一步页也在里面。还没读到时按口播。
   */
  const flowDecl = state?.flow;
  const flowHidden = useMemo(() => flowDecl?.hidden_pages ?? [], [flowDecl]);
  const landPage = (flowDecl?.land_page ?? '') as Tab | '';
  const steps = useMemo(() => (flowDecl?.steps ?? stepTabs) as Tab[], [flowDecl]);
  // 这个项目用得上的内置插件页面（后端页面表里有、流程没藏起来）：它们的提示条（例如卡点的节拍提示）挂在面板顶上。
  const pluginPages = useMemo(
    () => (state?.pages ?? []).map((pg) => pg.id).filter((id) => pageView(id) !== undefined && !flowHidden.includes(id)),
    [state, flowHidden],
  );
  // 整片制作现在在哪一步（编排工具每轮结束前用 studio_step 标的，没标过时按产物推），顶栏据此标出进度。
  // 第一步可能换成了第三方流程的页面：流程声明里算第一步的标记（口播稿、节拍）都落在第一步上。
  const firstSteps = flowDecl?.first_steps ?? ['script'];
  const progress = state?.step ? (firstSteps.includes(state.step) ? 0 : steps.indexOf(state.step as Tab)) : -1;
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [busy, setBusy] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tab, setTab] = useState<Tab>('scene');
  // 对话是主栏；画面面板只在有东西要看时打开（步骤、studio_show、回复里的镜头与文件）。
  const [panelOpen, setPanelOpenState] = useState(() => {
    try {
      return localStorage.getItem(PANEL_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setPanelOpen = useCallback((open: boolean | ((current: boolean) => boolean)) => {
    setPanelOpenState((current) => {
      const next = typeof open === 'function' ? open(current) : open;
      store(PANEL_OPEN_KEY, next ? '1' : '0');
      return next;
    });
  }, []);
  /** 切到某一页并打开面板：用户或编排工具要看什么时都走这里；自动切页（稿件审核、卡点）只换页不开面板。 */
  const showTab = useCallback(
    (next: Tab) => {
      setTab(next);
      setPanelOpen(true);
    },
    [setPanelOpen],
  );
  const kind = panelKind(tab);
  const [panelWidths, setPanelWidths] = useState<Record<PanelKind, number>>(() => ({
    media: readNumber(PANEL_WIDTH_KEY + 'media', panelDefault.media),
    doc: readNumber(PANEL_WIDTH_KEY + 'doc', panelDefault.doc),
  }));
  const workspace = useRef<HTMLDivElement>(null);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = workspace.current?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let latest = panelWidths[kind];
    const move = (e: PointerEvent) => {
      const width = Math.min(Math.max(box.right - e.clientX, minPanel), box.width - minChat);
      latest = Math.min(Math.max(width / box.width, 0.2), 0.8);
      setPanelWidths((current) => ({ ...current, [kind]: latest }));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      store(PANEL_WIDTH_KEY + kind, String(latest));
    };
    document.body.classList.add('resizing');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const resetWidth = () => {
    setPanelWidths((current) => ({ ...current, [kind]: panelDefault[kind] }));
    store(PANEL_WIDTH_KEY + kind, String(panelDefault[kind]));
  };
  const [sceneId, setSceneId] = useState('');
  const [filePath, setFilePath] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const [recent, setRecent] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(1);
  /** 第三方插件自己的页面，列在顶栏右侧「更多页面」的最后。 */
  const [pluginTabs, setPluginTabs] = useState<[Tab, string][]>([]);
  const [dialog, setDialog] = useState(false);
  const [toast, setToast] = useState('');
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  // 新对话还没建会话时选的工具；建了会话以后以会话记录为准。
  const [pending, setPending] = useState<AgentChoice>({ tool: '', renderer: '' });

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? '' : current)), 5000);
  }, []);
  useEffect(() => setRevealErrorHandler(notify), [notify]);

  const loadProjects = useCallback(async () => {
    try {
      const result = await api<{
        projects: Project[];
        current_project_id: string;
        summaries?: Record<string, ProjectSummary>;
        default_parent?: string;
      }>('/api/projects');
      setProjects(result.projects ?? []);
      setSummaries(result.summaries ?? {});
      setDefaultParent(result.default_parent ?? '');
      setCurrentId(result.current_project_id);
      setConnected(true);
      return result.current_project_id;
    } catch {
      setConnected(false);
      return '';
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const result = await api<{ sessions: SessionMeta[]; busy: string }>('/api/sessions');
      setSessions(result.sessions ?? []);
      setBusy(result.busy);
    } catch {
      setSessions([]);
    }
  }, []);

  const loadRoute = useCallback(async () => {
    try {
      setRoute(await api<ProgressState>('/api/progress'));
    } catch {
      // 制作路线读不到不影响别的页面。
    }
  }, []);
  const loadProject = useCallback(async () => {
    try {
      const [st, sc, tr, sts] = await Promise.all([
        api<ProjectState>('/api/state'),
        api<{ scenes: Scene[]; usage?: ProjectUsage }>('/api/scenes'),
        api<{ files: TreeFile[] }>('/api/tree'),
        // 第三方插件的页面：读不到不影响别的（插件坏了时设置页会说明）。
        api<StationsResponse>('/api/stations').catch(() => ({ stations: [], problems: [] }) as StationsResponse),
      ]);
      setStationPages(sts.stations);
      setPluginVerbs(sts.stations.flatMap((x) => x.contents?.ops ?? []));
      // 只用来嵌进别的页面的小窗不单独列。
      setPluginTabs(
        sts.stations.flatMap((x) =>
          x.pages.filter((pg) => !x.slots.some((sl) => sl.page === pg.id) || x.commands.some((c) => c.page === pg.id)).map((pg) => [pg.tab as Tab, pg.label] as [Tab, string]),
        ),
      );
      setState(st);
      setScenes(sc.scenes ?? []);
      setUsage(sc.usage ?? null);
      setTree(tr.files ?? []);
      setVersion((v) => v + 1);
    } catch (err) {
      notify(errorText(err));
    }
    await loadRoute();
    await loadSessions();
  }, [loadSessions, loadRoute, notify]);

  // 项目被占用（对话或渲染任务在跑）时定时刷新镜头列表，对话顶部的进度靠它看到出片与渲染中的镜头。
  useEffect(() => {
    if (!busy || !currentId) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api<{ scenes: Scene[]; usage?: ProjectUsage }>('/api/scenes');
        setScenes(result.scenes ?? []);
        setUsage(result.usage ?? null);
      } catch {
        // 刷新失败不打扰用户，下一次再试。
      }
    }, 8000);
    return () => window.clearInterval(timer);
  }, [busy, currentId]);

  const loadTasks = useCallback(async () => {
    try {
      const result = await api<{ tasks: Task[] }>('/api/tasks');
      setTasks((result.tasks ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at)));
    } catch {
      // 任务列表拿不到不影响其他功能。
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    api<AgentsResponse>('/api/agents').then(setHomeAgents, () => setHomeAgents(null));
  }, []);

  // 首次使用引导：还没有项目、又确实缺东西（工具没装好，或者没有一家编排工具能用）时自动打开一次；
  // 都齐了就直接是首页。首页左栏「新手引导」随时能再打开。
  const [guideOpen, setGuideOpen] = useState(false);
  const guideChecked = useRef(false);
  useEffect(() => {
    if (guideChecked.current || !loaded || !setup.status || !homeAgents) return;
    guideChecked.current = true;
    const missing = !setup.status.ready || !homeAgents.agents.some((a) => a.installed);
    if (missing && shouldOnboard(projects.length)) setGuideOpen(true);
  }, [loaded, setup.status, homeAgents, projects.length]);

  // HyperFrames 官方技能：在 Studio 里新建的项目在后台装，装好之前或装失败时提示。
  const loadSkills = useCallback(async () => {
    try {
      const result = await api<{ status?: SkillsStatus }>('/api/skills');
      setSkills(result.status ?? null);
      return result.status;
    } catch {
      setSkills(null);
      return undefined;
    }
  }, []);
  useEffect(() => {
    setSkills(null);
    if (!currentId) return;
    let timer = 0;
    const poll = async () => {
      const status = await loadSkills();
      if (status?.installing) timer = window.setTimeout(poll, 1000);
    };
    void poll();
    return () => window.clearTimeout(timer);
  }, [currentId]);
  const installSkills = async () => {
    try {
      setSkills(await post('/api/skills/install'));
      const poll = async () => {
        const status = await loadSkills();
        if (status?.installing) window.setTimeout(poll, 1000);
      };
      window.setTimeout(poll, 1000);
    } catch (err) {
      notify(errorText(err));
    }
  };

  // 切换项目：清掉上一个项目的选择，恢复这个项目上次打开的会话。
  useEffect(() => {
    setState(null);
    setScenes([]);
    setUsage(null);
    setTree([]);
    setSceneId('');
    setFilePath('');
    setAttachments([]);
    setRecent(new Set());
    setSessionId(currentId ? recall(currentId) : '');
    setAgents(null);
    if (currentId) {
      void loadProject();
      void loadTasks();
      api<AgentsResponse>('/api/agents').then(
        (result) => {
          setAgents(result);
          setPending({ tool: result.orchestrator, renderer: result.renderer });
        },
        () => setAgents(null),
      );
    }
  }, [currentId]);

  useEffect(() => {
    if (!sceneId && scenes.length) setSceneId(scenes[0].id);
  }, [scenes]);

  // 任务在跑时每两秒查一次，结束时刷新项目；空闲时十秒一次，顺带探测连接。
  const activeTasks = tasks.some((t) => t.status === 'queued' || t.status === 'running');
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !activeTasks) void loadProject();
    wasActive.current = activeTasks;
    if (!currentId) return;
    const timer = window.setInterval(
      () => {
        void loadTasks();
        if (!activeTasks) void loadSessions();
      },
      activeTasks ? 2000 : 10000,
    );
    return () => window.clearInterval(timer);
  }, [activeTasks, currentId]);

  // 一轮进行中文件会陆续变化；合并成每秒最多刷新一次。
  const pendingRefresh = useRef(0);
  const onFilesChanged = useCallback(
    (files: string[]) => {
      setRecent((current) => new Set([...current, ...files]));
      if (pendingRefresh.current) return;
      pendingRefresh.current = window.setTimeout(() => {
        pendingRefresh.current = 0;
        void loadProject();
      }, 1000);
    },
    [loadProject],
  );

  const session = sessions.find((s) => s.session_id === sessionId);
  const choice: AgentChoice = session
    ? { tool: session.tool, renderer: session.renderer || agents?.renderer || '', model: session.model ?? '', renderer_model: session.renderer_model ?? '' }
    : pending;

  const changeChoice = async (next: AgentChoice) => {
    if (!session) {
      setPending(next);
      return;
    }
    try {
      await post(`/api/sessions/${session.session_id}/agents`, next);
      await loadSessions();
    } catch (err) {
      notify(errorText(err));
    }
  };

  // 渲染按钮用当前会话（或新对话）选的渲染工具。
  const renderer = choice.renderer;
  const rendererModel = choice.renderer_model ?? '';
  const run = useCallback(
    async (path: string, payload: Record<string, unknown> = {}) => {
      try {
        await post(path, /\/render(\/all)?$/.test(path) ? { ...payload, renderer, renderer_model: rendererModel } : payload);
        notify('已开始，进度见右上角任务。');
        await loadTasks();
        await loadSessions();
      } catch (err) {
        notify(errorText(err));
      }
    },
    [loadTasks, loadSessions, notify, renderer, rendererModel],
  );

  const chooseSession = (id: string) => {
    setSessionId(id);
    remember(currentId, id);
  };
  const jumpToTurn = (session: string, turn: string) => {
    if (session && session !== sessionId) chooseSession(session);
    setJump({ turn, nonce: Date.now() });
    // 窄窗口里面板是盖在对话上的抽屉，收起来才看得到对话。
    if (window.innerWidth < 1180) setPanelOpen(false);
  };
  const now = currentSummary(route);

  const project = projects.find((p) => p.id === currentId);

  // 附到对话：截图、圈选、右键引用都走这里；同一段引用、同一个镜头或文件不重复加。
  const addAttachment = (attachment: Attachment) => {
    const same = (a: Attachment) =>
      (attachment.quote && a.quote === attachment.quote && a.source === attachment.source) ||
      (attachment.ref && a.ref && a.scene_id === attachment.scene_id && a.source === attachment.source);
    if (attachments.some(same)) {
      notify('已经在对话的引用里了。');
      return;
    }
    setAttachments((current) => [...current, attachment]);
    notify(attachment.quote || attachment.ref ? '已加进对话的引用，说说要怎么改。' : '已附到对话，发送消息时一起带上。');
  };
  const quick = (text: string, quickAttachments: Attachment[], draftOnly?: boolean) => {
    setOutbox({ text, attachments: quickAttachments, nonce: Date.now(), draftOnly });
    // 确认关卡的按钮先记下确认再发话：路线上的那一站马上变成「你确认了」。
    if (!draftOnly) void loadRoute();
    if (!draftOnly) notify('已发给 AI，进度看对话。');
  };

  // Markdown 里写到的项目文件可点：口播稿开口播稿页，其余开文件页。
  const treePaths = useMemo(() => tree.map((f) => f.path), [tree]);
  const markdownLinks = useMemo(
    () => ({
      files: treePaths,
      onOpenFile: (path: string) => {
        const page = pageForFile(path);
        if (page) {
          showTab(page);
          return;
        }
        setFilePath(path);
        showTab('file');
      },
    }),
    [treePaths, showTab],
  );

  // 编排工具经 am studio show 请用户看某一页：切过去，镜头与文件页带上对象。
  const openView = (view: ViewRequest) => {
    // 标了制作步骤：重新读项目状态，顶栏的进度跟着变。只标步骤的请求不切页。
    if (view.step) void loadProject();
    if (isStationTab(view.page)) {
      // 插件页面：这个项目加了它才切过去。
      if (pluginTabs.some(([id]) => id === view.page)) showTab(view.page as Tab);
      return;
    }
    const page = tabs.find(([id]) => id === view.page)?.[0];
    if (!page) return;
    if (page === 'file') {
      if (!view.target) return;
      const special = pageForFile(view.target);
      if (special) {
        showTab(special);
        return;
      }
      setFilePath(view.target);
    }
    if ((page === 'scene' || page === 'compose') && view.target) setSceneId(view.target);
    showTab(page);
  };

  // 口播稿：有了终稿却还没有镜头时（稿件审核阶段）自动切到口播稿页；稿子改过而没看过时标签打点。
  const scriptMtime = tree.find((f) => f.path === scriptFinalPath)?.mtime ?? 0;
  const seenKey = `am-studio.script-seen:${project?.path ?? ''}`;
  const [scriptSeen, setScriptSeen] = useState(0);
  useEffect(() => {
    try {
      setScriptSeen(Number(window.localStorage.getItem(seenKey) ?? 0) || 0);
    } catch {
      setScriptSeen(0);
    }
  }, [seenKey]);
  // 流程声明了落脚页（卡点是节拍页）：用不上的页换成它；还没有镜头时（节拍、分镜阶段）打开项目先到它。
  const autoLand = useRef('');
  useEffect(() => {
    if (!landPage) return;
    if (flowHidden.includes(tab)) setTab(landPage);
    else if (tab === 'scene' && scenes.length === 0 && autoLand.current !== seenKey) {
      autoLand.current = seenKey;
      setTab(landPage);
    }
  }, [landPage, flowHidden, tab, scenes.length, seenKey]);
  const autoScript = useRef('');
  useEffect(() => {
    if (!scriptMtime || scenes.length > 0 || tab !== 'scene' || autoScript.current === seenKey) return;
    autoScript.current = seenKey;
    setTab('script');
  }, [scriptMtime, scenes.length, seenKey]);
  useEffect(() => {
    if (tab !== 'script' || !scriptMtime || scriptMtime <= scriptSeen) return;
    setScriptSeen(scriptMtime);
    try {
      window.localStorage.setItem(seenKey, String(scriptMtime));
    } catch {
      // 记不住只是下次还会打点。
    }
  }, [tab, scriptMtime, scriptSeen, seenKey]);

  // 分镜：有了分镜计划、镜头一个都还没渲染、分镜又有没看过的改动时（分镜审核阶段）自动切到分镜页；
  // 分镜或画面描述改过而没看过时标签打点。
  const storyboardMtime = tree.reduce(
    (latest, f) => (storyboardFiles.includes(f.path) || /^scenes\/[^/]+\/prompt\.md$/.test(f.path) ? Math.max(latest, f.mtime ?? 0) : latest),
    0,
  );
  const boardSeenKey = `am-studio.storyboard-seen:${project?.path ?? ''}`;
  const [boardSeen, setBoardSeen] = useState(0);
  useEffect(() => {
    try {
      setBoardSeen(Number(window.localStorage.getItem(boardSeenKey) ?? 0) || 0);
    } catch {
      setBoardSeen(0);
    }
  }, [boardSeenKey]);
  const hasPlan = tree.some((f) => f.path === storyboardFiles[0]);
  const unrendered = hasPlan && scenes.length > 0 && scenes.every((s) => !s.exists && !s.rendering);
  const autoBoard = useRef('');
  useEffect(() => {
    if (!unrendered || storyboardMtime <= boardSeen || tab !== 'scene' || autoBoard.current === boardSeenKey) return;
    autoBoard.current = boardSeenKey;
    setTab('storyboard');
  }, [unrendered, storyboardMtime, boardSeen, tab, boardSeenKey]);
  useEffect(() => {
    if (tab !== 'storyboard' || !storyboardMtime || storyboardMtime <= boardSeen) return;
    setBoardSeen(storyboardMtime);
    try {
      window.localStorage.setItem(boardSeenKey, String(storyboardMtime));
    } catch {
      // 记不住只是下次还会打点。
    }
  }, [tab, storyboardMtime, boardSeen, boardSeenKey]);

  // Dock 角标与完成通知（客户端里才有）：一轮对话、一次渲染要跑很久，人多半去做别的事了。
  const taskStatus = useRef(new Map<string, Task['status']>());
  useEffect(() => {
    const active = tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;
    window.am?.setBadge?.(active);
    for (const task of tasks) {
      const before = taskStatus.current.get(task.task_id);
      if ((before === 'running' || before === 'queued') && (task.status === 'succeeded' || task.status === 'failed')) {
        window.am?.notify?.(task.status === 'succeeded' ? '任务完成' : '任务失败', forUser(task.message || task.error || task.type));
      }
      taskStatus.current.set(task.task_id, task.status);
    }
  }, [tasks]);

  // 原生菜单（客户端里才有）：新建回首页，打开文件夹走与「打开项目」同一个接口，⌘1–⌘5 切五个步骤。
  useEffect(() => {
    return window.am?.onMenu?.((action) => {
      if (action.type === 'new' || action.type === 'home') setHomeOpen(true);
      else if (action.type === 'settings') setSettingsOpen(true);
      else if (action.type === 'step') {
        const id = steps[action.index];
        if (id && currentId) {
          setHomeOpen(false);
          showTab(id);
        }
      } else if (action.type === 'panel') {
        if (currentId) setPanelOpen((open) => !open);
      } else if (action.type === 'reveal') {
        if (currentId) revealInFinder('');
      } else if (action.type === 'open') {
        void (async () => {
          try {
            await post('/api/projects/open', { path: action.path });
            await loadProjects();
            setHomeOpen(false);
          } catch (err) {
            notify(errorText(err));
          }
        })();
      }
    });
  }, [currentId, loadProjects, steps, showTab, setPanelOpen]);

  // Esc 收起面板；圈选、菜单、弹窗开着时 Esc 归它们，输入框里的 Esc 也不管。
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.selection-bar, [role="menu"], [role="dialog"], .modal-backdrop')) return;
      setPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelOpen, setPanelOpen]);

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" title="回到首页" aria-label="回到首页" onClick={() => setHomeOpen(true)}>
          <span className="brand-mark" aria-hidden="true">
            <BrandMark />
          </span>
        </button>
        <button className="project-switch" id="open-project-trigger" title={project ? `${project.path}\n切换项目` : '选择项目'} onClick={() => setDialog(true)}>
          <strong id="title" className="ellipsis">
            {project?.name ?? '选择项目'}
          </strong>
          {state?.metadata.canvas && <span className="project-meta">{canvasLabel(state.metadata.canvas)}</span>}
        </button>
        {canReveal && currentId && !homeOpen && (
          <button className="ghost icon reveal-project" id="reveal-project" title={`${revealLabel}（⌥⌘R）`} aria-label={`在 Finder 中打开项目文件夹`} onClick={() => revealInFinder('')}>
            <Icon name="folder" size={13} />
          </button>
        )}
        {currentId && !homeOpen && (
          <button
            className={'route-button' + (tab === 'progress' && panelOpen ? ' on' : '') + (route?.waiting_on === 'user' || now.station?.status === 'changed' ? ' waiting' : '')}
            id="progress-open"
            data-tab="progress"
            aria-current={tab === 'progress' && panelOpen ? 'page' : undefined}
            title={now.station ? `制作路线：现在在「${now.station.label}」，${now.text}` : '制作路线'}
            onClick={() => showTab('progress')}
          >
            <Icon name="route" size={13} />
            路线
          </button>
        )}
        {currentId && !homeOpen && (
          <nav className="steps" aria-label="制作步骤">
            {steps.map((id, index) => (
              <button
                key={id}
                data-tab={id}
                className={'step' + (tab === id && panelOpen ? ' on' : '') + (index < progress ? ' done' : index === progress ? ' current' : '')}
                aria-current={tab === id && panelOpen ? 'page' : index === progress ? 'step' : undefined}
                title={index === progress ? (state?.step_marked ? 'AI 标记：现在在这一步' : '现在在这一步') : index < progress ? '已经做过' : undefined}
                onClick={() => showTab(id)}
              >
                <span className="step-no">{index < progress ? '✓' : String(index + 1).padStart(2, '0')}</span>
                {tabLabel(id)}
                {id === 'scene' && state && state.scenes.total > 0 && (
                  <span className={'step-count' + (state.scenes.stale > 0 ? ' warn' : '')} title={state.scenes.stale > 0 ? `${state.scenes.stale} 个镜头过期` : '已出片 / 全部镜头'}>
                    {state.scenes.completed}/{state.scenes.total}
                  </span>
                )}
                {id === 'script' && scriptMtime > scriptSeen && tab !== 'script' && <i className="tab-dot" aria-label="有更新" />}
                {id === 'storyboard' && storyboardMtime > boardSeen && tab !== 'storyboard' && <i className="tab-dot" aria-label="有更新" />}
              </button>
            ))}
          </nav>
        )}
        <span className="spacer" />
        {currentId && !homeOpen && (
          <nav className="more-pages" aria-label="更多页面">
            {visibleTabs(flowHidden, state?.pages)
              .filter(([id]) => !steps.includes(id))
              .map(([id, label]) => (
                <button key={id} data-tab={id} className={tab === id && panelOpen ? 'on' : ''} aria-current={tab === id && panelOpen ? 'page' : undefined} onClick={() => showTab(id)}>
                  {label}
                </button>
              ))}
          </nav>
        )}
        {currentId && !homeOpen && <PluginMenu tabs={pluginTabs} current={panelOpen ? tab : ''} onPick={showTab} />}
        {setupMissing > 0 && (
          <button className={'skills-pill' + (setupRequiredMissing ? ' bad' : '')} id="setup-pill" onClick={() => setSetupOpen(true)} title="渲染与配音要用的工具：点开一键安装">
            {setupCore > 0 ? `还差 ${setupCore} 项工具 · 去安装` : `可按需安装 ${setupMissing} 项`}
          </button>
        )}
        {currentId && !homeOpen && !setupRequiredMissing && skills && !skills.installed && <SkillsPill status={skills} onInstall={installSkills} />}
        {busy && (
          <span className="pill busy" title="同一时间只有一个写入者">
            <span className="dot busy" />
            {busy}
          </span>
        )}
        {currentId && !homeOpen && (
          <button
            className={'panel-toggle' + (panelOpen ? ' on' : '')}
            id="panel-toggle"
            aria-pressed={panelOpen}
            title={panelOpen ? '收起画面（⌘\\）' : '显示画面（⌘\\）'}
            onClick={() => setPanelOpen(!panelOpen)}
          >
            <Icon name="panel" size={13} />
            画面
          </button>
        )}
        <Tasks tasks={tasks} onCancel={(id) => run(`/api/tasks/${id}/cancel`)} />
        <button className="ghost icon settings-trigger" id="settings-trigger" title="设置（⌘,）" aria-label="设置" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" size={14} />
        </button>
        <span className={'pill conn' + (connected ? '' : ' down')} title={connected ? '已连接' : '连接断开'} aria-label={connected ? '已连接' : '连接断开'}>
          <span className={'dot ' + (connected ? 'ok' : 'bad')} />
          {!connected && <span>连接断开</span>}
        </span>
      </header>

      {loaded && (!currentId || homeOpen) && guideOpen ? (
        <Onboarding
          setup={setup}
          projectCount={projects.length}
          onClose={() => {
            setGuideOpen(false);
            // 引导里可能填了 key、换了编排工具：首页的工具菜单要按新的显示。
            api<AgentsResponse>('/api/agents').then(setHomeAgents, () => {});
          }}
        />
      ) : loaded && (!currentId || homeOpen) ? (
        <Home
          projects={projects}
          summaries={summaries}
          defaultParent={defaultParent}
          currentId={currentId}
          agents={homeAgents}
          onOpen={async (id) => {
            try {
              await post('/api/workspaces/switch', { project_id: id });
              await loadProjects();
              setHomeOpen(false);
            } catch (err) {
              notify(errorText(err));
            }
          }}
          onRemove={async (id) => {
            try {
              await post('/api/projects/recent/remove', { project_id: id });
              await loadProjects();
            } catch (err) {
              notify(errorText(err));
            }
          }}
          onBrowse={() => setDialog(true)}
          onStarted={async (projectId, startedSession) => {
            remember(projectId, startedSession);
            await loadProjects();
            setHomeOpen(false);
          }}
          onBack={currentId ? () => setHomeOpen(false) : undefined}
          onGuide={() => setGuideOpen(true)}
        />
      ) : (
        <MarkdownContext.Provider value={markdownLinks}>
          <div className={'workspace' + (panelOpen ? ' panel-open' : '')} ref={workspace} style={{ '--panel-w': `${panelWidths[kind] * 100}%` } as CSSProperties}>
            <ContextMenu
              onAttach={addAttachment}
              onQuick={quick}
              onScene={(id) => {
                setSceneId(id);
                showTab('scene');
              }}
              onFile={(path) => {
                const page = pageForFile(path);
                if (page) {
                  showTab(page);
                  return;
                }
                setFilePath(path);
                showTab('file');
              }}
              onReveal={
                canReveal
                  ? (target) => {
                      const sc = target.scene ? scenes.find((s) => s.id === target.scene) : undefined;
                      if (target.scene && !sc) return;
                      revealInFinder(sc ? (sc.exists && sc.output ? sc.directory + '/' + sc.output : sc.directory) : (target.file ?? ''));
                    }
                  : undefined
              }
            />
            <Chat
              projectPath={project?.path ?? ''}
              agents={agents}
              choice={choice}
              onChoice={changeChoice}
              sessions={sessions}
              sessionId={sessionId}
              busy={busy}
              attachments={attachments}
              onSession={chooseSession}
              onSessionsChanged={loadSessions}
              onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, i) => i !== index))}
              onClearAttachments={() => setAttachments([])}
              onFilesChanged={onFilesChanged}
              onTurnEnd={() => {
                void loadProject();
                window.am?.notify?.('这一轮做完了', project?.name ?? 'ArticleToMotion');
              }}
              onOpenFile={(path) => {
                const page = pageForFile(path);
                if (page) {
                  showTab(page);
                  return;
                }
                setFilePath(path);
                showTab('file');
              }}
              onAddAttachments={(list) => setAttachments((current) => [...current, ...list])}
              scenes={scenes}
              outbox={outbox}
              view={{ page: panelOpen ? tab : '', scene: sceneId || undefined, file: tab === 'file' ? filePath : undefined }}
              tree={tree}
              run={run}
              onView={openView}
              progress={route}
              jump={jump}
              onProgress={() => showTab('progress')}
            />
            {panelOpen ? (
              <>
                <div className="panel-scrim" aria-hidden="true" onClick={() => setPanelOpen(false)} />
                <div
                  className="panel-resize"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="拖动调整画面宽度，双击恢复默认"
                  title="拖动调整宽度，双击恢复默认"
                  onPointerDown={startResize}
                  onDoubleClick={resetWidth}
                />
                <section className="panel" id="panel" aria-label="画面">
                  <header className="panel-head">
                    <span className="panel-title">
                      {tabLabel(tab)}
                      {(tab === 'scene' || tab === 'compose') && sceneId && <span className="panel-sub">{sceneId}</span>}
                      {tab === 'file' && filePath && <span className="panel-sub ellipsis">{filePath}</span>}
                    </span>
                    <span className="spacer" />
                    <button className="ghost icon" id="panel-close" aria-label="收起画面" title="收起画面（Esc）" onClick={() => setPanelOpen(false)}>
                      <Icon name="close" />
                    </button>
                  </header>
                  <Preview
                    tab={tab}
                    onTab={setTab}
                    state={state}
                    scenes={scenes}
                    usage={usage}
                    sceneId={sceneId}
                    filePath={filePath}
                    tree={tree}
                    recent={recent}
                    version={version}
                    pages={pluginPages}
                    progress={route}
                    busy={busy}
                    onAttach={addAttachment}
                    onQuick={quick}
                    onFile={(path) => {
                      setFilePath(path);
                      setTab('file');
                    }}
                    onScene={(id) => {
                      setSceneId(id);
                      if (tab !== 'scene' && tab !== 'compose' && tab !== 'memory') setTab('scene');
                    }}
                    onTurn={jumpToTurn}
                    run={run}
                  />
                </section>
              </>
            ) : (
              <PanelRail scenes={scenes} sceneId={sceneId} onOpen={() => setPanelOpen(true)} onScene={(id) => {
                setSceneId(id);
                showTab('scene');
              }} />
            )}
          </div>
        </MarkdownContext.Provider>
      )}

      {setupOpen && setup.status && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setSetupOpen(false)}>
          <section className="modal" role="dialog" aria-label="前置资源" id="setup-dialog">
            <header className="modal-head">
              <h2>前置资源</h2>
              <span className="spacer" />
              <button className="ghost icon" onClick={() => setSetupOpen(false)} aria-label="关闭">
                <Icon name="close" />
              </button>
            </header>
            <div className="pad">
              <SetupGuide setup={setup} compact />
            </div>
          </section>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
          <section className="modal" role="dialog" aria-label="设置" id="settings-dialog">
            <header className="modal-head">
              <h2>设置</h2>
              <span className="spacer" />
              <button className="ghost icon" onClick={() => setSettingsOpen(false)} aria-label="关闭">
                <Icon name="close" />
              </button>
            </header>
            <div className="pad">
              <Settings version={version} run={run} />
            </div>
          </section>
        </div>
      )}
      {dialog && (
        <ProjectDialog
          projects={projects}
          currentId={currentId}
          onClose={() => setDialog(false)}
          onOpened={async () => {
            setDialog(false);
            setHomeOpen(false);
            await loadProjects();
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

/** 面板收起时右边的一条细栏：每个镜头一个小方块（已出片、过期、渲染中、未出片），点开回到画面。 */
function PanelRail(props: { scenes: Scene[]; sceneId: string; onOpen: () => void; onScene: (id: string) => void }) {
  const done = props.scenes.filter((s) => s.exists && !s.stale).length;
  return (
    <aside className="panel-rail" aria-label="画面（已收起）">
      <button className="ghost icon rail-open" id="panel-open" aria-label="显示画面" title="显示画面（⌘\\）" onClick={props.onOpen}>
        <Icon name="prev" />
      </button>
      {props.scenes.length > 0 && (
        <>
          <div className="rail-scenes">
            {props.scenes.map((scene) => {
              const status = scene.rendering ? 'rendering' : !scene.exists ? 'todo' : scene.stale ? 'stale' : 'ok';
              return (
                <button
                  key={scene.id}
                  className={'rail-scene ' + status + (scene.id === props.sceneId ? ' on' : '')}
                  aria-label={`镜头 ${scene.id}`}
                  title={scene.id}
                  onClick={() => props.onScene(scene.id)}
                />
              );
            })}
          </div>
          <span className="rail-count">
            {done}/{props.scenes.length}
          </span>
        </>
      )}
    </aside>
  );
}
