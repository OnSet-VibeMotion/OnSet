import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import '../pet.css';
import { buildCrewInfo, buildPieItems } from './pet/crewInfo';
import { ambient, area, figure, opIndex, type Spot2, type Who } from './pet/crewState';
import { P } from './pet/iso';
import { PetFoot, PetStage } from './pet/PetStage';
import { Desk, PetPage, sendPet } from './pet/PetWidgets';
import { seatedPoses } from './pet/poses';
import { roomShell } from './pet/room';
import { buildSceneItems, buildTags } from './pet/sceneItems';
import { usePetCamera, usePetSimulation } from './pet/usePetHooks';

export {
  box,
  type Material,
  mat,
  P,
  type Pt,
  prefersStill,
  pts,
  seg,
  U,
  wallAt,
  wallQuad,
} from './pet/iso';
export { type Look, looks, person } from './pet/person';
export { jointAt, type Pose } from './pet/poses';

/*
 * 桌宠窗口（main/pet.ts）：一间等距块面的微缩工作室。从斜上方平行投影看进去，家具都是有厚度的块，
 * 顶面最亮、朝左下的面次之、朝右下的面最暗（光从左上来）；人是实色的：衣服、皮肤、头发各有亮暗两面。
 * 状态由主窗口从会话事件推出后经主进程转来（chat/crew.ts），这里只负责画。全部是手写的矢量，不取现成素材。
 */

export function Pet() {
  const [composing, setComposing] = useState(false);
  const { signal, skin, pageURL, still, t, frame, walkers: w, idlers: idle, shooting } = usePetSimulation();
  const { viewRef, viewSize, scale, tx, ty, toScreen, zoomAt, panBy, resetCam, panning } = usePetCamera(pageURL);

  const mood = signal.mood;
  const dirArrived = w.director.path.length === 0;
  const filmingOps = w.ops.map((op, i) => i < shooting.length && op.path.length === 0);
  const anyFilming = filmingOps.some(Boolean);
  const editing = mood === 'editing';
  const voicing = mood === 'voicing';
  const shell = useMemo(() => roomShell(), [skin]);

  const { items, dPose } = buildSceneItems({
    mood,
    t,
    frame,
    still,
    walkers: w,
    idlers: idle,
    dirArrived,
    filmingOps,
    anyFilming,
    editing,
    voicing,
  });
  const tags = buildTags(w.ops, filmingOps, shooting, editing, voicing);
  const filmingCount = shooting.filter(Boolean).length;

  // 每个人此刻站在哪（画布坐标的脚下一点），选中、热区、环形菜单都按它。
  const voiceAt: [number, number] = voicing ? [0.55, 5.2] : [0.6, 5.45];
  const footOf = (who: Who): [number, number] =>
    who === 'director'
      ? [w.director.x, w.director.y]
      : who === 'editor'
        ? [6.95, 1.2]
        : who === 'voice'
          ? voiceAt
          : [w.ops[opIndex(who)].x, w.ops[opIndex(who)].y];

  const nowMs = Date.now();
  const info = (who: Who) =>
    buildCrewInfo(who, { signal, idlers: idle, shooting, filmingOps, editing, voicing, nowMs });

  // 选中谁、环形菜单开着没有。
  const [selected, setSelected] = useState<Who | null>(null);
  const [pie, setPie] = useState<Who | null>(null);
  useEffect(() => {
    if (!signal.project) {
      setSelected(null);
      setPie(null);
    }
  }, [signal.project]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPie(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const choose = (who: Who) => {
    setSelected(who);
    setPie((open) => (open === who ? null : who));
  };

  // 制作人的气泡：挂在头上，换成屏幕坐标后夹在视口里。
  const bubble = useRef<HTMLDivElement>(null);
  const [bubbleWidth, setBubbleWidth] = useState(0);
  useLayoutEffect(() => setBubbleWidth(bubble.current?.offsetWidth ?? 0), [signal.line]);
  const seated = dirArrived && seatedPoses.has(dPose);
  const headAt = toScreen(P(w.director.x, w.director.y, seated ? 1.45 : 1.95));
  const bubbleLeft = Math.min(Math.max(headAt[0] - bubbleWidth / 2, 6), viewSize.w - 6 - bubbleWidth);
  const tail = Math.min(Math.max(headAt[0] - bubbleLeft, 12), Math.max(12, bubbleWidth - 12));
  const bubbleTop = Math.max(4, headAt[1] - 30 - (mood === 'thinking' && dirArrived ? 14 : 0));

  // 热区：点人选中并弹出环形菜单；分镜板直接打开分镜。
  const people: Who[] = ['editor', 'voice', 'op1', 'op2', 'op3', 'director'];
  const spots: Spot2[] = [
    { key: 'storyboard', label: '分镜板 · 看分镜', ...area(P(0.03, 1.9, 2.4), P(0.03, 3.4, 0.7)) },
    ...people.map((who) => ({ key: who, label: `${info(who).name} · ${info(who).doing}`, ...figure(...footOf(who)) })),
  ];

  // 昼夜：按这台电脑的时间给整间工作室一层光。
  const light = ambient(new Date());
  const sel = selected ? info(selected) : null;
  const selFoot = selected ? P(...footOf(selected)) : null;
  const selectedHeadAt = selected ? P(...footOf(selected), 2.35) : null;
  const pieAt = pie ? toScreen(P(...footOf(pie), 1.0)) : null;
  const pieItems = pie ? buildPieItems(pie, signal, info) : [];
  const pieLabel = pie ? `${info(pie).name}能做的事` : '';

  return (
    <div
      className="pet"
      id="crew"
      data-mood={mood}
      data-project={signal.project ? 'open' : 'none'}
      data-walking={dirArrived ? 'false' : 'true'}
      data-daypart={light.part}
      role="status"
      aria-live="polite"
      aria-label={signal.line}
    >
      <div className="pet-card" onDoubleClick={() => sendPet({ kind: 'focus' })} title="双击边框回到客户端">
        <div
          className="pet-view"
          ref={viewRef}
          onDoubleClick={(event) => event.stopPropagation()}
          onWheel={(event) => {
            if (pageURL) return;
            const rect = viewRef.current!.getBoundingClientRect();
            // 触控板捏合（带 ctrl）缩放，两指滑动平移。
            if (event.ctrlKey) {
              zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
            } else {
              panBy(-event.deltaX, -event.deltaY);
            }
          }}
          onPointerDown={(event) => {
            if (
              pageURL ||
              event.button !== 0 ||
              (event.target as Element).closest('button, input, .pet-panel, .pet-desk-wrap')
            ) {
              return;
            }
            panning.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const p = panning.current;
            if (!p || p.id !== event.pointerId) return;
            const dx = event.clientX - p.x;
            const dy = event.clientY - p.y;
            if (!p.moved && Math.hypot(dx, dy) < 3) return;
            p.moved = true;
            p.x = event.clientX;
            p.y = event.clientY;
            panBy(dx, dy);
          }}
          onPointerUp={(event) => {
            const p = panning.current;
            panning.current = null;
            // 点在空地上（没拖）：收起环形菜单。
            if (p && !p.moved && !(event.target as Element).closest('.pet-spot')) setPie(null);
          }}
          data-panning={panning.current?.moved ? 'true' : 'false'}
        >
          {pageURL ? (
            <PetPage url={pageURL} signal={signal} skin={skin!} />
          ) : (
            <PetStage
              signal={signal}
              skin={skin}
              shell={shell}
              t={t}
              frame={frame}
              dirArrived={dirArrived}
              anyFilming={anyFilming}
              editing={editing}
              directorPos={[w.director.x, w.director.y]}
              items={items}
              spots={spots}
              tags={tags}
              selected={selected}
              sel={sel}
              selFoot={selFoot}
              selectedHeadAt={selectedHeadAt}
              pie={pie}
              pieAt={pieAt}
              pieItems={pieItems}
              pieLabel={pieLabel}
              light={light}
              scale={scale}
              tx={tx}
              ty={ty}
              toScreen={toScreen}
              bubbleRef={bubble}
              bubbleLeft={bubbleLeft}
              bubbleTop={bubbleTop}
              tail={tail}
              onChoose={choose}
              onClosePie={() => setPie(null)}
              onCloseSelected={() => {
                setSelected(null);
                setPie(null);
              }}
              onCompose={() => setComposing(true)}
              onZoom={zoomAt}
              onResetCam={resetCam}
            />
          )}
          <Desk signal={signal} composing={composing} onCompose={setComposing} />
        </div>
        <PetFoot
          signal={signal}
          filmingCount={filmingCount}
          composing={composing}
          onToggleCompose={() => setComposing((open) => !open)}
        />
      </div>
    </div>
  );
}
