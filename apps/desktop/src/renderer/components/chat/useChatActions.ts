import type { MutableRefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, errorText, post } from '../../api';
import type { AgentChoice, Attachment, PermissionAsk, Scene, SessionMeta, ViewRequest, ViewState } from '../../types';
import type { GuideAction } from '../guide';
import { type CommandContext, executeGuideAction, executeSlashCommand } from './chatCommands';
import { mentionAttachments, parseCommand, type SlashCommand } from './complete';
import { usePetCommands } from './crew';
import { type QueuedMessage, splitAttachmentText } from './model';
import type { PolishResult, PolishState } from './Polish';

/** 镜头页的快捷动作发来的消息：nonce 变了就发一次。 */
export interface Outbox {
  text: string;
  attachments: Attachment[];
  nonce: number;
  /** 为 true 时只填进输入框等用户补充，不直接发送。 */
  draftOnly?: boolean;
  /** 在现有内容之后添加这段草稿。 */
  appendDraft?: boolean;
}

export interface ChatActionsParams {
  choice: AgentChoice;
  sessionId: string;
  busy: string;
  attachments: Attachment[];
  onSession: (id: string) => void;
  onSessionsChanged: () => void;
  onClearAttachments: () => void;
  onAddAttachments: (attachments: Attachment[]) => void;
  scenes: Scene[];
  files: string[];
  outbox: Outbox | null;
  view: ViewState;
  onView: (view: ViewRequest) => void;
  run: (path: string, payload?: Record<string, unknown>) => void;
  running: boolean;
  asks: PermissionAsk[];
  drawing: { ok: boolean; reason: string };
  following: MutableRefObject<boolean>;
}

export function useChatActions(params: ChatActionsParams) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  // 润色：卡片的状态；用了改写稿之后留着原文，直到用户再动输入框，可以一键换回。
  const [polishing, setPolishing] = useState<PolishState | null>(null);
  const [undoPolish, setUndoPolish] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  // 这一轮进行中照样能发：消息排到这一轮之后。别的写任务占着项目时不能发。
  const blocked = sending || (params.busy !== '' && !params.running);
  const completion = { scenes: params.scenes.map((s) => s.id), files: params.files };

  const fill = (text: string) => {
    setDraft(text);
    pendingCaret.current = text.length;
    textarea.current?.focus();
  };

  const deliver = async (message: string, attachments: Attachment[], interrupt = false) => {
    if (!message || blocked) return false;
    setSending(true);
    setError('');
    try {
      let id = params.sessionId;
      if (!id) {
        const created = await post<SessionMeta>('/api/sessions', { title: message.slice(0, 24), ...params.choice });
        id = created.session_id;
        params.onSession(id);
      }
      await post(`/api/sessions/${id}/turns`, { message, attachments, interrupt, view: params.view });
      params.following.current = true;
      params.onSessionsChanged();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setSending(false);
    }
  };

  const startProduction = async (message = draft.trim()) => {
    setSending(true);
    setError('');
    try {
      const result = await post<{ session_id: string }>('/api/production/start', { message, ...params.choice });
      setDraft('');
      params.following.current = true;
      params.onSession(result.session_id);
      params.onSessionsChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    try {
      await post(`/api/sessions/${params.sessionId}/cancel`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const handoff = async () => {
    if (!params.sessionId) {
      setError('当前还没有会话记录，无需分段接力');
      return;
    }
    setError('');
    try {
      await post(`/api/sessions/${params.sessionId}/handoff`, { reason: '手动分段接力' });
      params.onSessionsChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const commandCtx: CommandContext = {
    attachments: params.attachments,
    drawing: params.drawing,
    fill,
    setError,
    onSession: params.onSession,
    onView: params.onView,
    onClearAttachments: params.onClearAttachments,
    onAddAttachments: params.onAddAttachments,
    run: params.run,
    deliver,
    startProduction,
    cancel,
    handoff,
  };

  const runGuide = (action: GuideAction) => executeGuideAction(action, commandCtx);
  const runCommand = (command: SlashCommand, arg: string) => executeSlashCommand(command, arg, commandCtx);

  const send = async () => {
    const message = draft.trim();
    const command = parseCommand(message);
    if (command) {
      runCommand(command.command, command.arg);
      return;
    }
    const attachments = [...params.attachments, ...mentionAttachments(message, completion, params.attachments)];
    if (await deliver(message, attachments)) {
      // 发送途中用户可能已经接着打了下一条，只清掉发出去的那段。
      setDraft((current) => (current.trim() === message ? '' : current));
      params.onClearAttachments();
    }
  };

  /** 把输入框里的话交去润色：不发送、不改输入框，结果显示在上方的卡片里。 */
  const polish = async (from = draft) => {
    if (from.trim() === '') return;
    setPolishing({ from, status: 'working' });
    try {
      const result = await post<PolishResult>('/api/polish', {
        message: from,
        view: params.view,
        attachments: params.attachments,
        session_id: params.sessionId || undefined,
        ...params.choice,
      });
      setPolishing((current) => (current?.from === from ? { from, status: 'done', result } : current));
    } catch (err) {
      // 取消（409 cancelled）时卡片已经关掉了。
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setPolishing((current) => (current?.from === from ? { from, status: 'failed', error: errorText(err) } : current));
    }
  };

  const closePolish = () => {
    if (polishing?.status === 'working') void api('/api/polish', { method: 'DELETE' }).catch(() => {});
    setPolishing(null);
  };

  const applyPolish = (text: string) => {
    setUndoPolish(draft);
    setPolishing(null);
    fill(text);
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
      params.onAddAttachments(result.attachments);
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
        for (const other of params.asks) {
          await post(`/api/sessions/${params.sessionId}/permissions/${other.id}`, { decision: 'allow' });
        }
        return;
      }
      await post(`/api/sessions/${params.sessionId}/permissions/${ask.id}`, { decision });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const queueAction = async (item: QueuedMessage, action: 'steer' | 'remove' | 'edit') => {
    setError('');
    try {
      if (action === 'steer') {
        await post(`/api/sessions/${params.sessionId}/queue/${item.id}/steer`);
        return;
      }
      await api(`/api/sessions/${params.sessionId}/queue/${item.id}`, { method: 'DELETE' });
      if (action === 'edit') {
        setDraft(splitAttachmentText(item.text).body);
        textarea.current?.focus();
      }
    } catch (err) {
      setError(errorText(err));
    }
  };

  // 桌宠上点的选项或说的一句：一轮刚结束时选项马上出现在桌宠上，项目占用状态却要等下一次刷新才清掉，
  // 这时 deliver 会因为 blocked 静默丢掉这句话（CI 上实测撞到）。先记下，等不挡了再发。
  // 记下是哪个会话里点的：Chat 切会话时不重建，暂存的话不能发到切过去的那个会话里。
  const petSay = useRef<{ text: string; session: string } | null>(null);
  useEffect(() => {
    if (blocked || petSay.current === null) return;
    const pending = petSay.current;
    petSay.current = null;
    if (pending.session === params.sessionId) void deliver(pending.text, []);
  }, [blocked, params.sessionId]);

  // 桌宠上的动作：答批准、点选项或说一句、停下这一轮。
  usePetCommands((command) => {
    if (command.kind === 'answer') {
      const ask = params.asks.find((a) => a.id === command.id);
      if (ask) void answer(ask, command.decision);
    } else if (command.kind === 'say') {
      if (blocked) petSay.current = { text: command.text, session: params.sessionId };
      else void deliver(command.text, []);
    } else if (command.kind === 'stop') {
      if (params.running) void cancel();
    }
  });

  // 镜头页快捷动作：直接发，或填进输入框等用户补充。
  const lastOutbox = useRef(0);
  useEffect(() => {
    const out = params.outbox;
    if (!out || out.nonce === lastOutbox.current) return;
    lastOutbox.current = out.nonce;
    if (out.draftOnly) {
      setDraft((current) => (out.appendDraft && current.trim() ? current + '\n\n' + out.text : out.text));
      if (out.attachments.length) params.onAddAttachments(out.attachments);
      textarea.current?.focus();
      return;
    }
    void deliver(out.text, out.attachments);
  }, [params.outbox]);

  return {
    draft,
    setDraft,
    error,
    sending,
    uploading,
    polishing,
    undoPolish,
    setUndoPolish,
    textarea,
    pendingCaret,
    blocked,
    completion,
    fill,
    deliver,
    runGuide,
    runCommand,
    send,
    polish,
    closePolish,
    applyPolish,
    startProduction,
    cancel,
    handoff,
    upload,
    answer,
    queueAction,
  };
}
