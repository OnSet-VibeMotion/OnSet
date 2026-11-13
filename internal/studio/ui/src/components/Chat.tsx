import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, ApiError, errorText, post, rawURL } from '../api';
import type { AgentChoice, AgentsResponse, Attachment, EventKind, PlanItem, Scene, SessionEvent, SessionMeta, ViewRequest, ViewState } from '../types';
import { tabs } from './Preview';
import { Poster, styleKey, useFilmStyles } from './FilmStyles';
import type { FilmStyle } from '../types';
import { AgentPicker } from './AgentPicker';
import { DiffDialog } from './DiffDialog';
import { Icon } from './Icon';
import { Markdown } from './chat/Markdown';
import {
  buildBlocks,
  describeTool,
  formatElapsed,
  parseChoices,
  parseStylePicks,
  type StylePick,
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
  /** 项目里的文件（@ 补全用）。 */
  files: string[];
  /** 触发一个写任务（/render 这类命令用）。 */
  run: (path: string, payload?: Record<string, unknown>) => void;
}

/** 视为「在底部」的容差：比这近就继续跟随新消息。 */
const BOTTOM_TOLERANCE = 8;

export function Chat(props: Props) {
  const events = useSessionEvents(props.sessionId, props.onFilesChanged, props.onTurnEnd, props.onView);
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
  // 整片风格目录：回复里推荐风格时按标识找名字与海报。
  const filmStyles = useFilmStyles(!!props.sessionId);
  const styleIndex = useMemo(() => new Map((filmStyles.data?.styles ?? []).map((style) => [styleKey(style), style])), [filmStyles.data]);
  const queue = useMemo(() => queuedMessages(events), [events]);
  const lastTurn = [...blocks].reverse().find((b): b is TurnBlock => b.kind === 'turn');
  const running = !!lastTurn && !lastTurn.end;
  const plan = running ? lastTurn?.plan ?? null : null;
  const now = useNow(running);

  // 这一轮进行中照样能发：消息排到这一轮之后。别的写任务占着项目时不能发。
  const blocked = sending || (props.busy !== '' && !running);
  const session = props.sessions.find((s) => s.session_id === props.sessionId);

  // 跟随到底：只有用户在底部（8px 内）时才跟；展开折叠项时不跳。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following.current && el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight;
  }, [blocks, queue.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANCE;
    following.current = bottom;
    setAtBottom(bottom);
    setScrolled(el.scrollTop > 1);
  };

  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    following.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
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

  const completion = { scenes: props.scenes.map((s) => s.id), files: props.files };
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
  const choiceTurn = !running && queue.length === 0 && blocks[blocks.length - 1]?.kind === 'turn' ? lastTurn?.id : undefined;
  const canSend = !blocked && draft.trim() !== '';
  // 刚发出的一刻不换成停止键：按钮就在指针底下，连点两下会把这一轮停掉。
  const showStop = running && !draft.trim() && !sending;

  return (
    <aside class="pane right chat">
      <header class="chat-header">
        <div class="history">
          <button
            class="icon-button"
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
        <span class="chat-title ellipsis" id="session-title" title={session?.title}>
          {session ? `${session.title}${session.kind === 'production' ? ' · 整片制作' : ''}` : '新对话'}
        </span>
        <span class="spacer" />
        {props.sessionId && (
          <button class="icon-button" onClick={() => props.onSession('')} aria-label="新对话" title="新对话">
            <Icon name="plus" size={13} />
          </button>
        )}
        <button id="start-production" class="primary pill" disabled={blocked || running} onClick={() => void startProduction()} title="与 am run 相同的整片制作">
          开始制作
        </button>
      </header>

      <div class={'chat-log-wrap' + (scrolled ? ' edge' : '')}>
        <div class={'chat-log' + (plan ? ' has-plan' : '')} id="messages" ref={scroller} onScroll={onScroll}>
          {events.length === 0 && (
            <div class="intro">
              <h3>说说要做什么</h3>
              <p>编排工具会直接改项目文件，每一轮的改动都能查看和回退。</p>
              <p class="muted">
                新项目先点「开始制作」：还没有定稿字幕时照 PROMPT-PRODUCTION.md 从文章开始做到成片，已有 transcription.srt 时照 PROMPT.md
                从字幕开始。之后在同一个会话里继续改。文章、图片和音频可以直接拖进输入框。
              </p>
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
              onChoice={(text) => void deliver(text, [])}
              onRetry={(text) => void deliver(text, [])}
              onOpenFile={props.onOpenFile}
              onView={props.onView}
              styles={styleIndex}
              posterVersion={filmStyles.posterVersion}
              onReverted={props.onTurnEnd}
              onToggle={() => (following.current = false)}
            />
          ))}
        </div>
        <div class="chat-float">
          {!atBottom ? (
            <button class="float-pill jump" onClick={jumpToLatest}>
              <Icon name="down" size={12} />
              回到最新
            </button>
          ) : (
            plan && <PlanPill plan={plan} scenes={props.scenes} />
          )}
        </div>
      </div>

      {queue.length > 0 && <QueuedStack queue={queue} onAction={queueAction} />}

      <footer class="composer">
        <div
          class={'composer-shell' + (dragging ? ' dragging' : '')}
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
            <ul class="completions" id="completions" role="listbox" aria-label={token.trigger === '@' ? '引用镜头或文件' : '命令'}>
              <li class="completions-head" aria-hidden="true">
                {token.trigger === '@' ? '引用镜头或文件，发送时一起交给编排工具' : token.command ? `/${token.command.name} 的参数` : '命令'}
              </li>
              {suggestions.map((item, index) => (
                <li
                  key={item.kind + item.value}
                  role="option"
                  aria-selected={index === picked}
                  class={'completion' + (index === picked ? ' on' : '')}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(item);
                  }}
                  onMouseEnter={() => setPicked(index)}
                >
                  <span class={'completion-kind ' + item.kind} aria-hidden="true">
                    {item.kind === 'command' ? '/' : item.kind === 'scene' ? <Icon name="film" size={12} /> : item.kind === 'page' ? '↗' : <Icon name="file" size={12} />}
                  </span>
                  <span class="completion-label">{item.label}</span>
                  {item.hint && <span class="completion-hint">{item.hint}</span>}
                </li>
              ))}
              <li class="completions-foot" aria-hidden="true">
                ↑↓ 选择 · Enter / Tab 确定 · Esc 收起
              </li>
            </ul>
          )}
          <label for="prompt" class="sr-only">
            消息
          </label>
          <textarea
            id="prompt"
            ref={textarea}
            rows={2}
            value={draft}
            placeholder={running ? '补充要求会排在这一轮之后…' : '说说要改什么，可以拖入或粘贴文章、图片、音频'}
            onInput={(e) => {
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
              const composing = e.isComposing || e.keyCode === 229;
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
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                if (canSend) void send();
              }
            }}
          />
          <div class="composer-toolbar">
            <div class="plus">
              <button
                class="icon-button"
                id="plus"
                aria-label="添加"
                title="添加文件"
                aria-expanded={menu === 'plus'}
                onClick={() => setMenu(menu === 'plus' ? '' : 'plus')}
              >
                <Icon name="plus" size={13} />
              </button>
              {menu === 'plus' && (
                <div class="popover menu up" role="menu">
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
                    <span class="muted small">也可以拖进来或粘贴</span>
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
            <span class="spacer" />
            {showStop ? (
              <button id="cancel-turn" class="primary-slot stop" onClick={cancel} aria-label="停止本轮" title="停止本轮（排队的消息一并作废）">
                <span class="stop-glyph" />
              </button>
            ) : (
              <button
                id="send"
                class="primary-slot"
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
          <p class={'composer-hint' + (error ? ' error' : '')}>{error || (uploading ? '上传中…' : `项目正忙：${props.busy}`)}</p>
        )}
      </footer>
    </aside>
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

/** 订阅一个会话的事件流。EventSource 断线后自带 Last-Event-ID 重连，后端按 seq 补发，这里再按 seq 去重。 */
function useSessionEvents(
  sessionId: string,
  onFilesChanged: (files: string[]) => void,
  onTurnEnd: () => void,
  onView: (view: ViewRequest) => void,
) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const callbacks = useRef({ onFilesChanged, onTurnEnd, onView });
  callbacks.current = { onFilesChanged, onTurnEnd, onView };

  useEffect(() => {
    setEvents([]);
    if (!sessionId) return;
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
    const source = new EventSource(`/api/sessions/${sessionId}/events`);
    const handle = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as SessionEvent;
      if (event.seq <= last) return;
      last = event.seq;
      pending.push(event);
      if (!frame) frame = requestAnimationFrame(flush);
      if (event.kind === 'files-changed' && event.files) callbacks.current.onFilesChanged(event.files);
      if (event.kind === 'turn-end') callbacks.current.onTurnEnd();
      // 只执行刚发生的切页请求：打开会话时重放的历史不该把页面切来切去。
      if (event.kind === 'view' && event.view && Date.now() - Date.parse(event.time) < viewFreshMs) callbacks.current.onView(event.view);
    };
    for (const kind of kinds) source.addEventListener(kind, handle as EventListener);
    return () => {
      source.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sessionId]);

  return events;
}

interface BlockProps {
  block: Block;
  latest: boolean;
  now: number;
  projectPath: string;
  choicesEnabled: boolean;
  onChoice: (text: string) => void;
  onRetry: (text: string) => void;
  onOpenFile: (path: string) => void;
  onView: (view: ViewRequest) => void;
  onReverted: () => void;
  onToggle: () => void;
  styles: Map<string, FilmStyle>;
  posterVersion: number;
}

function BlockView(props: BlockProps) {
  const { block } = props;
  if (block.kind === 'user') return <UserMessage event={block.event} />;
  if (block.kind === 'note')
    return <div class={'chat-note' + (block.event.kind === 'error' ? ' error' : '')}>{block.event.text}</div>;
  return <TurnView {...props} turn={block} />;
}

function UserMessage({ event }: { event: SessionEvent }) {
  const { body, extra } = splitAttachmentText(event.text ?? '');
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = body.split('\n').length > 6 || body.length > 280;
  return (
    <div class="user-stack msg-enter">
      <div class={'message user' + (long && !expanded ? ' clamped' : '')}>
        {body}
        {long && !expanded && (
          <button class="link expand" onClick={() => setExpanded(true)}>
            展开
          </button>
        )}
      </div>
      {extra && <p class="user-extra">{extra}</p>}
      <div class="message-actions">
        <span>{clockOf(event.time)}</span>
        <button
          class="icon-button"
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

/** 编排工具推荐的整片风格：海报、名字与理由，点了把选择发回去。认不出的标识照样列出，只是没有图。 */
function StylePicks(props: { picks: StylePick[]; styles: Map<string, FilmStyle>; version: number; enabled: boolean; onPick: (text: string) => void }) {
  return (
    <div class="style-picks film-styles" role="group" aria-label="推荐的整片风格">
      {props.picks.map((pick) => {
        const style = props.styles.get(pick.key);
        const [source, slug] = pick.key.split('/');
        const name = style ? style.cn : pick.key;
        return (
          <figure key={pick.key} class="style-pick" data-style={pick.key}>
            <a
              class="style-pick-poster"
              href={`/api/film-styles/${encodeURIComponent(source)}/${encodeURIComponent(slug)}/poster.jpg?size=full`}
              target="_blank"
              rel="noreferrer"
              title="看大图"
            >
              <Poster style={style ?? { source, slug, order: '', cn: pick.key, en: '', category_cn: source, category_en: '', uses: [], summary: '' }} version={props.version} />
            </a>
            <figcaption>
              <span class="style-pick-name">
                {name}
                {style?.en && <span class="style-pick-en">{style.en}</span>}
              </span>
              <span class="style-pick-reason">{pick.reason || style?.summary || ''}</span>
              <button
                class="pill"
                disabled={!props.enabled}
                title={props.enabled ? '把这个选择发给编排工具' : '只有最新一条回复的推荐可以点'}
                onClick={() => props.onPick(`整片风格用「${name}」（${pick.key}）`)}
              >
                用这个风格
              </button>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/** 切页请求的说法：「口播稿」「镜头 scene-003」「文件 production/treatment.md」。 */
function viewLabel(view: ViewRequest): string {
  const label = tabs.find(([id]) => id === view.page)?.[1] ?? view.page;
  return view.target ? `${label} ${view.target}` : label;
}

function TurnView(props: BlockProps & { turn: TurnBlock }) {
  const { turn } = props;
  const live = turn.state === 'running' || turn.state === 'thinking';
  const elapsed = seconds(turn.start, turn.end?.time ?? props.now);
  const proseText = turn.prose.map((event) => event.text ?? '').join('\n\n');
  const choices = parseChoices(proseText);
  const picks = useMemo(() => parseStylePicks(proseText, new Set(props.styles.keys())), [proseText, props.styles]);
  return (
    <div class="assistant-flow msg-enter">
      {(turn.process.length > 0 || live) && (
        <ExecutionShell turn={turn} live={live} elapsed={elapsed} projectPath={props.projectPath} onOpenFile={props.onOpenFile} onToggle={props.onToggle} />
      )}
      {proseText.trim() && (
        <div class="message assistant" data-ctx-label="回复" data-ctx-whole>
          <Markdown text={stripChoices(proseText)} />
        </div>
      )}
      {turn.views.length > 0 && (
        <div class="view-links" aria-label="请你看的页面">
          {turn.views.map((view, index) => (
            <button key={index} class="view-link" onClick={() => props.onView(view)} title="打开这一页">
              <span class="view-arrow" aria-hidden="true">↗</span>
              <span class="view-page">{viewLabel(view)}</span>
              {view.note && <span class="view-note">{view.note}</span>}
            </button>
          ))}
        </div>
      )}
      {picks.length > 0 && (
        <StylePicks picks={picks} styles={props.styles} version={props.posterVersion} enabled={props.choicesEnabled} onPick={props.onChoice} />
      )}
      {choices.length > 0 && (
        <div class="choices" role="group" aria-label="选一个回复">
          {choices.map((choice, index) => (
            <button
              key={choice}
              class={'choice pill' + (index === 0 ? ' primary-pill' : '')}
              disabled={!props.choicesEnabled}
              onClick={() => props.onChoice(choice)}
            >
              {choice}
            </button>
          ))}
        </div>
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
  onToggle: () => void;
}) {
  const { turn, live } = props;
  // 跟随这一轮的状态（进行中展开、结束收起），直到用户自己点过。
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const lifecycleOpen = live || turn.state === 'stopped';
  const open = userOpen ?? lifecycleOpen;
  const label = stateLabels[turn.state];
  return (
    <details
      class={'shell ' + turn.state}
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) {
          props.onToggle();
          setUserOpen(next);
        }
      }}
    >
      <summary>
        {live && <span class="orb" aria-hidden="true" />}
        <span class={live ? 'shimmer' : 'shell-label'}>{label}</span>
        {turn.state === 'thinking' && (
          <span class="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        {!live && <span class="shell-meta">· {formatElapsed(props.elapsed)}</span>}
        <span class="spacer" />
        {live && <span class="shell-time">{formatElapsed(props.elapsed)}</span>}
        <Icon name="chevron" size={11} />
      </summary>
      <div class="shell-body">
        {turn.process.length === 0 && <p class="muted small">正在启动编排工具…</p>}
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
        <div class="step-row">
          <span class="step-index">
            {item.index}/{item.total}
          </span>
          {item.text}
        </div>
      );
    case 'thinking':
      return <ThinkingRow text={item.event.text ?? ''} live={!item.until} duration={seconds(item.event.time, item.until)} />;
    case 'text':
      return (
        <div class="process-text">
          <Markdown text={item.event.text ?? ''} />
        </div>
      );
    case 'note':
      return <div class={'chat-note' + (item.event.kind === 'error' ? ' error' : '')}>{item.event.text}</div>;
    case 'tool':
      return <ToolRow call={item.call} result={item.result} projectPath={projectPath} onOpenFile={onOpenFile} />;
  }
}

function ThinkingRow({ text, live, duration }: { text: string; live: boolean; duration: number }) {
  return (
    <details class="tool thinking-row" open={live}>
      <summary>
        {live ? <span class="orb small" aria-hidden="true" /> : <Icon name="brain" size={14} />}
        <span class={live ? 'shimmer' : ''}>{live ? '思考中…' : '思考过程'}</span>
        <span class="spacer" />
        {!live && <span class="tool-meta">{formatElapsed(duration)}</span>}
      </summary>
      <div class="thinking-body">
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
      <span class="tool-verb">{info.verb}</span>
      {path && !path.startsWith('/') ? (
        <button
          class="tool-target link mono ellipsis"
          onClick={(e) => {
            e.preventDefault();
            props.onOpenFile(path);
          }}
        >
          {path}
        </button>
      ) : (
        <span class="tool-target mono ellipsis">{path || info.target}</span>
      )}
      <span class="spacer" />
      {state === 'failed' && <span class="tool-failed">失败</span>}
      {result && <span class="tool-meta">{formatElapsed(seconds(call.time, result.time))}</span>}
    </>
  );
  if (!foldable) return <div class={'tool ' + state}>{head}</div>;
  return (
    <details class={'tool ' + state} open={state === 'failed'}>
      <summary>{head}</summary>
      <pre class="terminal">
        {info.command && <span class="prompt-sign">$ </span>}
        {info.command && info.target + (output ? '\n' : '')}
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
  if (state === 'running' || state === 'in_progress') return <span class="mark running" aria-label="进行中" />;
  if (state === 'failed')
    return (
      <span class="mark fail" aria-label="失败">
        ×
      </span>
    );
  if (state === 'done' || state === 'completed')
    return (
      <span class="mark ok" aria-label="完成">
        ✓
      </span>
    );
  return <span class="mark pending" aria-label="未开始" />;
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
    <div class="turn-end">
      {(turn.state === 'failed' || turn.state === 'interrupted') && (
        <section class="error-card" role="alert">
          <h4>
            <Icon name="alert" size={14} />
            {turn.state === 'failed' ? '运行失败' : '这一轮被中断了'}
          </h4>
          {end.text && <p>{end.text}</p>}
          {turn.state === 'interrupted' && !end.text && <p>Studio 重启时这一轮还在进行，编排工具的进程已经不在了。</p>}
          {retryText && (
            <div class="actions">
              <button class="pill primary-pill" onClick={() => props.onRetry(retryText)}>
                重试
              </button>
            </div>
          )}
        </section>
      )}
      {turn.state === 'stopped' && (
        <p class="pause-line">
          <Icon name="pause" size={12} />
          已停止这一轮
        </p>
      )}
      {changes.length > 0 && (
        <section class={'files-card turn-card' + (turn.reverted ? ' reverted' : '')} id={'turn-' + end.turn_id}>
          <header>
            <Icon name="file" size={12} />
            <span class="files-label">{turn.reverted ? '已回退这一轮' : '本轮改动'}</span>
            <span class="count">{changes.length}</span>
            <span class="files-summary ellipsis">{changes.map((c) => c.path.split('/').pop()).join('、')}</span>
            {!turn.reverted && (
              <button class="pill revert" id="revert-turn" disabled={working} onClick={revert}>
                回退本轮
              </button>
            )}
          </header>
          <ul>
            {shown.map((change) => (
              <li key={change.path}>
                <span class={'change ' + change.change}>{changeLabels[change.change]}</span>
                <button
                  class="link mono ellipsis"
                  onClick={() => (change.revertable ? setDiffPath(change.path) : props.onOpenFile(change.path))}
                  title={change.revertable ? '查看改动' : '媒体或大文件：只列出，不回退'}
                >
                  {change.path}
                </button>
                {!change.revertable && <span class="muted small">不回退</span>}
              </li>
            ))}
          </ul>
          {changes.length > 4 && (
            <button class="link small more" onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起' : `还有 ${changes.length - 4} 个文件`}
            </button>
          )}
          {error && <p class="error-line">{error}</p>}
          {diffPath && <DiffDialog turnId={end.turn_id ?? ''} path={diffPath} onClose={() => setDiffPath('')} />}
        </section>
      )}
      {turn.state === 'done' && (
        <footer class={'done-line' + (props.latest ? ' latest' : '')}>
          <span>✓ 已完成</span>
          <span>{formatElapsed(props.elapsed)}</span>
          {tokens > 0 && <span class="mono">{tokens.toLocaleString()} tokens</span>}
          {changes.length === 0 && <span>没有改动项目文件</span>}
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
    <div class="plan-pill-wrap">
      <button class="float-pill plan-pill" aria-label={`进度：第 ${step}/${plan.length} 步`}>
        <span class="orb tiny" aria-hidden="true" />第 {step}/{plan.length} 步
        {current >= 0 && <span class="plan-current ellipsis">{plan[current].text}</span>}
      </button>
      <div class="popover plan-popover" role="tooltip">
        <ol>
          {plan.map((item, index) => (
            <li key={index} class={item.status}>
              <StatusMark state={item.status} />
              <span>{item.text}</span>
            </li>
          ))}
        </ol>
        {scenes.length > 0 && (
          <p class="plan-scenes">
            镜头已出片 {rendered}/{scenes.length}
            {rendering.length > 0 && ` · 渲染中：${rendering.map((scene) => scene.id).join('、')}`}
          </p>
        )}
      </div>
    </div>
  );
}

function QueuedStack({ queue, onAction }: { queue: QueuedMessage[]; onAction: (item: QueuedMessage, action: 'steer' | 'remove' | 'edit') => void }) {
  return (
    <section class="queue-stack" aria-label={`排队中的消息 ${queue.length} 条`}>
      {queue.map((item, index) => (
        <div key={item.id} class="queue-card" data-depth={Math.min(queue.length - 1 - index, 3)} style={{ '--depth': String(Math.min(queue.length - 1 - index, 3)) }}>
          <span class="queue-badge">排队</span>
          <span class="queue-text ellipsis">{splitAttachmentText(item.text).body}</span>
          <button class="queue-action steer" onClick={() => onAction(item, 'steer')} title="停掉这一轮，马上发出排队的消息">
            <Icon name="up" size={11} />
            引导对话
          </button>
          <button class="icon-button" onClick={() => onAction(item, 'edit')} aria-label="编辑" title="拿回输入框修改">
            <Icon name="edit" size={12} />
          </button>
          <button class="icon-button" onClick={() => onAction(item, 'remove')} aria-label="移除" title="不发这条了">
            <Icon name="trash" size={12} />
          </button>
        </div>
      ))}
    </section>
  );
}

function AttachmentTray({ attachments, onRemove }: { attachments: Attachment[]; onRemove: (index: number) => void }) {
  return (
    <ul class="tray" id="attachments">
      {attachments.map((a, index) => {
        const image = a.path && (!a.upload || /\.(png|jpe?g|webp|gif)$/i.test(a.path));
        if (a.quote || a.ref) {
          const title = a.quote ? a.label || '引用' : a.scene_id ? `镜头 ${a.scene_id}` : a.source ?? '';
          const meta = a.quote ? a.quote.replace(/\s+/g, ' ') : a.scene_id ? '镜头' : '文件';
          return (
            <li key={index} class="doc-card quote-card" title={a.quote ? `${title}\n${a.quote}` : title}>
              <span class="quote-mark" aria-hidden="true">{a.quote ? '❝' : a.scene_id ? <Icon name="film" size={14} /> : <Icon name="file" size={14} />}</span>
              <span class="doc-text">
                <span class="doc-name">{title}</span>
                <span class="doc-meta">{meta}</span>
              </span>
              <button class="remove" onClick={() => onRemove(index)} aria-label="移除引用">
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
          <li key={index} class={image ? 'image-card' : 'doc-card'} title={`${title}${meta ? ' · ' + meta : ''}`}>
            {image ? (
              <>
                <img src={rawURL(a.path!)} alt="" />
                {!a.upload && <span class="image-label">{[title, meta].filter(Boolean).join(' · ')}</span>}
              </>
            ) : (
              <>
                <Icon name="file" size={15} />
                <span class="doc-text">
                  <span class="doc-name">{title}</span>
                  <span class="doc-meta">{meta}</span>
                </span>
              </>
            )}
            <button class="remove" onClick={() => onRemove(index)} aria-label="移除附件">
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
    <div class="popover menu history-menu" ref={box} role="menu">
      <div class="history-search">
        <input autoFocus value={query} placeholder="搜索会话" aria-label="搜索会话" onInput={(e) => setQuery(e.currentTarget.value)} />
        <button class="icon-button" onClick={() => props.onPick('')} aria-label="新对话" title="新对话">
          <Icon name="plus" size={12} />
        </button>
      </div>
      {list.length === 0 && <p class="muted small empty">没有会话</p>}
      {list.map((s) => (
        <button key={s.session_id} role="menuitem" class={'history-row' + (s.session_id === props.current ? ' on' : '')} onClick={() => props.onPick(s.session_id)}>
          <span class="ellipsis">{s.title}</span>
          <span class="muted small">
            {s.kind === 'production' ? '整片制作 · ' : ''}
            {s.turns.length} 轮 · {new Date(s.updated_at).toLocaleString()}
          </span>
        </button>
      ))}
    </div>
  );
}
