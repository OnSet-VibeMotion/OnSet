import { BrandMark } from '../components/BrandMark';
import { Icon } from '../components/Icon';
import { type Tab, visibleTabs } from '../components/Preview';
import type { currentSummary } from '../components/Progress';
import { SkillsPill, type SkillsStatus } from '../components/SkillsPill';
import { PageMenu } from '../components/Stations';
import { Tasks } from '../components/Tasks';
import { WindowsApplicationMenu, WindowsWindowControls } from '../components/WindowsChrome';
import { canReveal, revealInFinder, revealLabel } from '../reveal';
import type { ProgressState, Project, ProjectState, Task } from '../types';
import { canvasLabel, tabLabel } from './helpers';

export interface TopbarProps {
  project?: Project;
  state: ProjectState | null;
  currentId: string;
  homeOpen: boolean;
  tab: Tab;
  panelOpen: boolean;
  route: ProgressState | null;
  now: ReturnType<typeof currentSummary>;
  steps: Tab[];
  progress: number;
  flowHidden: string[];
  pluginTabs: [Tab, string][];
  scriptMtime: number;
  scriptSeen: number;
  storyboardMtime: number;
  boardSeen: number;
  setupMissing: number;
  setupCore: number;
  setupRequiredMissing: boolean;
  skills: SkillsStatus | null;
  busy: string;
  tasks: Task[];
  updateDot: boolean;
  connected: boolean;
  onHome: () => void;
  onOpenDialog: () => void;
  onShowTab: (tab: Tab) => void;
  onOpenSetup: () => void;
  onInstallSkills: () => void;
  onTogglePanel: () => void;
  onCancelTask: (id: string) => void;
  onOpenMemory: () => void;
  onOpenSettings: () => void;
}

export function Topbar(props: TopbarProps) {
  const {
    project,
    state,
    currentId,
    homeOpen,
    tab,
    panelOpen,
    route,
    now,
    steps,
    progress,
    flowHidden,
    pluginTabs,
    scriptMtime,
    scriptSeen,
    storyboardMtime,
    boardSeen,
    setupMissing,
    setupCore,
    setupRequiredMissing,
    skills,
    busy,
    tasks,
    updateDot,
    connected,
  } = props;

  return (
    <header className="topbar">
      <WindowsWindowControls />
      <button className="brand" title="回到首页" aria-label="回到首页" onClick={props.onHome}>
        <span className="brand-mark" aria-hidden="true">
          <BrandMark />
        </span>
      </button>
      <button
        className="project-switch"
        id="open-project-trigger"
        title={project ? `${project.path}\n切换项目` : '选择项目'}
        onClick={props.onOpenDialog}
      >
        <strong id="title" className="ellipsis">
          {project?.name ?? '选择项目'}
        </strong>
        {state?.metadata.canvas && <span className="project-meta">{canvasLabel(state.metadata.canvas)}</span>}
      </button>
      {canReveal && currentId && !homeOpen && (
        <button
          className="ghost icon reveal-project"
          id="reveal-project"
          title={`${revealLabel}（⌥⌘R）`}
          aria-label={`在 Finder 中打开项目文件夹`}
          onClick={() => revealInFinder('')}
        >
          <Icon name="folder" size={13} />
        </button>
      )}
      {currentId && !homeOpen && (
        <nav className="steps" aria-label="制作步骤">
          {/* 制作路线是步骤条的第一格：同一种样式，有关卡在等你时编号位置亮一个黄铜色点。 */}
          <button
            className={
              'step route-step' +
              (tab === 'progress' && panelOpen ? ' on' : '') +
              (route?.waiting_on === 'user' || now.station?.status === 'changed' ? ' waiting' : '')
            }
            id="progress-open"
            data-tab="progress"
            aria-current={tab === 'progress' && panelOpen ? 'page' : undefined}
            title={now.station ? `制作路线：现在在「${now.station.label}」，${now.text}` : '制作路线'}
            onClick={() => props.onShowTab('progress')}
          >
            <span className="step-no">
              <Icon name="route" size={12} />
            </span>
            路线
          </button>
          <span className="steps-sep" aria-hidden="true" />
          {steps.map((id, index) => (
            <button
              key={id}
              data-tab={id}
              className={
                'step' +
                (tab === id && panelOpen ? ' on' : '') +
                (index < progress ? ' done' : index === progress ? ' current' : '')
              }
              aria-current={tab === id && panelOpen ? 'page' : index === progress ? 'step' : undefined}
              title={
                index === progress
                  ? state?.step_marked
                    ? 'AI 标记：现在在这一步'
                    : '现在在这一步'
                  : index < progress
                    ? '已经做过'
                    : undefined
              }
              onClick={() => props.onShowTab(id)}
            >
              <span className="step-no">{index < progress ? '✓' : String(index + 1).padStart(2, '0')}</span>
              {tabLabel(id)}
              {id === 'scene' && state && state.scenes.total > 0 && (
                <span
                  className={'step-count' + (state.scenes.stale > 0 ? ' warn' : '')}
                  title={state.scenes.stale > 0 ? `${state.scenes.stale} 个镜头过期` : '已出片 / 全部镜头'}
                >
                  {state.scenes.completed}/{state.scenes.total}
                </span>
              )}
              {id === 'script' && scriptMtime > scriptSeen && tab !== 'script' && (
                <i className="tab-dot" aria-label="有更新" />
              )}
              {id === 'storyboard' && storyboardMtime > boardSeen && tab !== 'storyboard' && (
                <i className="tab-dot" aria-label="有更新" />
              )}
            </button>
          ))}
        </nav>
      )}
      <span className="spacer" />
      {currentId && !homeOpen && (
        <PageMenu
          pages={visibleTabs(flowHidden, state?.pages).filter(([id]) => !steps.includes(id)) as [string, string][]}
          tabs={pluginTabs}
          current={panelOpen ? tab : ''}
          onPick={(id) => props.onShowTab(id as Tab)}
        />
      )}
      {setupMissing > 0 && (
        <button
          className={'skills-pill' + (setupRequiredMissing ? ' bad' : '')}
          id="setup-pill"
          onClick={props.onOpenSetup}
          title="渲染与配音要用的工具：点开一键安装"
        >
          {setupCore > 0 ? `还差 ${setupCore} 项工具 · 去安装` : `可按需安装 ${setupMissing} 项`}
        </button>
      )}
      {currentId && !homeOpen && !setupRequiredMissing && skills && !skills.installed && (
        <SkillsPill status={skills} onInstall={props.onInstallSkills} />
      )}
      {busy && (
        <span className="pill busy" title="同一时间只有一个写入者">
          <span className="dot busy" />
          {busy}
        </span>
      )}
      {currentId && !homeOpen && <span className="topbar-sep" aria-hidden="true" />}
      {currentId && !homeOpen && (
        <button
          className={'ghost icon panel-toggle' + (panelOpen ? ' on' : '')}
          aria-label="画面"
          id="panel-toggle"
          aria-pressed={panelOpen}
          title={panelOpen ? '收起画面（⌘\\）' : '显示画面（⌘\\）'}
          onClick={props.onTogglePanel}
        >
          <Icon name="panel" size={14} />
        </button>
      )}
      <WindowsApplicationMenu />
      <Tasks tasks={tasks} onCancel={props.onCancelTask} onOpenMemory={props.onOpenMemory} />
      <button
        className="ghost icon settings-trigger"
        id="settings-trigger"
        title={updateDot ? '设置（⌘,）· 有新版本' : '设置（⌘,）'}
        aria-label="设置"
        onClick={props.onOpenSettings}
      >
        <Icon name="settings" size={14} />
        {updateDot && <span className="update-dot" aria-label="有新版本" />}
      </button>
      {/* 连上了是常态，不占位置；只在断开时说一句。 */}
      {!connected && (
        <span className="pill conn down" title="连接断开" aria-label="连接断开">
          <span className="dot bad" />
          <span>连接断开</span>
        </span>
      )}
    </header>
  );
}
