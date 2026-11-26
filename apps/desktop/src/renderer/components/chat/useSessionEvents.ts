import { useEffect, useRef, useState } from 'react';
import type { EventKind, SessionEvent, ViewRequest } from '../../types';

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
  'background-tasks',
  'context-compaction',
  'permission',
  'permission-resolved',
  'question',
  'question-deferred',
  'question-resolved',
];

/** 切页请求在多久之内算刚发生（毫秒）。 */
const viewFreshMs = 15000;

/** 进行中的一轮每秒刷新一次计时。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

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
export function useSessionEvents(
  sessionId: string,
  onFilesChanged: (files: string[]) => void,
  onTurnEnd: () => void,
  onView: (view: ViewRequest) => void,
) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const callbacks = useRef({ onFilesChanged, onTurnEnd, onView });
  callbacks.current = { onFilesChanged, onTurnEnd, onView };

  useEffect(() => {
    setEvents([]);
    setLoaded(false);
    setReconnecting(false);
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
    // replay：打开会话时一次取回的历史。里面的「一轮结束」早就结束了，不算刚做完：不然每轮都弹一次「这一轮做完了」。
    const notify = (event: SessionEvent, replay = false) => {
      if (event.kind === 'files-changed' && event.files) callbacks.current.onFilesChanged(event.files);
      if (event.kind === 'turn-end' && !replay) callbacks.current.onTurnEnd();
      // 只执行刚发生的切页请求：打开会话时重放的历史不该把页面切来切去。
      if (event.kind === 'view' && event.view && Date.now() - Date.parse(event.time) < viewFreshMs) {
        callbacks.current.onView(event.view);
      }
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
      source.onopen = () => {
        if (!closed) setReconnecting(false);
      };
      source.onerror = () => {
        if (!closed) setReconnecting(true);
      };
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
        for (const event of fresh) notify(event, true);
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

  return { events, loaded, reconnecting };
}
