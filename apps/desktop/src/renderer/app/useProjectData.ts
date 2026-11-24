import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, post } from '../api';
import { setPluginVerbs } from '../components/chat/model';
import type { ProjectSummary } from '../components/Home';
import type { Tab } from '../components/Preview';
import { setStationPages } from '../components/Stations';
import type {
  AgentChoice,
  AgentsResponse,
  Attachment,
  ProgressState,
  Project,
  ProjectState,
  ProjectUsage,
  Scene,
  SessionMeta,
  StationsResponse,
  TreeFile,
} from '../types';
import { recall, remember } from './helpers';

export function useProjectData(opts: { notify: (message: string) => void }) {
  const { notify } = opts;
  const [connected, setConnected] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [summaries, setSummaries] = useState<Record<string, ProjectSummary>>({});
  const [defaultParent, setDefaultParent] = useState('');
  const [homeAgents, setHomeAgents] = useState<AgentsResponse | null>(null);
  const [currentId, setCurrentId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<ProjectState | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [tree, setTree] = useState<TreeFile[]>([]);
  // 制作路线：每一站做没做、现在在哪；对话顶上的一行与每轮结尾的标签也用它。
  const [route, setRoute] = useState<ProgressState | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [busy, setBusy] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [sceneId, setSceneId] = useState('');
  const [filePath, setFilePath] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [recent, setRecent] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(1);
  // 装、去掉插件后首页重读做法（插件可能带来新的做法）。
  const [pluginsVersion, setPluginsVersion] = useState(0);
  /** 第三方插件自己的页面，列在顶栏右侧「更多页面」的最后。 */
  const [pluginTabs, setPluginTabs] = useState<[Tab, string][]>([]);
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  // 新对话还没建会话时选的工具；建了会话以后以会话记录为准。
  const [pending, setPending] = useState<AgentChoice>({ tool: '', renderer: '' });

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
      // 只用来嵌进别的页面的小窗、被皮肤拿去当桌宠的页面不单独列。
      setPluginTabs(
        sts.stations.flatMap((x) =>
          x.pages
            .filter((pg) => !pg.pet)
            .filter((pg) => !x.slots.some((sl) => sl.page === pg.id) || x.commands.some((c) => c.page === pg.id))
            .map((pg) => [pg.tab as Tab, pg.label] as [Tab, string]),
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

  // 项目被占用（对话或渲染任务在跑）、或者还有镜头在渲染时定时刷新镜头列表：对话顶部的进度与桌宠的摄影
  // 靠它看到出片与渲染中的镜头。一轮结束后渲染还在跑的话，不接着刷就一直停在「渲染中」。
  const anyRendering = scenes.some((scene) => scene.rendering);
  useEffect(() => {
    if ((!busy && !anyRendering) || !currentId) return;
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
  }, [busy, anyRendering, currentId]);

  useEffect(() => {
    void loadProjects();
    void api<AgentsResponse>('/api/agents').then(setHomeAgents, () => setHomeAgents(null));
  }, []);

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
      void api<AgentsResponse>('/api/agents').then(
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
    ? {
        tool: session.tool,
        renderer: session.renderer || agents?.renderer || '',
        model: session.model ?? '',
        renderer_model: session.renderer_model ?? '',
        options: session.options ?? '',
        renderer_options: session.renderer_options ?? '',
      }
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

  const chooseSession = (id: string) => {
    setSessionId(id);
    remember(currentId, id);
  };

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
    notify(
      attachment.quote || attachment.ref ? '已加进对话的引用，说说要怎么改。' : '已附到对话，发送消息时一起带上。',
    );
  };

  return {
    connected,
    projects,
    summaries,
    defaultParent,
    homeAgents,
    setHomeAgents,
    currentId,
    loaded,
    state,
    scenes,
    usage,
    tree,
    route,
    sessions,
    busy,
    sessionId,
    sceneId,
    setSceneId,
    filePath,
    setFilePath,
    attachments,
    setAttachments,
    recent,
    version,
    pluginsVersion,
    setPluginsVersion,
    pluginTabs,
    agents,
    setAgents,
    project,
    choice,
    loadProjects,
    loadSessions,
    loadRoute,
    loadProject,
    onFilesChanged,
    changeChoice,
    chooseSession,
    addAttachment,
  };
}
