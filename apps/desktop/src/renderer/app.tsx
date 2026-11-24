import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, post } from './api';
import { AppModals } from './app/AppModals';
import { remember } from './app/helpers';
import { Topbar } from './app/Topbar';
import { useAppNavigation } from './app/useAppNavigation';
import { useAppTasks } from './app/useAppTasks';
import { useAutoTabs } from './app/useAutoTabs';
import { usePanelLayout } from './app/usePanelLayout';
import { useProjectData } from './app/useProjectData';
import { WorkspaceView } from './app/WorkspaceView';
import { rendererState } from './components/agentReady';
import type { Outbox } from './components/Chat';
import { Home } from './components/Home';
import { Onboarding, shouldOnboard } from './components/Onboarding';
import { stepTabs, type Tab } from './components/Preview';
import { currentSummary } from './components/Progress';
import { pageView } from './components/pageViews';
import { useSetup } from './components/SetupGuide';
import { SeriesAssetsPanel } from './components/series/SeriesAssetsPanel';
import { updateNeedsAttention, useUpdateState } from './components/Updates';
import { setRevealErrorHandler } from './reveal';
import type { AgentsResponse, Attachment } from './types';

export function App() {
  // 客户端有新版本或已经下好：齿轮上点一个小点（设置页「网络与更新」里装）。
  const updateDot = updateNeedsAttention(useUpdateState());
  // 前置资源（安装页或 onset setup 准备）：缺了在顶栏提示，点开就是安装页。
  const setup = useSetup();
  const [setupOpen, setSetupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [seriesPanelOpen, setSeriesPanelOpen] = useState(false);
  // 顶栏只数要一起装的（必需项与配音、对齐工具）；节拍环境、风格来源这些按需的另算。
  const setupCore =
    setup.status?.items.filter(
      (item) => !item.ready && (item.required || item.group === 'tts' || item.group === 'align'),
    ).length ?? 0;
  const setupMissing = setup.status?.items.filter((item) => !item.ready).length ?? 0;
  const setupRequiredMissing = setup.status ? !setup.status.ready : false;
  // 首页：没有打开项目时总是显示；打开项目后点左上角也能回到首页。
  const [homeOpen, setHomeOpen] = useState(false);
  // 从制作路线跳到对话里的某一轮：nonce 让同一轮能再跳一次。
  const [jump, setJump] = useState<{ turn: string; nonce: number } | null>(null);
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const [dialog, setDialog] = useState(false);
  const [toast, setToast] = useState('');

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? '' : current)), 5000);
  }, []);
  useEffect(() => setRevealErrorHandler(notify), [notify]);

  const layout = usePanelLayout();
  const data = useProjectData({ notify });
  const { currentId, state, scenes, tree, route, loadProjects, loadProject, loadRoute, loadSessions } = data;
  const { tab, setTab, panelOpen, setPanelOpen, showTab } = layout;

  // 渲染按钮用当前会话（或新对话）选的渲染工具。
  const appTasks = useAppTasks({
    currentId,
    tab,
    panelOpen,
    renderer: data.choice.renderer,
    rendererModel: data.choice.renderer_model ?? '',
    rendererOptions: data.choice.renderer_options ?? '',
    notify,
    loadProject,
    loadSessions,
  });

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
    () =>
      (state?.pages ?? []).map((pg) => pg.id).filter((id) => pageView(id) !== undefined && !flowHidden.includes(id)),
    [state, flowHidden],
  );
  // 整片制作现在在哪一步（编排工具每轮结束前用 studio_step 标的，没标过时按产物推），顶栏据此标出进度。
  // 第一步可能换成了第三方流程的页面：流程声明里算第一步的标记（口播稿、节拍）都落在第一步上。
  const firstSteps = flowDecl?.first_steps ?? ['script'];
  const progress = state?.step ? (firstSteps.includes(state.step) ? 0 : steps.indexOf(state.step as Tab)) : -1;

  // 首次使用引导：还没有项目、又确实缺东西（工具没装好，或者没有一家编排工具能用）时自动打开一次；
  // 都齐了就直接是首页。首页左栏「新手引导」随时能再打开。
  const [guideOpen, setGuideOpen] = useState(false);
  const guideChecked = useRef(false);
  useEffect(() => {
    if (guideChecked.current || !data.loaded || !setup.status || !data.homeAgents) return;
    guideChecked.current = true;
    const missing =
      !setup.status.ready ||
      !data.homeAgents.agents.some((a) => a.installed) ||
      !rendererState(data.homeAgents, data.homeAgents.global_renderer).ok;
    if (missing && shouldOnboard(data.projects.length)) setGuideOpen(true);
  }, [data.loaded, setup.status, data.homeAgents, data.projects.length]);

  const now = currentSummary(route);

  const quick = (text: string, quickAttachments: Attachment[], draftOnly?: boolean, appendDraft?: boolean) => {
    setOutbox({ text, attachments: quickAttachments, nonce: Date.now(), draftOnly, appendDraft });
    // 确认关卡的按钮先记下确认再发话：路线上的那一站马上变成「你确认了」。
    if (!draftOnly) void loadRoute();
    if (!draftOnly) notify('已发给 AI，进度看对话。');
  };

  const { jumpToTurn, markdownLinks, openView } = useAppNavigation({
    currentId,
    steps,
    tree,
    pluginTabs: data.pluginTabs,
    sessionId: data.sessionId,
    chooseSession: data.chooseSession,
    setJump,
    setHomeOpen,
    setSettingsOpen,
    setPanelOpen,
    setFilePath: data.setFilePath,
    setSceneId: data.setSceneId,
    showTab,
    loadProject,
    loadProjects,
    notify,
  });

  const { scriptMtime, scriptSeen, storyboardMtime, boardSeen } = useAutoTabs({
    projectPath: data.project?.path ?? '',
    tree,
    scenes,
    tab,
    setTab,
    landPage,
    flowHidden,
  });

  return (
    <div className="app">
      <Topbar
        project={data.project}
        state={state}
        currentId={currentId}
        homeOpen={homeOpen}
        tab={tab}
        panelOpen={panelOpen}
        route={route}
        now={now}
        steps={steps}
        progress={progress}
        flowHidden={flowHidden}
        pluginTabs={data.pluginTabs}
        scriptMtime={scriptMtime}
        scriptSeen={scriptSeen}
        storyboardMtime={storyboardMtime}
        boardSeen={boardSeen}
        setupMissing={setupMissing}
        setupCore={setupCore}
        setupRequiredMissing={setupRequiredMissing}
        skills={appTasks.skills}
        busy={data.busy}
        tasks={appTasks.tasks}
        updateDot={updateDot}
        connected={data.connected}
        onHome={() => setHomeOpen(true)}
        onOpenDialog={() => setDialog(true)}
        onShowTab={showTab}
        onOpenSetup={() => setSetupOpen(true)}
        onInstallSkills={() => void appTasks.installSkills()}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
        onCancelTask={(id) => void appTasks.run(`/api/tasks/${id}/cancel`)}
        onOpenSeries={() => setSeriesPanelOpen(true)}
        onOpenMemory={() => {
          setPanelOpen(true);
          setTab('memory');
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {data.loaded && (!currentId || homeOpen) && guideOpen ? (
        <Onboarding
          setup={setup}
          projectCount={data.projects.length}
          onClose={() => {
            setGuideOpen(false);
            // 引导里可能填了 key、换了编排工具：首页的工具菜单要按新的显示。
            void api<AgentsResponse>('/api/agents').then(data.setHomeAgents, () => {});
          }}
        />
      ) : data.loaded && (!currentId || homeOpen) ? (
        <Home
          projects={data.projects}
          summaries={data.summaries}
          defaultParent={data.defaultParent}
          currentId={currentId}
          agents={data.homeAgents}
          pluginsVersion={data.pluginsVersion}
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
          onProjectsChanged={loadProjects}
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
        <WorkspaceView
          markdownLinks={markdownLinks}
          panelOpen={panelOpen}
          workspace={layout.workspace}
          panelWidth={layout.panelWidths[layout.kind]}
          project={data.project}
          agents={data.agents}
          choice={data.choice}
          sessions={data.sessions}
          sessionId={data.sessionId}
          busy={data.busy}
          attachments={data.attachments}
          scenes={scenes}
          outbox={outbox}
          tab={tab}
          sceneId={data.sceneId}
          filePath={data.filePath}
          tree={tree}
          route={route}
          jump={jump}
          state={state}
          usage={data.usage}
          recent={data.recent}
          version={data.version}
          pluginPages={pluginPages}
          onChoice={data.changeChoice}
          onSession={data.chooseSession}
          onSessionsChanged={loadSessions}
          onRemoveAttachment={(index) => data.setAttachments((current) => current.filter((_, i) => i !== index))}
          onClearAttachments={() => data.setAttachments([])}
          onFilesChanged={data.onFilesChanged}
          onTurnEnd={() => {
            void loadProject();
            window.onset?.notify?.('这一轮做完了', data.project?.name ?? '片场');
          }}
          onAddAttachments={(list) => data.setAttachments((current) => [...current, ...list])}
          onAttach={data.addAttachment}
          onQuick={quick}
          onShowTab={showTab}
          onSetTab={setTab}
          onSetTabGuarded={layout.setTabGuarded}
          onSetPanelOpen={setPanelOpen}
          onGuardSceneLeave={layout.guardSceneLeave}
          onRegisterExitGuard={(guard) => {
            layout.sceneExitGuardRef.current = guard;
          }}
          onSetSceneId={data.setSceneId}
          onSetFilePath={data.setFilePath}
          onOpenView={openView}
          onJumpToTurn={jumpToTurn}
          onStartResize={layout.startResize}
          onResetWidth={layout.resetWidth}
          run={appTasks.run}
        />
      )}

      {seriesPanelOpen && state?.metadata.series_id && (
        <SeriesAssetsPanel
          seriesId={state.metadata.series_id}
          seriesName={state.metadata.series_name || state.metadata.series_id}
          episode={state.metadata.episode}
          onSynced={() => void loadProject()}
          onClose={() => setSeriesPanelOpen(false)}
        />
      )}
      <AppModals
        setup={setup}
        setupOpen={setupOpen}
        onCloseSetup={() => setSetupOpen(false)}
        settingsOpen={settingsOpen}
        onCloseSettings={() => setSettingsOpen(false)}
        version={data.version}
        currentId={currentId}
        run={appTasks.run}
        onOpenSettingsPage={(page) => {
          setSettingsOpen(false);
          // 从首页打开的设置：先回到项目，页面才看得见（桌宠切页同理）。
          setHomeOpen(false);
          showTab(page);
        }}
        onAgentsChanged={() => {
          void api<AgentsResponse>('/api/agents').then(
            (result) => {
              data.setHomeAgents(result);
              data.setAgents(result);
            },
            () => {},
          );
        }}
        onPluginsChanged={() => {
          data.setPluginsVersion((v) => v + 1);
          if (currentId) void loadProject();
        }}
        dialog={dialog}
        projects={data.projects}
        onCloseDialog={() => setDialog(false)}
        onProjectOpened={async () => {
          setDialog(false);
          setHomeOpen(false);
          await loadProjects();
        }}
        toast={toast}
      />
    </div>
  );
}
