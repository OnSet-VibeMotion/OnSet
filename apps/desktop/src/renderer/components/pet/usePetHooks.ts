import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { currentSkin, onSkin } from '../../skin';
import type { SkinView } from '../../types';
import type { CrewSignal } from '../chat/crew';
import {
  advance,
  between,
  chatSpot,
  clampCam,
  director,
  directorIdle,
  directorSpot,
  editorIdle,
  type IdleAct,
  type Idler,
  idleSignal,
  newWalker,
  nextAct,
  operatorIdle,
  operators,
  retarget,
  voiceIdle,
  type Walker,
} from './crewState';
import { CH, CW, clamp, type Pt, prefersStill, tickMs } from './iso';
import { applyPetSkin } from './person';

export function usePetSimulation() {
  const [signal, setSignal] = useState<CrewSignal>(idleSignal);
  // 界面皮肤：换工作室的颜色，或整个换成插件的页面（pet.page_url）。
  const [skin, setSkin] = useState<SkinView | null>(() => {
    const sk = currentSkin();
    applyPetSkin(sk);
    return sk;
  });
  useEffect(
    () =>
      onSkin((sk) => {
        applyPetSkin(sk);
        setSkin(sk);
      }),
    [],
  );
  const pageURL = skin?.pet.page_url ?? '';
  const [, setTick] = useState(0);
  // 换成插件页面时自己的工作室不画，也不必按帧推着人走。
  const still = prefersStill();
  const paused = still || pageURL !== '';
  const start = useRef(Date.now());

  // 旧版主窗口发来的状态可能缺新字段，按空补上。
  useEffect(() => window.onset?.onCrew?.((next) => setSignal(next ? { ...idleSignal, ...next } : idleSignal)), []);

  const walkers = useRef<{ director: Walker; ops: Walker[] } | null>(null);
  if (!walkers.current) {
    walkers.current = { director: newWalker(director.chair), ops: operators.map((o) => newWalker(o.seat)) };
  }
  const idlers = useRef<{ director: Idler; ops: Idler[]; editor: Idler; voice: Idler }>({
    director: { act: 'sit', until: null },
    ops: operators.map(() => ({ act: 'sit', until: null })),
    editor: { act: 'lean', until: null },
    voice: { act: 'script', until: null },
  });
  const mood = signal.mood;
  // 前三个在渲染的镜头各给一位摄影；制作人在等渲染、却还没有镜头标成渲染中时，先开一台。
  const shooting = signal.rendering.length > 0 ? signal.rendering : mood === 'filming' ? [''] : [];
  const live = useRef({ mood, shooting: shooting.length });
  live.current = { mood, shooting: shooting.length };

  useEffect(() => {
    const w = walkers.current!;
    const idle = idlers.current;
    // 一有活就放下手里的闲事；回到待命先坐回制作人椅，过一会儿再起来溜达。
    idle.director = { act: 'sit', until: null };
    retarget(w.director, director[directorSpot[mood]], still);
    w.ops.forEach((op, i) => {
      if (i >= shooting.length && idle.ops[i].act === 'check') idle.ops[i] = { act: 'sit', until: null };
      retarget(op, i < shooting.length ? operators[i].camera : operators[i].seat, still);
    });
    setTick((t) => t + 1);
  }, [mood, shooting.length, still]);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      const w = walkers.current!;
      const idle = idlers.current;
      const { mood: m, shooting: n } = live.current;
      const now = Date.now();
      // 到了位置才开始计时；时间到了换下一样，要挪地方的就走过去。
      const due = (who: Idler, table: Record<string, IdleAct>, walker?: Walker) => {
        if (walker && walker.path.length > 0) return false;
        if (who.until === null) who.until = now + between(table[who.act].dur);
        return now > who.until;
      };
      if (m === 'idle' && due(idle.director, directorIdle, w.director)) {
        const sofaFree = n < operators.length;
        const act = nextAct(directorIdle, idle.director.act, 'sit', (k) => k !== 'chat' || sofaFree);
        idle.director = { act, until: null };
        const at = directorIdle[act].at;
        retarget(w.director, at && at !== 'camera' ? director[at] : chatSpot, false);
      }
      w.ops.forEach((op, i) => {
        if (i < n || !due(idle.ops[i], operatorIdle, op)) return;
        const act = nextAct(operatorIdle, idle.ops[i].act, 'sit');
        idle.ops[i] = { act, until: null };
        retarget(op, operatorIdle[act].at === 'camera' ? operators[i].camera : operators[i].seat, false);
      });
      if (m !== 'editing' && due(idle.editor, editorIdle)) {
        idle.editor = { act: nextAct(editorIdle, idle.editor.act, 'lean'), until: null };
      }
      if (m !== 'voicing' && due(idle.voice, voiceIdle)) {
        idle.voice = { act: nextAct(voiceIdle, idle.voice.act, 'script'), until: null };
      }
      advance(w.director);
      w.ops.forEach(advance);
      setTick((t) => t + 1);
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [paused]);

  const t = still ? 0 : Date.now() - start.current;
  return {
    signal,
    skin,
    pageURL,
    still,
    t,
    frame: Math.floor(t / 280),
    walkers: walkers.current,
    idlers: idlers.current,
    shooting,
  };
}

/** 取景：画布按视口大小缩放，滚轮捏合缩放、拖动平移，都在视口里算，不动画布本身的坐标。 */
export function usePetCamera(pageURL: string) {
  const viewRef = useRef<HTMLDivElement>(null);
  const [viewSize, setViewSize] = useState({ w: CW, h: CH });
  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () => setViewSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pageURL]);

  const [cam, setCam] = useState({ zoom: 1, x: 0, y: 0 });
  const fit = Math.min(viewSize.w / CW, viewSize.h / CH);
  const scale = fit * cam.zoom;
  const tx = (viewSize.w - CW * scale) / 2 + cam.x;
  const ty = (viewSize.h - CH * scale) / 2 + cam.y;
  const toScreen = ([x, y]: Pt): Pt => [tx + x * scale, ty + y * scale];

  const zoomAt = (factor: number, mx = viewSize.w / 2, my = viewSize.h / 2) =>
    setCam((c) => {
      const zoom = clamp(c.zoom * factor, 0.6, 3);
      const s0 = fit * c.zoom;
      const s1 = fit * zoom;
      const t0x = (viewSize.w - CW * s0) / 2 + c.x;
      const t0y = (viewSize.h - CH * s0) / 2 + c.y;
      const cx = (mx - t0x) / s0;
      const cy = (my - t0y) / s0;
      return clampCam(
        { zoom, x: mx - cx * s1 - (viewSize.w - CW * s1) / 2, y: my - cy * s1 - (viewSize.h - CH * s1) / 2 },
        CW * s1,
        CH * s1,
      );
    });

  const panBy = (dx: number, dy: number) =>
    setCam((c) => clampCam({ ...c, x: c.x + dx, y: c.y + dy }, CW * fit * c.zoom, CH * fit * c.zoom));
  const resetCam = () => setCam({ zoom: 1, x: 0, y: 0 });
  const panning = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);

  return { viewRef, viewSize, scale, tx, ty, toScreen, zoomAt, panBy, resetCam, panning };
}
