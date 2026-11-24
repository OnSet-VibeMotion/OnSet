import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Block } from './model';

/** 视为「在底部」的容差：比这近就继续跟随新消息。 */
const BOTTOM_TOLERANCE = 8;

export function useChatScroll(
  sessionId: string,
  blocks: Block[],
  queueLength: number,
  jump: { turn: string; nonce: number } | null,
) {
  const [atBottom, setAtBottom] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // 从制作路线跳过来：等那一轮出现在页面上（可能要先切会话、读完事件）再滚过去闪一下。
  const pendingJump = useRef('');
  useEffect(() => {
    if (jump) pendingJump.current = jump.turn;
  }, [jump]);
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
  }, [jump, blocks]);

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
  }, [blocks, queueLength, syncScrollState]);

  // 换会话时回到跟随：打开一段历史就落在最新的那一轮。
  useLayoutEffect(() => {
    following.current = true;
    setAtBottom(true);
  }, [sessionId]);

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

  return { scroller, following, atBottom, scrolled, onScroll, jumpToLatest };
}
