import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { Chat, type Outbox } from '../components/Chat';
import { ContextMenu } from '../components/ContextMenu';
import { MarkdownContext } from '../components/chat/Markdown';
import { Icon } from '../components/Icon';
import { Preview, type Tab } from '../components/Preview';
import { canReveal, revealInFinder } from '../reveal';
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
  TreeFile,
  ViewRequest,
} from '../types';
import { pageForFile, tabLabel } from './helpers';

export interface WorkspaceViewProps {
  markdownLinks: { files: string[]; onOpenFile: (path: string) => void };
  panelOpen: boolean;
  workspace: RefObject<HTMLDivElement | null>;
  panelWidth: number;
  project?: Project;
  agents: AgentsResponse | null;
  choice: AgentChoice;
  sessions: SessionMeta[];
  sessionId: string;
  busy: string;
  attachments: Attachment[];
  scenes: Scene[];
  outbox: Outbox | null;
  tab: Tab;
  sceneId: string;
  filePath: string;
  tree: TreeFile[];
  route: ProgressState | null;
  jump: { turn: string; nonce: number } | null;
  state: ProjectState | null;
  usage: ProjectUsage | null;
  recent: Set<string>;
  version: number;
  pluginPages: string[];
  onChoice: (next: AgentChoice) => Promise<void>;
  onSession: (id: string) => void;
  onSessionsChanged: () => Promise<void>;
  onRemoveAttachment: (index: number) => void;
  onClearAttachments: () => void;
  onFilesChanged: (files: string[]) => void;
  onTurnEnd: () => void;
  onAddAttachments: (list: Attachment[]) => void;
  onAttach: (attachment: Attachment) => void;
  onQuick: (text: string, quickAttachments: Attachment[], draftOnly?: boolean, appendDraft?: boolean) => void;
  onShowTab: (next: Tab) => void;
  onSetTab: (next: Tab) => void;
  onSetTabGuarded: (next: Tab) => void;
  onSetPanelOpen: (open: boolean) => void;
  onGuardSceneLeave: (proceed: () => void) => void;
  onRegisterExitGuard: (guard: ((proceed: () => void) => boolean) | null) => void;
  onSetSceneId: (id: string) => void;
  onSetFilePath: (path: string) => void;
  onOpenView: (view: ViewRequest) => void;
  onJumpToTurn: (session: string, turn: string) => void;
  onStartResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResetWidth: () => void;
  run: (path: string, payload?: Record<string, unknown>, onAccepted?: () => void) => Promise<void>;
}

export function WorkspaceView(props: WorkspaceViewProps) {
  const { panelOpen, tab, sceneId, filePath, scenes } = props;

  const openFile = (path: string) => {
    const page = pageForFile(path);
    if (page) {
      props.onShowTab(page);
      return;
    }
    props.onSetFilePath(path);
    props.onShowTab('file');
  };

  return (
    <MarkdownContext.Provider value={props.markdownLinks}>
      <div
        className={'workspace' + (panelOpen ? ' panel-open' : '')}
        ref={props.workspace}
        style={{ '--panel-w': `${props.panelWidth * 100}%` } as CSSProperties}
      >
        <ContextMenu
          onAttach={props.onAttach}
          onQuick={props.onQuick}
          onScene={(id) => {
            props.onSetSceneId(id);
            props.onShowTab('scene');
          }}
          onFile={openFile}
          onReveal={
            canReveal
              ? (target) => {
                  const sc = target.scene ? scenes.find((s) => s.id === target.scene) : undefined;
                  if (target.scene && !sc) return;
                  revealInFinder(
                    sc ? (sc.exists && sc.output ? sc.directory + '/' + sc.output : sc.directory) : (target.file ?? ''),
                  );
                }
              : undefined
          }
        />
        <Chat
          projectPath={props.project?.path ?? ''}
          agents={props.agents}
          choice={props.choice}
          onChoice={props.onChoice}
          sessions={props.sessions}
          sessionId={props.sessionId}
          busy={props.busy}
          attachments={props.attachments}
          onSession={props.onSession}
          onSessionsChanged={props.onSessionsChanged}
          onRemoveAttachment={props.onRemoveAttachment}
          onClearAttachments={props.onClearAttachments}
          onFilesChanged={props.onFilesChanged}
          onTurnEnd={props.onTurnEnd}
          onOpenFile={openFile}
          onAddAttachments={props.onAddAttachments}
          scenes={scenes}
          outbox={props.outbox}
          view={{
            page: panelOpen ? tab : '',
            scene: sceneId || undefined,
            file: tab === 'file' ? filePath : undefined,
          }}
          tree={props.tree}
          run={props.run}
          onView={props.onOpenView}
          progress={props.route}
          jump={props.jump}
          onProgress={() => props.onShowTab('progress')}
        />
        {panelOpen ? (
          <>
            <div
              className="panel-scrim"
              aria-hidden="true"
              onClick={() => props.onGuardSceneLeave(() => props.onSetPanelOpen(false))}
            />
            <div
              className="panel-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整画面宽度，双击恢复默认"
              title="拖动调整宽度，双击恢复默认"
              onPointerDown={props.onStartResize}
              onDoubleClick={props.onResetWidth}
            />
            <section className="panel" id="panel" aria-label="画面">
              <header className="panel-head">
                <span className="panel-title">
                  {tabLabel(tab)}
                  {(tab === 'scene' || tab === 'compose') && sceneId && <span className="panel-sub">{sceneId}</span>}
                  {tab === 'file' && filePath && <span className="panel-sub ellipsis">{filePath}</span>}
                </span>
                <span className="spacer" />
                <button
                  className="ghost icon"
                  id="panel-close"
                  aria-label="收起画面"
                  title="收起画面（Esc）"
                  onClick={() => props.onGuardSceneLeave(() => props.onSetPanelOpen(false))}
                >
                  <Icon name="close" />
                </button>
              </header>
              <Preview
                tab={tab}
                onTab={props.onSetTabGuarded}
                onRegisterExitGuard={props.onRegisterExitGuard}
                state={props.state}
                scenes={scenes}
                usage={props.usage}
                sceneId={sceneId}
                filePath={filePath}
                tree={props.tree}
                recent={props.recent}
                version={props.version}
                pages={props.pluginPages}
                progress={props.route}
                busy={props.busy}
                onAttach={props.onAttach}
                onQuick={props.onQuick}
                onFile={(path) => {
                  props.onGuardSceneLeave(() => {
                    props.onSetFilePath(path);
                    props.onSetTab('file');
                  });
                }}
                onScene={(id) => {
                  props.onGuardSceneLeave(() => {
                    props.onSetSceneId(id);
                    if (tab !== 'scene' && tab !== 'compose' && tab !== 'memory' && tab !== 'audition')
                      props.onSetTab('scene');
                  });
                }}
                onTurn={props.onJumpToTurn}
                run={props.run}
              />
            </section>
          </>
        ) : (
          <PanelRail
            scenes={scenes}
            sceneId={sceneId}
            onOpen={() => props.onSetPanelOpen(true)}
            onScene={(id) => {
              props.onSetSceneId(id);
              props.onShowTab('scene');
            }}
          />
        )}
      </div>
    </MarkdownContext.Provider>
  );
}

/** 面板收起时右边的一条细栏：每个镜头一个小方块（已出片、过期、渲染中、未出片），点开回到画面。 */
function PanelRail(props: { scenes: Scene[]; sceneId: string; onOpen: () => void; onScene: (id: string) => void }) {
  const done = props.scenes.filter((s) => s.exists && !s.stale).length;
  return (
    <aside className="panel-rail" aria-label="画面（已收起）">
      <button
        className="ghost icon rail-open"
        id="panel-open"
        aria-label="显示画面"
        title="显示画面（⌘\\）"
        onClick={props.onOpen}
      >
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
