import { useMemo, useState } from 'react';
import '../chat.css';
import type {
  AgentChoice,
  AgentsResponse,
  Attachment,
  ProgressState,
  Scene,
  SessionMeta,
  TreeFile,
  ViewRequest,
  ViewState,
} from '../types';
import { rendererState } from './agentReady';
import { ActivityStatus } from './chat/ActivityStatus';
import { showProgressCard, turnActivity } from './chat/activity';
import { answerAfter, BlockView, blockKey } from './chat/BlockView';
import { ChatComposer } from './chat/ChatComposer';
import { ChatHeader } from './chat/ChatHeader';
import { BackgroundTaskStatus, PermissionStack, PlanPill, QueuedStack } from './chat/ChatStacks';
import { choiceQuestion, useCrewBroadcast } from './chat/crew';
import {
  buildBlocks,
  parseChoices,
  pendingPermissions,
  pendingQuestions,
  queuedMessages,
  type TurnBlock,
} from './chat/model';
import { PolishCard } from './chat/Polish';
import { QuestionCard } from './chat/QuestionCard';
import { type Outbox, useChatActions } from './chat/useChatActions';
import { useChatScroll } from './chat/useChatScroll';
import { useNow, useSessionEvents } from './chat/useSessionEvents';
import { DirectorVisionNote } from './DirectorServices';
import { styleKey, useFilmStyles } from './FilmStyles';
import { guideFor } from './guide';
import { Icon } from './Icon';
import { RenderWatch } from './RenderActivity';

export type { Outbox } from './chat/useChatActions';
export { parseEventStream } from './chat/useSessionEvents';

interface Props {
  agents: AgentsResponse | null;
  choice: AgentChoice;
  onChoice: (choice: AgentChoice) => void;
  sessions: SessionMeta[];
  sessionId: string;
  busy: string;
  attachments: Attachment[];
  projectPath: string;
  onSession: (id: string) => void;
  onSessionsChanged: () => void;
  onRemoveAttachment: (index: number) => void;
  onClearAttachments: () => void;
  onFilesChanged: (files: string[]) => void;
  onTurnEnd: () => void;
  onOpenFile: (path: string) => void;
  onAddAttachments: (attachments: Attachment[]) => void;
  scenes: Scene[];
  outbox: Outbox | null;
  /** 用户此刻在看的页面，随消息发出。 */
  view: ViewState;
  /** 打开编排工具请用户看的页面。 */
  onView: (view: ViewRequest) => void;
  /** 项目里的文件（@ 补全、回复里的媒体播放器用）。 */
  tree: TreeFile[];
  /** 触发一个写任务（/render 这类命令用）。 */
  run: (path: string, payload?: Record<string, unknown>) => void;
  /** 制作路线：对话顶上一行「现在在哪」，每轮结尾标出推进到了哪几站。 */
  progress: ProgressState | null;
  /** 从制作路线跳到某一轮。 */
  jump: { turn: string; nonce: number } | null;
  onProgress: () => void;
}

export function Chat(props: Props) {
  const { events, loaded, reconnecting } = useSessionEvents(
    props.sessionId,
    props.onFilesChanged,
    props.onTurnEnd,
    props.onView,
  );
  const [menu, setMenu] = useState<'' | 'history' | 'plus'>('');

  const blocks = useMemo(() => buildBlocks(events), [events]);
  // 整片风格目录：回复里推荐风格时按标识找名字与海报。
  const filmStyles = useFilmStyles(!!props.sessionId);
  const files = useMemo(() => props.tree.map((f) => f.path), [props.tree]);
  const mtimes = useMemo(() => new Map(props.tree.map((f) => [f.path, f.mtime])), [props.tree]);
  const styleIndex = useMemo(
    () => new Map((filmStyles.data?.styles ?? []).map((style) => [styleKey(style), style])),
    [filmStyles.data],
  );
  const queue = useMemo(() => queuedMessages(events), [events]);
  const asks = useMemo(() => pendingPermissions(events), [events]);
  const questions = useMemo(() => pendingQuestions(events), [events]);
  const lastTurn = [...blocks].reverse().find((b): b is TurnBlock => b.kind === 'turn');
  const running = !!lastTurn && !lastTurn.end;
  const plan = running ? (lastTurn?.plan ?? null) : null;
  const now = useNow(running);
  const activityEvents = useMemo(
    () => events.filter((event) => event.turn_id === lastTurn?.id),
    [events, lastTurn?.id],
  );
  const activity = lastTurn && running ? turnActivity(lastTurn, activityEvents, asks, now, questions) : null;
  // 在等镜头制作时，「镜头制作」卡片已经逐个镜头报进度，不再叠一张「正在执行操作」。
  const renderingScenes = props.scenes.filter((scene) => scene.rendering).length;
  const showActivity = showProgressCard(activity, lastTurn, renderingScenes, reconnecting);

  const session = props.sessions.find((s) => s.session_id === props.sessionId);
  // 镜头由渲染工具来画；制作人需要模型服务，外部工具需要安装，开工前先检查。
  const drawing = rendererState(props.agents, props.choice.renderer || props.agents?.renderer || '');
  // 制作人这次会用的模型：会话选的，否则项目设置里给制作人选的；都空时后端按填了 key 的服务商挑。
  const directorModel =
    props.choice.model || (props.agents?.orchestrator === 'director' ? props.agents.orchestrator_model : '');

  const { scroller, following, atBottom, scrolled, onScroll, jumpToLatest } = useChatScroll(
    props.sessionId,
    blocks,
    queue.length,
    props.jump,
  );

  const actions = useChatActions({
    choice: props.choice,
    sessionId: props.sessionId,
    busy: props.busy,
    attachments: props.attachments,
    onSession: props.onSession,
    onSessionsChanged: props.onSessionsChanged,
    onClearAttachments: props.onClearAttachments,
    onAddAttachments: props.onAddAttachments,
    scenes: props.scenes,
    files,
    outbox: props.outbox,
    view: props.view,
    onView: props.onView,
    run: props.run,
    running,
    asks,
    drawing,
    following,
  });

  // 上一轮回复末尾的选项只在它还能点时有效（与对话里的按钮同一个条件）。
  const choiceTurn =
    !running && queue.length === 0 && blocks[blocks.length - 1]?.kind === 'turn' ? lastTurn?.id : undefined;
  const lastProse = choiceTurn && lastTurn ? lastTurn.prose.map((event) => event.text ?? '').join('\n\n') : '';
  const deskChoices = useMemo(() => (lastProse ? parseChoices(lastProse) : []), [lastProse]);
  // 最近几轮怎么收场的（桌宠里剧组的心情按它算）。
  const recentResults = useMemo(
    () =>
      blocks
        .filter((b): b is TurnBlock => b.kind === 'turn' && !!b.end && !b.reverted)
        .slice(-5)
        .map((b) =>
          b.state === 'failed' ? 'failed' : b.state === 'stopped' || b.state === 'interrupted' ? 'stopped' : 'done',
        ),
    [blocks],
  );
  // 桌宠的场记小人跟着这一轮走（main/pet.ts），批准、选项、发话、停下也能在桌宠上做。
  useCrewBroadcast(
    lastTurn,
    asks,
    props.scenes,
    props.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? '',
    {
      choices: actions.blocked ? [] : deskChoices,
      question: choiceQuestion(lastProse),
      questionsCount: questions.length,
      questionTitle: questions[0]?.title || questions[0]?.questions[0]?.question || '',
      running,
      canSend: !actions.blocked,
      recent: recentResults,
    },
    questions,
  );

  // 「接下来」卡片：按制作路线现在这一站说清该做什么（guide.ts），按钮只做界面本来就能做的事。
  const started = props.sessions.length > 0 || Object.keys(props.progress?.turns ?? {}).length > 0;
  const guide = guideFor(props.progress, started);

  // 只有最后一条回复、之后用户还没说话时，选项才可点。
  const canSend = !actions.blocked && actions.draft.trim() !== '';
  // 刚发出的一刻不换成停止键：按钮就在指针底下，连点两下会把这一轮停掉。
  const showStop = running && !actions.draft.trim() && !actions.sending;

  return (
    <section className="pane chat-main chat" aria-label="对话">
      <ChatHeader
        sessions={props.sessions}
        sessionId={props.sessionId}
        session={session}
        menu={menu}
        onMenu={setMenu}
        onPickSession={(id) => {
          setMenu('');
          following.current = true;
          props.onSession(id);
        }}
        onNewSession={() => props.onSession('')}
        onHandoff={() => void actions.handoff()}
        onStartProduction={() => void actions.startProduction()}
        blocked={actions.blocked}
        running={running}
        sending={actions.sending}
        drawing={drawing}
        progress={props.progress}
        onProgress={props.onProgress}
        guide={guide}
        onGuideAction={actions.runGuide}
      />

      <div className={'chat-log-wrap' + (scrolled ? ' edge' : '')}>
        <div
          className={'chat-log' + (plan ? ' has-plan' : '')}
          id="messages"
          ref={scroller}
          onScroll={onScroll}
          onClickCapture={(event) => {
            // 要在 details 改变高度之前停止跟随；toggle 通知可能晚于 ResizeObserver。
            if ((event.target as Element).closest('summary')) following.current = false;
          }}
        >
          {loaded && events.length === 0 && (
            <div className="intro">
              <h3>说说要做什么</h3>
              <p>AI 会直接改项目文件，每一轮的改动都能查看和回退。</p>
              <p className="muted">
                新项目先点「开始制作」：按新建时选的片型，从文章开始一步步做到成片。之后在同一个会话里继续改。文章、图片和音频可以直接拖进输入框。
              </p>
              {props.choice.tool === 'director' && <DirectorVisionNote model={directorModel} />}
            </div>
          )}
          {blocks.map((block, index) => (
            <BlockView
              key={blockKey(block)}
              block={block}
              latest={index === blocks.length - 1 || (block.kind === 'turn' && block === lastTurn)}
              now={now}
              projectPath={props.projectPath}
              choicesEnabled={block.kind === 'turn' && block.id === choiceTurn && !actions.blocked}
              answer={block.kind === 'turn' ? answerAfter(blocks, index) : undefined}
              onChoice={(text) => void actions.deliver(text, [])}
              onFocusComposer={() => actions.textarea.current?.focus()}
              onRetry={(text) => void actions.deliver(text, [])}
              onOpenFile={props.onOpenFile}
              onView={props.onView}
              styles={styleIndex}
              files={files}
              mtimes={mtimes}
              stations={props.progress?.turns}
              posterVersion={filmStyles.posterVersion}
              onReverted={props.onTurnEnd}
            />
          ))}
        </div>
        <div className="chat-float">
          {!atBottom ? (
            <button className="float-pill jump" onClick={jumpToLatest}>
              <Icon name="down" size={12} />
              回到最新
            </button>
          ) : (
            plan && <PlanPill plan={plan} scenes={props.scenes} />
          )}
        </div>
      </div>

      <RenderWatch scenes={props.scenes} onView={props.onView} />
      {running && !!lastTurn?.backgroundTasks.length && <BackgroundTaskStatus tasks={lastTurn.backgroundTasks} />}
      {asks.length > 0 && (
        <PermissionStack asks={asks} onAnswer={(ask, decision) => void actions.answer(ask, decision)} />
      )}
      {questions.length > 0 && (
        <div className="question-stack">
          <QuestionCard
            ask={questions[0]}
            queueIndex={0}
            queueTotal={questions.length}
            disabled={questions[0].deferred ? actions.blocked : false}
            onSubmit={(payload) => actions.answerQuestion(questions[0], payload)}
            onSkip={() => actions.answerQuestion(questions[0], { status: 'skipped' })}
          />
        </div>
      )}
      {queue.length > 0 && (
        <QueuedStack queue={queue} onAction={(item, action) => void actions.queueAction(item, action)} />
      )}
      {actions.polishing && (
        <PolishCard
          state={actions.polishing}
          draft={actions.draft}
          onUse={actions.applyPolish}
          onRetry={() => void actions.polish(actions.polishing!.from)}
          onClose={actions.closePolish}
        />
      )}

      {showActivity && activity && lastTurn && (
        <ActivityStatus
          activity={activity}
          turn={lastTurn}
          now={now}
          projectPath={props.projectPath}
          reconnecting={reconnecting}
        />
      )}

      <ChatComposer
        agents={props.agents}
        choice={props.choice}
        onChoice={props.onChoice}
        attachments={props.attachments}
        onRemoveAttachment={props.onRemoveAttachment}
        completion={actions.completion}
        draft={actions.draft}
        onDraftChange={(value) => {
          actions.setDraft(value);
          actions.setUndoPolish(null);
        }}
        onPickDraft={(text, nextCaret) => {
          actions.setDraft(text);
          actions.pendingCaret.current = nextCaret;
          actions.textarea.current?.focus();
        }}
        textareaRef={actions.textarea}
        pendingCaretRef={actions.pendingCaret}
        running={running}
        sending={actions.sending}
        uploading={actions.uploading}
        busy={props.busy}
        error={actions.error}
        canSend={canSend}
        showStop={showStop}
        menu={menu}
        onMenu={setMenu}
        polishing={actions.polishing}
        undoPolish={actions.undoPolish}
        onUndoPolish={() => {
          if (actions.undoPolish !== null) {
            actions.fill(actions.undoPolish);
            actions.setUndoPolish(null);
          }
        }}
        onPolish={() => void actions.polish()}
        onSend={() => void actions.send()}
        onCancel={() => void actions.cancel()}
        onUpload={(uploadFiles) => void actions.upload(uploadFiles)}
        onRunCommand={actions.runCommand}
      />
    </section>
  );
}
