import { playerProps } from '../media';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, errorText, post, rawURL } from '../api';
import type { AgentChoice, AgentsResponse, Attachment, EventKind, PermissionAsk, PlanItem, Scene, SessionEvent, SessionMeta, ViewRequest, ViewState } from '../types';
import { tabs } from './Preview';
import { Poster, styleKey, useFilmStyles } from './FilmStyles';
import type { FilmStyle, ProgressState, TreeFile } from '../types';
import { confirmGate, currentSummary } from './Progress';
import { guideFor, type Guide, type GuideAction } from './guide';
import { AgentPicker } from './AgentPicker';
import { rendererState } from './agentReady';
import { DirectorVisionNote } from './DirectorServices';
import { DiffDialog } from './DiffDialog';
import { Icon } from './Icon';
import { Markdown } from './chat/Markdown';
import {
  buildBlocks,
  describeTool,
  formatElapsed,
  parseChoices,
  parseStylePicks,
  findMedia,
  type MediaRef,
  type StylePick,
  pendingPermissions,
  queuedMessages,
  seconds,
  splitAttachmentText,
  stripChoices,
  type Block,
  type ProcessItem,
  type QueuedMessage,
  type TurnBlock,
} from './chat/model';
import { applySuggestion, findToken, mentionAttachments, parseCommand, slashCommands, suggest, type SlashCommand, type Suggestion } from './chat/complete';
import '../chat.css';
import { RenderWatch } from './RenderActivity';
import { choiceQuestion, useCrewBroadcast, usePetCommands } from './chat/crew';
import { stationPageLabel } from './Stations';

// SSE 的 event 字段就是事件种类，EventSource 只把具名事件派给对应监听器，所以要逐个注册。
const kinds: EventKind[] = [
  'view',
  'session',
  'text',
  'thinking',
  'tool-call',
  'tool-result',
  'usage',
  'error',
  'done',
  'user',
  'turn-start',
  'turn-end',
  'files-changed',
  'notice',
  'turn-reverted',
  'queued',
  'unqueued',
  'plan',
  'permission',
  'permission-resolved',
];

/** 镜头页的快捷动作发来的消息：nonce 变了就发一次。 */
export interface Outbox {
  text: string;
  attachments: Attachment[];
  nonce: number;
  /** 为 true 时只填进输入框等用户补充，不直接发送。 */
  draftOnly?: boolean;
}

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

/** 视为「在底部」的容差：比这近就继续跟随新消息。 */
const BOTTOM_TOLERANCE = 8;

export function Chat(props: Props) {
  const { events, loaded } = useSessionEvents(props.sessionId, props.onFilesChanged, props.onTurnEnd, props.onView);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState<'' | 'history' | 'plus'>('');
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const following = useRef(true);
  // @ 与 / 补全：光标位置决定正在补全哪一段；按 Esc 收起，直到再输入。
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const pendingCaret = useRef<number | null>(null);

  const blocks = useMemo(() => buildBlocks(events), [events]);
  // 从制作路线跳过来：等那一轮出现在页面上（可能要先切会话、读完事件）再滚过去闪一下。
  const pendingJump = useRef('');
  useEffect(() => {
    if (props.jump) pendingJump.current = props.jump.turn;
  }, [props.jump]);
  useEffect(() => {
    const id = pendingJump.current;
    if (!id) return;
    const el = document.getElementById('turn-' + id);
    if (!el) return;
    pendingJump.current = '';
    following.current = false;
    const target = el.closest('.assistant-flow') ?? el;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('jump-flash');
    window.setTimeout(() => target.classList.remove('jump-flash'), 1800);
  }, [props.jump, blocks]);
  // 整片风格目录：回复里推荐风格时按标识找名字与海报。
  const filmStyles = useFilmStyles(!!props.sessionId);
  const files = useMemo(() => props.tree.map((f) => f.path), [props.tree]);
  const mtimes = useMemo(() => new Map(props.tree.map((f) => [f.path, f.mtime])), [props.tree]);
  const styleIndex = useMemo(() => new Map((filmStyles.data?.styles ?? []).map((style) => [styleKey(style), style])), [filmStyles.data]);
  const queue = useMemo(() => queuedMessages(events), [events]);
  const asks = useMemo(() => pendingPermissions(events), [events]);
  const lastTurn = [...blocks].reverse().find((b): b is TurnBlock => b.kind === 'turn');
  const running = !!lastTurn && !lastTurn.end;
  const plan = running ? lastTurn?.plan ?? null : null;
  const now = useNow(running);

  // 这一轮进行中照样能发：消息排到这一轮之后。别的写任务占着项目时不能发。
  const blocked = sending || (props.busy !== '' && !running);
  // 上一轮回复末尾的选项只在它还能点时有效（与对话里的按钮同一个条件）。
  const choiceTurn = !running && queue.length === 0 && blocks[blocks.length - 1]?.kind === 'turn' ? lastTurn?.id : undefined;
  const lastProse = choiceTurn && lastTurn ? lastTurn.prose.map((event) => event.text ?? '').join('\n\n') : '';
  const deskChoices = useMemo(() => (lastProse ? parseChoices(lastProse) : []), [lastProse]);
  // 最近几轮怎么收场的（桌宠里剧组的心情按它算）。
  const recentResults = useMemo(
    () =>
      blocks
        .filter((b): b is TurnBlock => b.kind === 'turn' && !!b.end && !b.reverted)
        .slice(-5)
        .map((b) => (b.state === 'failed' ? 'failed' : b.state === 'stopped' || b.state === 'interrupted' ? 'stopped' : 'done')),
    [blocks],
  );
  // 桌宠的场记小人跟着这一轮走（main/pet.ts），批准、选项、发话、停下也能在桌宠上做。
  useCrewBroadcast(lastTurn, asks, props.scenes, props.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? '', {
    choices: blocked ? [] : deskChoices,
    question: choiceQuestion(lastProse),
    running,
    canSend: !blocked,
    recent: recentResults,
  });
  const session = props.sessions.find((s) => s.session_id === props.sessionId);
  // 镜头由渲染工具来画（导演只做编排）：这台电脑上没装它时，整片制作会做到第一次渲染才报错，开工前就拦下。
  const drawing = rendererState(props.agents, props.choice.renderer || props.agents?.renderer || '');
  // 导演这次会用的模型：会话选的，否则项目设置里给导演选的；都空时后端按填了 key 的服务商挑。
  const directorModel = props.choice.model || (props.agents?.orchestrator === 'director' ? props.agents.orchestrator_model : '');

  const syncScrollState = useCallback((el: HTMLDivElement) => {
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANCE;
    setAtBottom(bottom);
    setScrolled(el.scrollTop > 1);
    return bottom;
  }, []);

  // 跟随到底：只有用户在底部（8px 内）时才跟；展开折叠项时不跳。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (following.current && el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight;
    syncScrollState(el);
  }, [blocks, queue.length, syncScrollState]);
  // 换会话时回到跟随：打开一段历史就落在最新的那一轮。
  useLayoutEffect(() => {
    following.current = true;
    setAtBottom(true);
  }, [props.sessionId]);
  // 内容在画完之后还会长高（图片、海报、视频封面解码完），对话区也会被上面后到的提示条压矮：
  // 跟随时一起贴住底部，不然打开历史停在半截。
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current && el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight;
      // 展开 / 收起可以只改变滚动范围而不改变 scrollTop，此时不会有 scroll 事件。
      syncScrollState(el);
    });
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [blocks, syncScrollState]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    following.current = syncScrollState(el);
  };

  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    following.current = true;
    // 直接落到底：平滑滚动的中间帧会被 onScroll 判成离开底部，关掉刚打开的跟随。
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    syncScrollState(el);
  };

  // 输入框随内容长高，最高 min(184px, 34vh)，再多就滚动。
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.min(184, window.innerHeight * 0.34))}px`;
  }, [draft]);

  const deliver = async (message: string, attachments: Attachment[], interrupt = false) => {
    if (!message || blocked) return false;
    setSending(true);
    setError('');
    try {
      let id = props.sessionId;
      if (!id) {
        const created = await post<SessionMeta>('/api/sessions', { title: message.slice(0, 24), ...props.choice });
        id = created.session_id;
        props.onSession(id);
      }
      await post(`/api/sessions/${id}/turns`, { message, attachments, interrupt, view: props.view });
      following.current = true;
      props.onSessionsChanged();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setSending(false);
    }
  };

  const completion = { scenes: props.scenes.map((s) => s.id), files };
  const token = dismissed ? null : findToken(draft, caret);
  const suggestions = token ? suggest(token, completion, running) : [];
  useEffect(() => setPicked(0), [token?.trigger, token?.query, token?.command?.name]);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [draft]);

  const fill = (text: string) => {
    setDraft(text);
    pendingCaret.current = text.length;
    textarea.current?.focus();
  };

  // 「接下来」卡片：按制作路线现在这一站说清该做什么（guide.ts），按钮只做界面本来就能做的事。
  const started = props.sessions.length > 0 || Object.keys(props.progress?.turns ?? {}).length > 0;
  const guide = guideFor(props.progress, started);
  const runGuide = (action: GuideAction) => {
    switch (action.kind) {
      case 'page':
        props.onView({ page: action.page, target: action.target });
        return;
      case 'say':
        void deliver(action.text, []);
        return;
      case 'draft':
        fill(action.text);
        return;
      case 'gate':
        void confirmGate(action.gate, (text) => void deliver(text, []), action.text);
        return;
      case 'start':
        if (!drawing.ok) {
          setError(drawing.reason);
          return;
        }
        void startProduction();
        return;
      case 'op':
        // NextStep 已经让用户确认过；执行是写任务，进度在任务列表里。
        props.run(`/api/stations/${encodeURIComponent(action.station)}/ops/${encodeURIComponent(action.op)}`, { params: {} });
        return;
    }
  };

  /** 执行一条 / 命令：网页里直接做的清空输入框，交给编排工具的换成一句模板。 */
  const runCommand = (command: SlashCommand, arg: string) => {
    setDismissed(false);
    switch (command.name) {
      case 'new':
        fill('');
        props.onSession('');
        return;
      case 'stop':
        fill('');
        void cancel();
        return;
      case 'start':
        fill('');
        if (!drawing.ok) {
          setError(drawing.reason);
          return;
        }
        void startProduction('');
        return;
      case 'script':
        fill('');
        props.onView({ page: 'script' });
        return;
      case 'show':
        fill('');
        props.onView({ page: arg });
        return;
      case 'confirm-script':
        fill('');
        void deliver('口播稿我看过了，没问题，按这版继续配音。', props.attachments).then((ok) => ok && props.onClearAttachments());
        return;
      case 'redo':
        props.onAddAttachments([{ ref: true, scene_id: arg }]);
        fill(`重做镜头 ${arg}：保留文案、时长和与相邻镜头的交接约定，`);
        return;
      case 'render':
        fill('');
        props.run(`/api/scenes/${encodeURIComponent(arg)}/render`);
        return;
      case 'render-all':
        fill('');
        props.run('/api/render/all');
        return;
      case 'validate':
        fill('');
        props.run('/api/commands/scene.validate', { scene_id: arg });
        return;
      case 'concat':
        fill('');
        props.run('/api/commands/project.concat');
        return;
      case 'review':
        fill('');
        props.run('/api/review/run');
        return;
      case 'remember':
        fill('记住这个偏好，以后都这样做：');
        return;
      default:
        if (command.plugin?.tab) {
          fill('');
          props.onView({ page: command.plugin.tab });
        } else if (command.plugin) fill(command.plugin.prompt);
    }
  };

  const pick = (item: Suggestion) => {
    if (!token) return;
    if (token.trigger === '/' && token.command) {
      runCommand(token.command, item.value);
      return;
    }
    if (token.trigger === '/') {
      const command = slashCommands.find((c) => c.name === item.value);
      if (command && !command.arg) {
        runCommand(command, '');
        return;
      }
    }
    const next = applySuggestion(draft, token, item);
    setDraft(next.text);
    pendingCaret.current = next.caret;
    textarea.current?.focus();
  };

  const send = async () => {
    const message = draft.trim();
    const command = parseCommand(message);
    if (command) {
      runCommand(command.command, command.arg);
      return;
    }
    const attachments = [...props.attachments, ...mentionAttachments(message, completion, props.attachments)];
    if (await deliver(message, attachments)) {
      // 发送途中用户可能已经接着打了下一条，只清掉发出去的那段。
      setDraft((current) => (current.trim() === message ? '' : current));
      props.onClearAttachments();
    }
  };

  const startProduction = async (message = draft.trim()) => {
    setSending(true);
    setError('');
    try {
      const result = await post<{ session_id: string }>('/api/production/start', { message, ...props.choice });
      setDraft('');
      following.current = true;
      props.onSession(result.session_id);
      props.onSessionsChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    try {
      await post(`/api/sessions/${props.sessionId}/cancel`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      for (const file of list) form.append('file', file, file.name || 'pasted.png');
      const result = await api<{ attachments: Attachment[] }>('/api/uploads', { method: 'POST', body: form });
      props.onAddAttachments(result.attachments);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setUploading(false);
    }
  };

  const answer = async (ask: PermissionAsk, decision: 'allow' | 'always' | 'deny' | 'auto') => {
    setError('');
    try {
      if (decision === 'auto') {
        // 「以后都不用问」：打开全局的自动批准（设置页里能关），再把眼前在等的一并放行。
        await post('/api/settings/global', { key: 'AUTO_APPROVE', value: 'on' });
        for (const other of asks) await post(`/api/sessions/${props.sessionId}/permissions/${other.id}`, { decision: 'allow' });
        return;
      }
      await post(`/api/sessions/${props.sessionId}/permissions/${ask.id}`, { decision });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const queueAction = async (item: QueuedMessage, action: 'steer' | 'remove' | 'edit') => {
    setError('');
    try {
      if (action === 'steer') {
        await post(`/api/sessions/${props.sessionId}/queue/${item.id}/steer`);
        return;
      }
      await api(`/api/sessions/${props.sessionId}/queue/${item.id}`, { method: 'DELETE' });
      if (action === 'edit') {
        setDraft(splitAttachmentText(item.text).body);
        textarea.current?.focus();
      }
    } catch (err) {
      setError(errorText(err));
    }
  };

  // 桌宠上的动作：答批准、点选项或说一句、停下这一轮。
  usePetCommands((command) => {
    if (command.kind === 'answer') {
      const ask = asks.find((a) => a.id === command.id);
      if (ask) void answer(ask, command.decision);
    } else if (command.kind === 'say') {
      void deliver(command.text, []);
    } else if (command.kind === 'stop') {
      if (running) void cancel();
    }
  });

  // 镜头页快捷动作：直接发，或填进输入框等用户补充。
  const lastOutbox = useRef(0);
  useEffect(() => {
    const out = props.outbox;
    if (!out || out.nonce === lastOutbox.current) return;
    lastOutbox.current = out.nonce;
    if (out.draftOnly) {
      setDraft(out.text);
      if (out.attachments.length) props.onAddAttachments(out.attachments);
      textarea.current?.focus();
      return;
    }
    void deliver(out.text, out.attachments);
  }, [props.outbox]);

  // 只有最后一条回复、之后用户还没说话时，选项才可点。
  const canSend = !blocked && draft.trim() !== '';
  // 刚发出的一刻不换成停止键：按钮就在指针底下，连点两下会把这一轮停掉。
  const showStop = running && !draft.trim() && !sending;

  return (
    <section className="pane chat-main chat" aria-label="对话">
      <header className="chat-header">
        <div className="history">
          <button
            className="icon-button"
            id="history"
            aria-label="会话记录"
            title="会话记录"
            aria-expanded={menu === 'history'}
            onClick={() => setMenu(menu === 'history' ? '' : 'history')}
          >
            <Icon name="history" size={14} />
          </button>
          {menu === 'history' && (
            <HistoryMenu
              sessions={props.sessions}
              current={props.sessionId}
              onPick={(id) => {
                setMenu('');
                following.current = true;
                props.onSession(id);
              }}
              onClose={() => setMenu('')}
            />
          )}
        </div>
        <span className="chat-title ellipsis" id="session-title" title={session?.title}>
          {session ? `${session.title}${session.kind === 'production' ? ' · 整片制作' : ''}` : '新对话'}
        </span>
        <span className="spacer" />
        {props.sessionId && (
          <button className="icon-button" onClick={() => props.onSession('')} aria-label="新对话" title="新对话">
            <Icon name="plus" size={13} />
          </button>
        )}
        <button
          id="start-production"
          className="primary pill"
          disabled={blocked || running || !drawing.ok}
          onClick={() => void startProduction()}
          title={drawing.ok ? '从头开始整片制作' : drawing.reason}
        >
          开始制作
        </button>
      </header>
      {!drawing.ok && (
        <div className="chat-renderer-missing" role="alert" id="renderer-missing">
          <Icon name="alert" size={13} />
          <span>{drawing.reason}：在输入框下方「渲染」里换一家，或去设置里改。</span>
        </div>
      )}
      <ProgressStrip progress={props.progress} onOpen={props.onProgress} />
      <NextStep guide={guide} disabled={blocked || running || sending} onAction={runGuide} />

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
              choicesEnabled={block.kind === 'turn' && block.id === choiceTurn && !blocked}
              answer={block.kind === 'turn' ? answerAfter(blocks, index) : undefined}
              onChoice={(text) => void deliver(text, [])}
              onRetry={(text) => void deliver(text, [])}
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
      {asks.length > 0 && <PermissionStack asks={asks} onAnswer={answer} />}
      {queue.length > 0 && <QueuedStack queue={queue} onAction={queueAction} />}

      <footer className="composer">
        <div
          className={'composer-shell' + (dragging ? ' dragging' : '')}
          onDragOver={(e) => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            setDragging(false);
            if (!e.dataTransfer?.files.length) return;
            e.preventDefault();
            void upload(e.dataTransfer.files);
          }}
        >
          {props.attachments.length > 0 && <AttachmentTray attachments={props.attachments} onRemove={props.onRemoveAttachment} />}
          {suggestions.length > 0 && token && (
            <ul className="completions" id="completions" role="listbox" aria-label={token.trigger === '@' ? '引用镜头或文件' : '命令'}>
              <li className="completions-head" aria-hidden="true">
                {token.trigger === '@' ? '引用镜头或文件，发送时一起交给 AI' : token.command ? `/${token.command.name} 的参数` : '命令'}
              </li>
              {suggestions.map((item, index) => (
                <li
                  key={item.kind + item.value}
                  role="option"
                  aria-selected={index === picked}
                  className={'completion' + (index === picked ? ' on' : '')}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(item);
                  }}
                  onMouseEnter={() => setPicked(index)}
                >
                  <span className={'completion-kind ' + item.kind} aria-hidden="true">
                    {item.kind === 'command' ? '/' : item.kind === 'scene' ? <Icon name="film" size={12} /> : item.kind === 'page' ? '↗' : <Icon name="file" size={12} />}
                  </span>
                  <span className="completion-label">{item.label}</span>
                  {item.hint && <span className="completion-hint">{item.hint}</span>}
                </li>
              ))}
              <li className="completions-foot" aria-hidden="true">
                ↑↓ 选择 · Enter / Tab 确定 · Esc 收起
              </li>
            </ul>
          )}
          <label htmlFor="prompt" className="sr-only">
            消息
          </label>
          <textarea
            id="prompt"
            ref={textarea}
            rows={2}
            value={draft}
            placeholder={running ? '补充要求会排在这一轮之后…' : '说说要改什么，可以拖入或粘贴文章、图片、音频'}
            onChange={(e) => {
              setDraft(e.currentTarget.value);
              setCaret(e.currentTarget.selectionStart ?? 0);
              setDismissed(false);
            }}
            onKeyUp={(e) => {
              if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) setCaret(e.currentTarget.selectionStart ?? 0);
            }}
            onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onBlur={() => window.setTimeout(() => setDismissed(true), 150)}
            onFocus={() => setDismissed(false)}
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls="completions"
            aria-autocomplete="list"
            onPaste={(e) => {
              const files = e.clipboardData?.files;
              if (files && files.length > 0) {
                e.preventDefault();
                void upload(files);
              }
            }}
            onKeyDown={(e) => {
              const composing = e.nativeEvent.isComposing || e.keyCode === 229;
              if (suggestions.length > 0 && !composing) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setPicked((index) => (index + step + suggestions.length) % suggestions.length);
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault();
                  pick(suggestions[Math.min(picked, suggestions.length - 1)]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDismissed(true);
                  return;
                }
              }
              // Enter 发送，Shift+Enter 换行；输入法组字时的 Enter 不算。
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                if (canSend) void send();
              }
            }}
          />
          <div className="composer-toolbar">
            <div className="plus">
              <button
                className="icon-button"
                id="plus"
                aria-label="添加"
                title="添加文件"
                aria-expanded={menu === 'plus'}
                onClick={() => setMenu(menu === 'plus' ? '' : 'plus')}
              >
                <Icon name="plus" size={13} />
              </button>
              {menu === 'plus' && (
                <div className="popover menu up" role="menu">
                  <button
                    role="menuitem"
                    id="upload"
                    onClick={() => {
                      setMenu('');
                      fileInput.current?.click();
                    }}
                  >
                    <Icon name="attach" size={13} />
                    上传文件或图片
                    <span className="muted small">也可以拖进来或粘贴</span>
                  </button>
                </div>
              )}
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const files = e.currentTarget.files;
                  if (files) void upload(files);
                  e.currentTarget.value = '';
                }}
              />
            </div>
            <AgentPicker agents={props.agents} value={props.choice} disabled={running || sending} onChange={props.onChoice} />
            <span className="spacer" />
            {showStop ? (
              <button id="cancel-turn" className="primary-slot stop" onClick={cancel} aria-label="停止本轮" title="停止本轮（排队的消息一并作废）">
                <span className="stop-glyph" />
              </button>
            ) : (
              <button
                id="send"
                className="primary-slot"
                disabled={!canSend}
                onClick={() => void send()}
                aria-label={running ? '排队发送' : '发送'}
                title={running ? '排到这一轮之后发送（Enter）' : '发送（Enter，Shift+Enter 换行）'}
              >
                <Icon name="up" size={13} />
              </button>
            )}
          </div>
        </div>
        {(error || uploading || (props.busy && !running)) && (
          <p className={'composer-hint' + (error ? ' error' : '')}>{error || (uploading ? '上传中…' : `项目正忙：${props.busy}`)}</p>
        )}
      </footer>
    </section>
  );
}

function blockKey(block: Block): string {
  if (block.kind === 'turn') return 't' + block.id;
  return 'e' + block.event.seq;
}

/** 进行中的一轮每秒刷新一次计时。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** 切页请求在多久之内算刚发生（毫秒）。 */
const viewFreshMs = 15000;

/** 把 SSE 正文里的事件读出来（follow=0 时后端写完历史就结束）。 */
export function parseEventStream(text: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const chunk of text.split('\n\n')) {
    const data = chunk
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    if (data !== '') out.push(JSON.parse(data) as SessionEvent);
  }
  return out;
}

/**
 * 订阅一个会话的事件流。打开会话时先一次取完历史（follow=0）、一次画出来，再从最后一条接着订阅：
 * 历史也走 SSE 的话是一条条到、一帧帧画，画面会从头往下滚上好一阵。EventSource 断线后自带
 * Last-Event-ID 重连，后端按 seq 补发，这里再按 seq 去重。
 */
function useSessionEvents(
  sessionId: string,
  onFilesChanged: (files: string[]) => void,
  onTurnEnd: () => void,
  onView: (view: ViewRequest) => void,
) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const callbacks = useRef({ onFilesChanged, onTurnEnd, onView });
  callbacks.current = { onFilesChanged, onTurnEnd, onView };

  useEffect(() => {
    setEvents([]);
    setLoaded(false);
    if (!sessionId) {
      setLoaded(true);
      return;
    }
    let closed = false;
    let source: EventSource | null = null;
    let last = 0;
    let pending: SessionEvent[] = [];
    let frame = 0;
    // 重放历史时一次会来很多条，攒到下一帧一起更新，避免逐条重渲染。
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      setEvents((current) => current.concat(batch));
    };
    const notify = (event: SessionEvent) => {
      if (event.kind === 'files-changed' && event.files) callbacks.current.onFilesChanged(event.files);
      if (event.kind === 'turn-end') callbacks.current.onTurnEnd();
      // 只执行刚发生的切页请求：打开会话时重放的历史不该把页面切来切去。
      if (event.kind === 'view' && event.view && Date.now() - Date.parse(event.time) < viewFreshMs) callbacks.current.onView(event.view);
    };
    const handle = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as SessionEvent;
      if (event.seq <= last) return;
      last = event.seq;
      pending.push(event);
      if (!frame) frame = requestAnimationFrame(flush);
      notify(event);
    };
    const follow = () => {
      if (closed) return;
      source = new EventSource(`/api/sessions/${sessionId}/events?after=${last}`);
      for (const kind of kinds) source.addEventListener(kind, handle as EventListener);
    };
    void (async () => {
      try {
        const response = await fetch(`/api/sessions/${sessionId}/events?follow=0`);
        if (!response.ok) throw new Error(String(response.status));
        const history = parseEventStream(await response.text());
        if (closed) return;
        const fresh = history.filter((event) => event.seq > last);
        if (fresh.length > 0) last = fresh[fresh.length - 1].seq;
        setEvents(fresh);
        for (const event of fresh) notify(event);
      } catch {
        // 取不到就退回原来的路子：整段历史从订阅里补发。
      }
      if (closed) return;
      setLoaded(true);
      follow();
    })();
    return () => {
      closed = true;
      source?.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sessionId]);

  return { events, loaded };
}

interface BlockProps {
  block: Block;
  latest: boolean;
  now: number;
  projectPath: string;
  choicesEnabled: boolean;
  /** 这一轮之后用户说的第一句话：有它说明选项已经答过，收起没选的。 */
  answer?: string;
  onChoice: (text: string) => void;
  onRetry: (text: string) => void;
  onOpenFile: (path: string) => void;
  onView: (view: ViewRequest) => void;
  onReverted: () => void;
  styles: Map<string, FilmStyle>;
  posterVersion: number;
  files: string[];
  mtimes: Map<string, number>;
  /** 每一轮推进到了哪几站（站名）。 */
  stations?: Record<string, string[]>;
}

function BlockView(props: BlockProps) {
  const { block } = props;
  if (block.kind === 'user') return <UserMessage event={block.event} />;
  if (block.kind === 'note')
    return <div className={'chat-note' + (block.event.kind === 'error' ? ' error' : '')}>{block.event.text}</div>;
  return <TurnView {...props} turn={block} />;
}

function UserMessage({ event }: { event: SessionEvent }) {
  const { body, extra } = splitAttachmentText(event.text ?? '');
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = body.split('\n').length > 6 || body.length > 280;
  return (
    <div className="user-stack msg-enter">
      <div className={'message user' + (long && !expanded ? ' clamped' : '')}>
        {body}
        {long && !expanded && (
          <button className="link expand" onClick={() => setExpanded(true)}>
            展开
          </button>
        )}
      </div>
      {extra && <p className="user-extra">{extra}</p>}
      <div className="message-actions">
        <span>{clockOf(event.time)}</span>
        <button
          className="icon-button"
          aria-label="复制"
          title="复制"
          onClick={() => {
            void navigator.clipboard?.writeText(body);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? '✓' : <Icon name="copy" size={12} />}
        </button>
      </div>
    </div>
  );
}

function clockOf(time?: string): string {
  if (!time) return '';
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const stateLabels: Record<TurnBlock['state'], string> = {
  running: '进行中',
  thinking: '思考中',
  done: '已完成',
  failed: '运行失败',
  stopped: '已停止',
  interrupted: '被中断',
};

/** 回复里写到的音频、图片、视频：直接在对话里试听、看。 */
function MediaStrip(props: { media: MediaRef[]; mtimes: Map<string, number>; onOpenFile: (path: string) => void }) {
  const images = props.media.filter((m) => m.kind === 'image');
  const others = props.media.filter((m) => m.kind !== 'image');
  return (
    <div className="media-strip" aria-label="回复里提到的媒体">
      {others.map((m) => {
        const src = rawURL(m.path, props.mtimes.get(m.path));
        const name = m.path.split('/').pop();
        return (
          <div key={m.path} className={'media-item ' + m.kind} data-ctx-file={m.path}>
            <button className="link media-name" title={m.path} onClick={() => props.onOpenFile(m.path)}>
              {name}
            </button>
            {m.kind === 'audio' ? <audio {...playerProps} preload="metadata" src={src} /> : <video {...playerProps} preload="metadata" src={src} />}
          </div>
        );
      })}
      {images.length > 0 && (
        <div className="media-images">
          {images.map((m) => (
            <a key={m.path} href={rawURL(m.path, props.mtimes.get(m.path))} target="_blank" rel="noreferrer" title={m.path} data-ctx-file={m.path}>
              <img src={rawURL(m.path, props.mtimes.get(m.path))} alt={m.path.split('/').pop()} loading="lazy" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 编排工具推荐的风格：海报、名字、用在哪（全片默认或某一段）与理由，点了把选择发回去。
 * 认不出的标识照样列出，只是没有图。
 */
function StylePicks(props: { picks: StylePick[]; styles: Map<string, FilmStyle>; version: number; enabled: boolean; onPick: (text: string) => void }) {
  return (
    <div className="style-picks film-styles" role="group" aria-label="推荐的整片风格">
      {props.picks.map((pick) => {
        const style = props.styles.get(pick.key);
        const [source, slug] = pick.key.split('/');
        const name = style ? style.cn : pick.key;
        return (
          <figure key={pick.key + '\u0000' + pick.scope} className={'style-pick' + (pick.scope ? ' scoped' : '')} data-style={pick.key} data-scope={pick.scope || undefined}>
            <a
              className="style-pick-poster"
              href={`/api/film-styles/${encodeURIComponent(source)}/${encodeURIComponent(slug)}/poster.jpg?size=full`}
              target="_blank"
              rel="noreferrer"
              title="看大图"
            >
              <Poster style={style ?? { source, slug, order: '', cn: pick.key, en: '', category_cn: source, category_en: '', uses: [], summary: '' }} version={props.version} />
            </a>
            <figcaption>
              <span className="style-pick-name">
                {name}
                {style?.en && <span className="style-pick-en">{style.en}</span>}
              </span>
              {pick.explicit && <span className="style-pick-scope">{pick.scope ? `只用在：${pick.scope}` : '全片默认风格'}</span>}
              <span className="style-pick-reason">{pick.reason || style?.summary || ''}</span>
              <button
                className="pill"
                disabled={!props.enabled}
                title={props.enabled ? '把这个选择发给 AI' : '只有最新一条回复的推荐可以点'}
                onClick={() => props.onPick(stylePickMessage(name, pick))}
              >
                {!pick.explicit ? '选这个风格' : pick.scope ? '用在这一段' : '设为整片风格'}
              </button>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/**
 * 点风格卡片发出的那句话；收起已答的选项时按它认出选的是哪个。
 * 全片默认、只给一段、不知道是哪种（回复里没有 film-styles 代码块）各是一种说法，不能都说成「整片风格」。
 */
function stylePickMessage(name: string, pick: StylePick): string {
  if (!pick.explicit) return `选「${name}」（${pick.key}）这个风格`;
  if (pick.scope) return `${pick.scope}用「${name}」风格（${pick.key}），其余镜头不变`;
  return `整片风格用「${name}」（${pick.key}）`;
}

/** blocks[index] 这一轮之后用户发的第一条消息（去掉引用、附件说明）。 */
function answerAfter(blocks: Block[], index: number): string | undefined {
  for (let i = index + 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === 'user') return splitAttachmentText(block.event.text ?? '').body.trim();
  }
  return undefined;
}

/**
 * 已经答过的选项：只留选中的那一个，其余收起，点开还能看（不能再点）。
 * 用户没点选项、自己打字回复时，整组收成一行。
 */
function AnsweredOptions(props: { picked?: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const others = props.picked ? props.count - 1 : props.count;
  return (
    <div className="answered-options">
      <div className="answered-line">
        {props.picked && (
          <span className="choice-picked" title="你选的">
            <Icon name="check" size={12} />
            {props.picked}
          </span>
        )}
        {others > 0 && (
          <button className="link answered-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '收起' : props.picked ? `另外 ${others} 个选项` : `${others} 个选项（你另外回复了）`}
          </button>
        )}
      </div>
      {open && <div className="answered-all">{props.children}</div>}
    </div>
  );
}

/** 切页请求的说法：「口播稿」「镜头 scene-003」「文件 production/treatment.md」。 */
function viewLabel(view: ViewRequest): string {
  const label = tabs.find(([id]) => id === view.page)?.[1] ?? stationPageLabel(view.page) ?? view.page;
  return view.target ? `${label} ${view.target}` : label;
}

/** 用户的回复是哪个选项：选项原样发出，风格推荐发的是 stylePickMessage。认不出返回 undefined。 */
function pickedOption(answer: string, choices: string[], picks: StylePick[], styles: Map<string, FilmStyle>): string | undefined {
  const choice = choices.find((c) => c.trim() === answer);
  if (choice) return choice;
  for (const pick of picks) {
    const name = styles.get(pick.key)?.cn ?? pick.key;
    if (stylePickMessage(name, pick) === answer) return pick.scope ? `${pick.scope}：${name}` : name;
  }
  return undefined;
}

function TurnView(props: BlockProps & { turn: TurnBlock }) {
  const { turn } = props;
  const live = turn.state === 'running' || turn.state === 'thinking';
  const elapsed = seconds(turn.start, turn.end?.time ?? props.now);
  const proseText = turn.prose.map((event) => event.text ?? '').join('\n\n');
  const choices = parseChoices(proseText);
  const picks = useMemo(() => parseStylePicks(proseText, new Set(props.styles.keys())), [proseText, props.styles]);
  const media = useMemo(() => findMedia(proseText, props.files), [proseText, props.files]);
  const answered = props.answer !== undefined && !props.choicesEnabled && choices.length + picks.length > 0;
  const picked = answered ? pickedOption(props.answer ?? '', choices, picks, props.styles) : undefined;
  const options = (
    <>
      {picks.length > 0 && (
        <StylePicks picks={picks} styles={props.styles} version={props.posterVersion} enabled={props.choicesEnabled} onPick={props.onChoice} />
      )}
      {choices.length > 0 && (
        <div className="choices" role="group" aria-label="选一个回复">
          {choices.map((choice, index) => (
            <button
              key={choice}
              className={'choice pill' + (index === 0 ? ' primary-pill' : '') + (choice === picked ? ' picked' : '')}
              disabled={!props.choicesEnabled}
              onClick={() => props.onChoice(choice)}
            >
              {choice}
            </button>
          ))}
        </div>
      )}
    </>
  );
  return (
    <div className="assistant-flow msg-enter">
      {(turn.process.length > 0 || live) && (
        <ExecutionShell turn={turn} live={live} elapsed={elapsed} projectPath={props.projectPath} onOpenFile={props.onOpenFile} />
      )}
      {proseText.trim() && (
        <div className="message assistant" data-ctx-label="回复" data-ctx-whole>
          <Markdown text={stripChoices(proseText)} />
        </div>
      )}
      {turn.views.some((view) => view.page) && (
        <div className="view-links" aria-label="请你看的页面">
          {turn.views.filter((view) => view.page).map((view, index) => (
            <button key={index} className="view-link" onClick={() => props.onView(view)} title="打开这一页">
              <span className="view-arrow" aria-hidden="true">↗</span>
              <span className="view-page">{viewLabel(view)}</span>
              {view.note && <span className="view-note">{view.note}</span>}
            </button>
          ))}
        </div>
      )}
      {media.length > 0 && <MediaStrip media={media} mtimes={props.mtimes} onOpenFile={props.onOpenFile} />}
      {answered ? (
        <AnsweredOptions picked={picked} count={choices.length + picks.length}>
          {options}
        </AnsweredOptions>
      ) : (
        options
      )}
      {turn.end && <TurnEnd {...props} elapsed={elapsed} />}
    </div>
  );
}

function ExecutionShell(props: {
  turn: TurnBlock;
  live: boolean;
  elapsed: number;
  projectPath: string;
  onOpenFile: (path: string) => void;
}) {
  const { turn, live } = props;
  // 跟随这一轮的状态（进行中展开、结束收起），直到用户自己点过。
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const lifecycleOpen = live || turn.state === 'stopped';
  const open = userOpen ?? lifecycleOpen;
  const label = stateLabels[turn.state];
  return (
    <details
      className={'shell ' + turn.state}
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) {
          setUserOpen(next);
        }
      }}
    >
      <summary>
        {live && <span className="orb" aria-hidden="true" />}
        <span className={live ? 'shimmer' : 'shell-label'}>{label}</span>
        {turn.state === 'thinking' && (
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        {!live && <span className="shell-meta">· {formatElapsed(props.elapsed)}</span>}
        <span className="spacer" />
        {live && <span className="shell-time">{formatElapsed(props.elapsed)}</span>}
        <Icon name="chevron" size={11} />
      </summary>
      <div className="shell-body">
        {turn.process.length === 0 && <p className="muted small">正在启动 AI…</p>}
        {turn.process.map((item, index) => (
          <ProcessRow key={index} item={item} projectPath={props.projectPath} onOpenFile={props.onOpenFile} />
        ))}
      </div>
    </details>
  );
}

function ProcessRow({ item, projectPath, onOpenFile }: { item: ProcessItem; projectPath: string; onOpenFile: (path: string) => void }) {
  switch (item.type) {
    case 'step':
      return (
        <div className="step-row">
          <span className="step-index">
            {item.index}/{item.total}
          </span>
          {item.text}
        </div>
      );
    case 'thinking':
      return <ThinkingRow text={item.event.text ?? ''} live={!item.until} duration={seconds(item.event.time, item.until)} />;
    case 'text':
      return (
        <div className="process-text">
          <Markdown text={item.event.text ?? ''} />
        </div>
      );
    case 'note':
      return <div className={'chat-note' + (item.event.kind === 'error' ? ' error' : '')}>{item.event.text}</div>;
    case 'tool':
      return <ToolRow call={item.call} result={item.result} projectPath={projectPath} onOpenFile={onOpenFile} />;
  }
}

function ThinkingRow({ text, live, duration }: { text: string; live: boolean; duration: number }) {
  return (
    <details className="tool thinking-row" open={live}>
      <summary>
        {live ? <span className="orb small" aria-hidden="true" /> : <Icon name="brain" size={14} />}
        <span className={live ? 'shimmer' : ''}>{live ? '思考中…' : '思考过程'}</span>
        <span className="spacer" />
        {!live && <span className="tool-meta">{formatElapsed(duration)}</span>}
      </summary>
      <div className="thinking-body">
        <Markdown text={text} />
      </div>
    </details>
  );
}

function ToolRow(props: { call: SessionEvent; result?: SessionEvent; projectPath: string; onOpenFile: (path: string) => void }) {
  const { call, result } = props;
  const state = !result ? 'running' : result.is_error ? 'failed' : 'done';
  const info = describeTool(call.tool ?? '', call.input ?? result?.input);
  const path = info.path ? relativePath(info.path, props.projectPath) : '';
  const output = result?.text ?? '';
  const foldable = info.command || output !== '';
  const head = (
    <>
      <StatusMark state={state} />
      <span className="tool-verb">{info.verb}</span>
      {path && !path.startsWith('/') ? (
        <button
          className="tool-target link mono ellipsis"
          onClick={(e) => {
            e.preventDefault();
            props.onOpenFile(path);
          }}
        >
          {path}
        </button>
      ) : (
        <span className="tool-target mono ellipsis">{path || info.target}</span>
      )}
      <span className="spacer" />
      {state === 'failed' && <span className="tool-failed">失败</span>}
      {result && <span className="tool-meta">{formatElapsed(seconds(call.time, result.time))}</span>}
    </>
  );
  if (!foldable) return <div className={'tool ' + state}>{head}</div>;
  return (
    <details className={'tool ' + state} open={state === 'failed'}>
      <summary>{head}</summary>
      <pre className="terminal">
        {info.command && <span className="prompt-sign">$ </span>}
        {info.command && (info.full ?? info.target) + (output ? '\n' : '')}
        {output}
      </pre>
    </details>
  );
}

function relativePath(path: string, project: string): string {
  if (project && path.startsWith(project + '/')) return path.slice(project.length + 1);
  return path;
}

function StatusMark({ state }: { state: 'running' | 'done' | 'failed' | 'pending' | 'in_progress' | 'completed' }) {
  if (state === 'running' || state === 'in_progress') return <span className="mark running" aria-label="进行中" />;
  if (state === 'failed')
    return (
      <span className="mark fail" aria-label="失败">
        ×
      </span>
    );
  if (state === 'done' || state === 'completed')
    return (
      <span className="mark ok" aria-label="完成">
        ✓
      </span>
    );
  return <span className="mark pending" aria-label="未开始" />;
}

const changeLabels = { added: '新增', modified: '修改', deleted: '删除' } as const;

function TurnEnd(props: BlockProps & { turn: TurnBlock; elapsed: number }) {
  const { turn } = props;
  const end = turn.end!;
  const changes = end.changes ?? [];
  const [expanded, setExpanded] = useState(false);
  const [diffPath, setDiffPath] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const tokens = turn.usage ? (turn.usage.input_tokens ?? 0) + (turn.usage.output_tokens ?? 0) : 0;
  const revert = async () => {
    setWorking(true);
    setError('');
    try {
      await post(`/api/turns/${end.turn_id}/revert`);
      props.onReverted();
    } catch (err) {
      const paths = err instanceof ApiError && Array.isArray(err.body.paths) ? `：${(err.body.paths as string[]).join('、')}` : '';
      setError(errorText(err) + paths);
    } finally {
      setWorking(false);
    }
  };
  const shown = expanded ? changes : changes.slice(0, 4);
  const retryText = turn.user ? splitAttachmentText(turn.user.text ?? '').body : '';
  return (
    <div className="turn-end">
      {(turn.state === 'failed' || turn.state === 'interrupted') && (
        <section className="error-card" role="alert">
          <h4>
            <Icon name="alert" size={14} />
            {turn.state === 'failed' ? '运行失败' : '这一轮被中断了'}
          </h4>
          {end.text && <p>{end.text}</p>}
          {turn.state === 'interrupted' && !end.text && <p>Studio 重启时这一轮还在进行，AI 的进程已经不在了。</p>}
          {retryText && (
            <div className="actions">
              <button className="pill primary-pill" onClick={() => props.onRetry(retryText)}>
                重试
              </button>
            </div>
          )}
        </section>
      )}
      {turn.state === 'stopped' && (
        <p className="pause-line">
          <Icon name="pause" size={12} />
          已停止这一轮
        </p>
      )}
      {changes.length > 0 && (
        <section className={'files-card turn-card' + (turn.reverted ? ' reverted' : '')} id={'turn-' + end.turn_id}>
          <header>
            <Icon name="file" size={12} />
            <span className="files-label">{turn.reverted ? '已回退这一轮' : '本轮改动'}</span>
            <span className="count">{changes.length}</span>
            <span className="files-summary ellipsis">{changes.map((c) => c.path.split('/').pop()).join('、')}</span>
            {!turn.reverted && (
              <button className="pill revert" id="revert-turn" disabled={working} onClick={revert}>
                回退本轮
              </button>
            )}
          </header>
          <ul>
            {shown.map((change) => (
              <li key={change.path}>
                <span className={'change ' + change.change}>{changeLabels[change.change]}</span>
                <button
                  className="link mono ellipsis"
                  onClick={() => (change.revertable ? setDiffPath(change.path) : props.onOpenFile(change.path))}
                  title={change.revertable ? '查看改动' : '媒体或大文件：只列出，不回退'}
                >
                  {change.path}
                </button>
                {!change.revertable && <span className="muted small">不回退</span>}
              </li>
            ))}
          </ul>
          {changes.length > 4 && (
            <button className="link small more" onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起' : `还有 ${changes.length - 4} 个文件`}
            </button>
          )}
          {error && <p className="error-line">{error}</p>}
          {diffPath && <DiffDialog turnId={end.turn_id ?? ''} path={diffPath} onClose={() => setDiffPath('')} />}
        </section>
      )}
      {turn.state === 'done' && (
        <footer className={'done-line' + (props.latest ? ' latest' : '')}>
          <span>✓ 已完成</span>
          <span>{formatElapsed(props.elapsed)}</span>
          {tokens > 0 && <span className="mono">{tokens.toLocaleString()} tokens</span>}
          {changes.length === 0 && <span>没有改动项目文件</span>}
          {(props.stations?.[end.turn_id ?? ''] ?? []).length > 0 && (
            <span className="turn-stations" title="这一轮推进到的制作环节">
              → {props.stations![end.turn_id ?? ''].join(' · ')}
            </span>
          )}
          <span>{clockOf(end.time)}</span>
        </footer>
      )}
    </div>
  );
}

function PlanPill({ plan, scenes }: { plan: PlanItem[]; scenes: Scene[] }) {
  const current = plan.findIndex((item) => item.status === 'in_progress');
  const done = plan.filter((item) => item.status === 'completed').length;
  const step = current >= 0 ? current + 1 : Math.min(done + 1, plan.length);
  const rendered = scenes.filter((scene) => scene.exists && !scene.stale).length;
  const rendering = scenes.filter((scene) => scene.rendering);
  return (
    <div className="plan-pill-wrap">
      <button className="float-pill plan-pill" aria-label={`进度：第 ${step}/${plan.length} 步`}>
        <span className="orb tiny" aria-hidden="true" />第 {step}/{plan.length} 步
        {current >= 0 && <span className="plan-current ellipsis">{plan[current].text}</span>}
      </button>
      <div className="popover plan-popover" role="tooltip">
        <ol>
          {plan.map((item, index) => (
            <li key={index} className={item.status}>
              <StatusMark state={item.status} />
              <span>{item.text}</span>
            </li>
          ))}
        </ol>
        {scenes.length > 0 && (
          <p className="plan-scenes">
            镜头已出片 {rendered}/{scenes.length}
            {rendering.length > 0 && ` · 渲染中：${rendering.map((scene) => scene.id).join('、')}`}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 编排工具在等你批准的调用。claude 在客户端里遇到白名单外的命令时会停在这里，直到你回答；
 * 「以后都允许」把命令前缀记进这个项目，之后同样的命令不再问；「以后都不用问」打开设置里的自动批准，什么命令都不再问。
 */
function PermissionStack({ asks, onAnswer }: { asks: PermissionAsk[]; onAnswer: (ask: PermissionAsk, decision: 'allow' | 'always' | 'deny' | 'auto') => void }) {
  return (
    <section className="permission-stack" aria-label={`等你批准的操作 ${asks.length} 条`}>
      {asks.map((ask) => (
        <div key={ask.id} className="permission-card" data-permission={ask.id}>
          <div className="permission-head">
            <span className="permission-badge">要你批准</span>
            <span className="permission-what">{ask.description || (ask.command ? '运行一条命令' : `使用 ${ask.tool_name ?? '工具'}`)}</span>
          </div>
          {ask.command ? (
            <code className="permission-command">{ask.command}</code>
          ) : (
            <code className="permission-command">{JSON.stringify(ask.input ?? {}).slice(0, 400)}</code>
          )}
          <div className="permission-actions">
            <button className="primary" onClick={() => onAnswer(ask, 'allow')}>
              允许
            </button>
            {ask.suggestion && (
              <button onClick={() => onAnswer(ask, 'always')} title="记进这个项目，以后不再问">
                以后都允许 <code>{ask.suggestion}</code>
              </button>
            )}
            <button onClick={() => onAnswer(ask, 'auto')} title="打开设置里的「自动批准」：以后所有项目都不再问，直接允许；可以在设置里关掉">
              以后都不用问
            </button>
            <button className="ghost" onClick={() => onAnswer(ask, 'deny')}>
              拒绝
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function QueuedStack({ queue, onAction }: { queue: QueuedMessage[]; onAction: (item: QueuedMessage, action: 'steer' | 'remove' | 'edit') => void }) {
  return (
    <section className="queue-stack" aria-label={`排队中的消息 ${queue.length} 条`}>
      {queue.map((item, index) => (
        <div key={item.id} className="queue-card" data-depth={Math.min(queue.length - 1 - index, 3)} style={{ '--depth': String(Math.min(queue.length - 1 - index, 3)) } as CSSProperties}>
          <span className="queue-badge">排队</span>
          <span className="queue-text ellipsis">{splitAttachmentText(item.text).body}</span>
          <button className="queue-action steer" onClick={() => onAction(item, 'steer')} title="停掉这一轮，马上发出排队的消息">
            <Icon name="up" size={11} />
            引导对话
          </button>
          <button className="icon-button" onClick={() => onAction(item, 'edit')} aria-label="编辑" title="拿回输入框修改">
            <Icon name="edit" size={12} />
          </button>
          <button className="icon-button" onClick={() => onAction(item, 'remove')} aria-label="移除" title="不发这条了">
            <Icon name="trash" size={12} />
          </button>
        </div>
      ))}
    </section>
  );
}

function AttachmentTray({ attachments, onRemove }: { attachments: Attachment[]; onRemove: (index: number) => void }) {
  return (
    <ul className="tray" id="attachments">
      {attachments.map((a, index) => {
        const image = a.path && (!a.upload || /\.(png|jpe?g|webp|gif)$/i.test(a.path));
        if (a.quote || a.ref) {
          const title = a.quote ? a.label || '引用' : a.scene_id ? `镜头 ${a.scene_id}` : a.source ?? '';
          const meta = a.quote ? a.quote.replace(/\s+/g, ' ') : a.scene_id ? '镜头' : '文件';
          return (
            <li key={index} className="doc-card quote-card" title={a.quote ? `${title}\n${a.quote}` : title}>
              <span className="quote-mark" aria-hidden="true">{a.quote ? '❝' : a.scene_id ? <Icon name="film" size={14} /> : <Icon name="file" size={14} />}</span>
              <span className="doc-text">
                <span className="doc-name">{title}</span>
                <span className="doc-meta">{meta}</span>
              </span>
              <button className="remove" onClick={() => onRemove(index)} aria-label="移除引用">
                <Icon name="close" size={9} />
              </button>
            </li>
          );
        }
        const title = a.upload ? a.name ?? '文件' : a.scene_id ?? '画面';
        const meta = a.upload
          ? formatSize(a.size ?? 0)
          : [a.seconds !== undefined && a.path ? `帧 ${Math.round(a.seconds * 30)}` : '', a.region ? '圈选区域' : '', a.selector ?? '']
              .filter(Boolean)
              .join(' · ');
        return (
          <li key={index} className={image ? 'image-card' : 'doc-card'} title={`${title}${meta ? ' · ' + meta : ''}`}>
            {image ? (
              <>
                <img src={rawURL(a.path!)} alt="" />
                {!a.upload && <span className="image-label">{[title, meta].filter(Boolean).join(' · ')}</span>}
              </>
            ) : (
              <>
                <Icon name="file" size={15} />
                <span className="doc-text">
                  <span className="doc-name">{title}</span>
                  <span className="doc-meta">{meta}</span>
                </span>
              </>
            )}
            <button className="remove" onClick={() => onRemove(index)} aria-label="移除附件">
              <Icon name="close" size={9} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}

function HistoryMenu(props: { sessions: SessionMeta[]; current: string; onPick: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.parentElement?.contains(e.target as Node)) props.onClose();
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  const list = props.sessions.filter((s) => !query || s.title.includes(query));
  return (
    <div className="popover menu history-menu" ref={box} role="menu">
      <div className="history-search">
        <input autoFocus value={query} placeholder="搜索会话" aria-label="搜索会话" onChange={(e) => setQuery(e.currentTarget.value)} />
        <button className="icon-button" onClick={() => props.onPick('')} aria-label="新对话" title="新对话">
          <Icon name="plus" size={12} />
        </button>
      </div>
      {list.length === 0 && <p className="muted small empty">没有会话</p>}
      {list.map((s) => (
        <button key={s.session_id} role="menuitem" className={'history-row' + (s.session_id === props.current ? ' on' : '')} onClick={() => props.onPick(s.session_id)}>
          <span className="ellipsis">{s.title}</span>
          <span className="muted small">
            {s.kind === 'production' ? '整片制作 · ' : ''}
            {s.turns.length} 轮 · {new Date(s.updated_at).toLocaleString()}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * 「接下来」：在等你的时候，对话顶上那一行下面展开一张卡片，说清现在该做什么，带几个按钮。
 * AI 在做时不展开（那一行已经写着「AI 在做」）。点 × 收起这一次，换到下一站或下一种状态时再出现。
 */
function NextStep({ guide, disabled, onAction }: { guide: Guide | null; disabled: boolean; onAction: (action: GuideAction) => void }) {
  const key = guide ? guide.title + '|' + guide.text : '';
  const [hidden, setHidden] = useState('');
  // 插件的操作对外、不能撤回：点了先在卡片上问一次，用户点「执行」才跑。
  const [confirming, setConfirming] = useState<Extract<GuideAction, { kind: 'op' }> | null>(null);
  if (!guide || !guide.waiting || hidden === key) return null;
  return (
    <section className="next-step" id="next-step" aria-label="接下来">
      <div className="ns-head">
        <span className="ns-kicker">接下来</span>
        <strong>{guide.title}</strong>
        <span className="spacer" />
        <button className="icon-button" aria-label="收起" title="收起" onClick={() => setHidden(key)}>
          <Icon name="close" size={10} />
        </button>
      </div>
      <p>{guide.text}</p>
      {confirming && (
        <div className="ns-confirm" role="alertdialog" aria-label="确认执行">
          <span>执行插件操作「{confirming.summary}」？</span>
          <button
            className="primary"
            disabled={disabled}
            onClick={() => {
              onAction(confirming);
              setConfirming(null);
            }}
          >
            执行
          </button>
          <button onClick={() => setConfirming(null)}>取消</button>
        </div>
      )}
      {guide.actions.length > 0 && !confirming && (
        <div className="ns-actions">
          {guide.actions.map((action) => (
            <button
              key={action.label}
              // 推进制作的（确认、开工、发话）是主按钮；开页面、填输入框是次要的。
              className={action.kind === 'page' || action.kind === 'draft' ? '' : 'primary'}
              disabled={disabled && action.kind !== 'page' && action.kind !== 'draft'}
              onClick={() => (action.kind === 'op' ? setConfirming(action) : onAction(action))}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** 对话顶上的一行：现在在制作路线的哪一站、在等谁；点开制作路线。 */
function ProgressStrip({ progress, onOpen }: { progress: ProgressState | null; onOpen: () => void }) {
  const { station, text } = currentSummary(progress);
  if (!progress || !text) return null;
  const waiting = progress.waiting_on === 'user' || station?.status === 'changed';
  return (
    <button className={'progress-strip' + (waiting ? ' waiting' : '')} id="progress-strip" onClick={onOpen} title="打开制作路线">
      {station && !waiting ? <span className="orb tiny" aria-hidden="true" /> : <span className={'ps-dot' + (station ? '' : ' done')} aria-hidden="true" />}
      {station ? (
        <>
          <span className="ps-label">现在 · {station.label}</span>
          <span className="ps-text">{text}</span>
        </>
      ) : (
        <span className="ps-label">{text}</span>
      )}
      <span className="spacer" />
      <span className="ps-open">制作路线</span>
      <Icon name="next" size={10} />
    </button>
  );
}
