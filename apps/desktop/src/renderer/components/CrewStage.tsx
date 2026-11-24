import { type ReactElement, useEffect, useRef, useState } from 'react';
import { type Pace, type StageKind, type StageState, usePace } from './crew-stage/pace';
import {
  D,
  farTrees,
  gatePart,
  gateX,
  gear,
  home,
  homeX,
  lamp,
  lamps,
  lookOf,
  nearTrees,
  roadEnd,
  roadHalf,
  roadY,
  studio,
  studioBlock,
  tree,
} from './crew-stage/scenery';
import { jointAt, P, type Pose, person, prefersStill, pts, seg } from './Pet';

export { type Pace, paceWord, type StageKind, type StageState, stageKind, usePace } from './crew-stage/pace';

/*
 * 安装页每个组的小景：下载一个组，就是这个组的人赶来片场的路上。与场记桌宠同一套等距块面的微缩模型
 * （同一个 person、box、投影）。
 *
 * 镜头跟着人走（跟拍）：人抱着自己的器材在路中间赶路，路边的树、路灯、路面虚线往后退——
 *   摄影抱着摄影机、剪辑师抱着笔记本、配音演员拿着话筒、字幕员夹着稿板、其余（风格库、节拍环境……）的搬运工抱着箱子。
 *
 *   走了多远——下载进度：整条路从家门口到片场大门，人在路上的位置就是进度，走过的路面亮起来；快到头时大门和片场才进画面。
 *   走多快——下载速度（最近几秒进度涨得多快）：路边的东西往后退得多快、腿迈得多快都跟它走；快了跑起来、脚下扬起尘土；
 *           好几秒没涨就停下来，头上冒一个「…」。
 *   排队中——人在家门口等着出发；还没请——家门口空着、灯也没开。
 *   就位——穿过大门，门上的灯串亮起来、片场灯全亮，人欢呼一下再抱着胳膊站好。
 *   暂停——停在半路；没成功——在半路垂头丧气，器材放在地上。
 */

/** 取景框：人站在 (0, roadY)，框住他身前多一点、身后少一点。 */
const viewBox = (() => {
  const c = P(0, roadY, 0.8);
  const w = 210;
  const h = 124;
  return `${c[0] - w * 0.45} ${c[1] - h * 0.52} ${w} ${h}`;
})();

const still = () => typeof window !== 'undefined' && prefersStill();

/** 一个共用的钟：每 50 毫秒走一下（与桌宠同一个节拍）；偏好减少动态时停住。 */
function useClock(): number {
  const [t, setT] = useState(() => performance.now());
  useEffect(() => {
    if (still()) return;
    const id = window.setInterval(() => setT(performance.now()), 50);
    return () => window.clearInterval(id);
  }, []);
  return t;
}

let stages = 0;

/**
 * percent：这个组的下载进度（0–100），决定人在路上走到了哪；pace：下载速度，决定人迈步的快慢。
 * 不给 pace 时自己按 percent 的变化算。
 */
export function CrewStage(props: { kind: StageKind; state: StageState; percent?: number; pace?: Pace }) {
  const t = useClock();
  // 人身上的 clipPath 按 key 起 id：同一页上有好几个小景，不分开的话暗面会裁到别人身上。
  const [id] = useState(() => `stage${++stages}-`);
  const own = usePace(props.percent ?? 0, props.state === 'working' && !props.pace);
  const pace = props.pace ?? own;
  const { kind, state } = props;

  // 刚就位：欢呼 1.6 秒再站好。第一次画出来就已经是就位的不欢呼。
  const last = useRef(state);
  const cheerUntil = useRef(0);
  if (last.current !== state) {
    if (state === 'ready') cheerUntil.current = performance.now() + 1600;
    last.current = state;
  }
  const cheering = state === 'ready' && t < cheerUntil.current;

  const working = state === 'working';
  const stopped = working && pace.stalled;
  const running = working && !stopped && (pace.rate ?? 0) >= 1.5;

  // 走到哪：进度每秒才报一次，中间按当前速度往前挪，落后了再追上去，不超过报来的进度。
  const target = (props.percent ?? 0) / 100;
  const shown = useRef(target);
  const lastT = useRef(t);
  const dt = Math.max(0, Math.min(200, t - lastT.current));
  lastT.current = t;
  if (still()) shown.current = target;
  else {
    // 只有按百分比量速度时才按速度往前推；只知道字节数时位置由调用方给（见 SetupGuide 的 walkPercent）。
    if (working && !stopped && pace.rate && !pace.creep) shown.current += (pace.rate / 100) * (dt / 1000);
    if (shown.current > target + 0.01 || target - shown.current > 0.03)
      shown.current += (target - shown.current) * 0.08;
  }

  // 步子：按速度走快走慢；停住时不迈步。
  const cadence =
    !working || stopped ? 0 : pace.rate === null ? 1 : Math.min(2.4, Math.max(0.55, 0.55 + pace.rate * 0.6));
  const phase = useRef(0);
  phase.current += dt * cadence;

  const look = lookOf[kind]();
  const ready = state === 'ready';
  const away = state === 'missing';
  const onRoad = working || state === 'paused' || state === 'failed';
  // 人（也就是镜头）在世界里的位置：在家门口等、在路上、到了大门里。
  // 在路上最多走到大门前 1.3 处（再近门柱就挡在人前面了），过门就是就位那一下。
  const w = ready ? gateX + 0.65 : onRoad ? shown.current * (gateX - 1.3) : homeX + 1.3;
  const X = (x: number) => x - w;

  const out: ReactElement[] = [
    <polygon key="ground" points={pts([P(-9, -4), P(9, -4), P(9, 6), P(-9, 6)])} fill="#2e2720" />,
    <polygon
      key="road"
      points={pts([
        P(X(homeX + 0.5), roadY - roadHalf),
        P(X(roadEnd), roadY - roadHalf),
        P(X(roadEnd), roadY + roadHalf),
        P(X(homeX + 0.5), roadY + roadHalf),
      ])}
      fill="#221d18"
    />,
    seg('edge1', P(X(homeX + 0.5), roadY - roadHalf), P(X(roadEnd), roadY - roadHalf), '#3a3128', 1),
    seg('edge2', P(X(homeX + 0.5), roadY + roadHalf), P(X(roadEnd), roadY + roadHalf), '#3a3128', 1),
    // 路面虚线跟着世界走：线从路的起点画起，世界一退，虚线就往后流。
    <polyline key="center" points={pts([P(X(homeX + 0.6), roadY), P(X(gateX), roadY)])} className="stage-centerline" />,
  ];
  // 走过的那段路亮起来。
  if (!away && w > 0)
    out.push(<polyline key="walked" points={pts([P(X(0), roadY), P(0, roadY)])} className="stage-walked" />);

  const visible = (x: number) => X(x) > -4 && X(x) < 5;
  out.push(home(X(homeX), !away));
  // 片场的楼在路的远侧，总在人后面画。
  if (X(studio.x) < 5) out.push(studioBlock(X(studio.x), ready));
  for (const [i, tr] of farTrees.entries())
    if (visible(tr.x) && tr.x < D) out.push(tree(`ft${i}`, X(tr.x), tr.y, tr.s));
  if (visible(gateX)) out.push(gatePart('far', X(gateX), ready, t));

  // 人（在路中间，站在取景框的固定位置）。
  const person0: ReactElement[] = [];
  if (!away) {
    let pose: Pose;
    let a = 0;
    let tt = t;
    if (ready) {
      pose = cheering ? 'cheer' : 'cross';
      a = Math.PI / 4;
    } else if (state === 'waiting') {
      pose = 'look';
      a = Math.PI / 4;
    } else if (state === 'failed') {
      pose = 'slump';
    } else if (state === 'paused' || stopped) {
      pose = 'hold';
    } else {
      pose = running ? 'carryRun' : 'carry';
      tt = phase.current;
    }
    const y = roadY;
    // 跑起来时脚后扬起几团尘土。
    if (running) {
      for (let i = 0; i < 3; i++) {
        const k = (phase.current / 260 + i / 3) % 1;
        const d = P(-0.15 - k * 0.5, y + (i - 1) * 0.08, 0.05 + k * 0.12);
        person0.push(
          <circle
            key={`dust${i}`}
            cx={d[0]}
            cy={d[1]}
            r={1.5 + k * 3}
            className="stage-dust"
            opacity={0.5 * (1 - k)}
          />,
        );
      }
    }
    person0.push(person(id + 'crew', 0, y, a, pose, tt, look));
    if (pose === 'carry' || pose === 'carryRun' || pose === 'hold') {
      const l = jointAt(0, y, a, pose, tt, 'haL');
      const r = jointAt(0, y, a, pose, tt, 'haR');
      person0.push(gear(kind, [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2 + 2], 'gear'));
    } else {
      // 不拿在手里时器材放在脚边。
      person0.push(gear(kind, P(0.1, y + 0.32, 0), 'gear'));
    }
    if (stopped) {
      const h = P(0, y, 2.05);
      person0.push(
        <g key="wait" className="stage-bubble">
          <rect x={h[0] - 9} y={h[1] - 7} width={18} height={10} rx={5} />
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={h[0] - 4.5 + i * 4.5} cy={h[1] - 2} r={1.1} className={`dot d${i}`} />
          ))}
        </g>,
      );
    }
  }

  // 人过了大门（就位）时门在他身后先画；还在路上时门在他前面（更近）。
  if (ready) {
    if (visible(gateX)) out.push(gatePart('near', X(gateX), ready, t), gatePart('beam', X(gateX), ready, t));
    out.push(...person0);
  } else {
    out.push(...person0);
    if (visible(gateX)) out.push(gatePart('near', X(gateX), ready, t), gatePart('beam', X(gateX), ready, t));
  }
  for (const [i, lp] of lamps.entries()) if (visible(lp.x)) out.push(lamp(`lp${i}`, X(lp.x), lp.y));
  for (const [i, tr] of nearTrees.entries())
    if (visible(tr.x) && tr.x < D) out.push(tree(`nt${i}`, X(tr.x), tr.y, tr.s));

  return (
    <svg
      className={'crew-stage-svg ' + state}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {out}
    </svg>
  );
}
