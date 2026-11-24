import type { ReactElement } from 'react';
import type { CrewMood } from '../chat/crew';
import {
  cameras,
  cameraY,
  directorIdle,
  directorPose,
  editorIdle,
  type Idler,
  operatorIdle,
  operators,
  toward,
  voiceIdle,
  type Walker,
} from './crewState';
import { box, mat, P, type Pt, pts, RY, seg } from './iso';
import { looks, person } from './person';
import type { Pose } from './poses';
import { idleProp, mark, scriptProp, slateProp, steam, thoughtDots } from './props';
import { cameraRig, softbox } from './room';

export interface SceneBuildContext {
  mood: CrewMood;
  t: number;
  frame: number;
  still: boolean;
  walkers: { director: Walker; ops: Walker[] };
  idlers: { director: Idler; ops: Idler[]; editor: Idler; voice: Idler };
  dirArrived: boolean;
  filmingOps: boolean[];
  anyFilming: boolean;
  editing: boolean;
  voicing: boolean;
}

export function buildSceneItems(ctx: SceneBuildContext): { items: { k: number; el: ReactElement }[]; dPose: Pose } {
  const { mood, t, frame, still, walkers: w, idlers: idle, dirArrived, filmingOps, anyFilming, editing, voicing } = ctx;
  const arrived = (walker: Walker) => walker.path.length === 0;

  // 按「离我们多远」（x + y）排先后：远的先画，近的盖在上面。
  const items: { k: number; el: ReactElement }[] = [];
  const add = (k: number, el: ReactElement) => items.push({ k, el });

  // 制作人区：左墙的制作人台、制作人椅、剧本桌。
  add(1.3, box('desk', 0.05, 0.55, 0, 0.75, 1.3, 0.78, mat.walnut));
  add(1.4, box('kbd', 0.3, 0.85, 0.78, 0.25, 0.7, 0.04, mat.dark));
  add(
    4.0,
    <g key="dchair">
      {seg('dl1', P(1.63, 3.12, 0), P(2.17, 2.58, 0.45), '#5c4632', 2)}
      {seg('dl2', P(2.17, 3.12, 0), P(1.63, 2.58, 0.45), '#5c4632', 2)}
      {box('dseat', 1.6, 2.55, 0.42, 0.6, 0.6, 0.08, mat.brass)}
      {box('dback', 1.55, 2.5, 0.72, 0.08, 0.7, 0.45, mat.brass)}
    </g>,
  );
  add(
    7.4,
    <g key="table">
      {box('tbl', 2.7, 3.75, 0, 1.3, 0.6, 0.82, mat.wood)}
      {box('pages1', 2.85, 3.85, 0.82, 0.4, 0.3, 0.02, mat.paper)}
      {box('pages2', 3.4, 3.88, 0.82, 0.36, 0.28, 0.06, mat.paper)}
      {box('lamp', 3.85, 3.85, 0.82, 0.08, 0.08, 0.3, mat.brass)}
    </g>,
  );

  // 影棚：两盏柔光灯、小景台（上面一盆小树）、三台摄影机。
  add(3.2, softbox('sbl', 2.7, anyFilming));
  add(6.6, softbox('sbr', 6.05, anyFilming));
  add(
    4.9,
    <g key="prop">
      {box('stool', 4.1, 0.4, 0, 0.46, 0.46, 0.55, mat.paper)}
      {box('pot', 4.21, 0.51, 0.55, 0.24, 0.24, 0.2, mat.pot)}
      <ellipse cx={P(4.33, 0.63, 1.02)[0]} cy={P(4.33, 0.63, 1.02)[1]} rx={7} ry={6.5} fill={mat.plant[1]} />
      <ellipse
        cx={P(4.33, 0.63, 1.08)[0] - 1.5}
        cy={P(4.33, 0.63, 1.08)[1] - 1.5}
        rx={4.5}
        ry={4}
        fill={mat.plant[0]}
      />
    </g>,
  );
  cameras.forEach((cx, i) => add(cx + cameraY, cameraRig(`cam${i}`, cx, filmingOps[i], frame + i * 3)));

  // 剪辑台与剪辑师：干活时打字；闲着时往后靠、伸懒腰、转椅子、喝咖啡、打盹。
  const edAct = editorIdle[idle.editor.act];
  const edPose: Pose = editing ? 'type' : edAct.pose;
  const edAngle = toward.wall + (!editing && edAct.swivel ? Math.sin(t / 1400) * 0.9 : 0);
  add(6.9, box('edesk', 6.1, 0.05, 0, 1.85, 0.65, 0.78, mat.walnut));
  add(7.0, box('ekbd', 6.55, 0.4, 0.78, 0.8, 0.22, 0.04, mat.dark));
  add(
    8.2,
    <g key="editor" data-who="editor" data-active={editing ? 'true' : 'false'}>
      {person('ed', 6.95, 1.2, edAngle, edPose, t, looks.editor)}
      {!editing ? idleProp(edAct.prop, 6.95, 1.2, edAngle, edPose, t) : null}
    </g>,
  );
  add(
    8.4,
    <g key="echair">
      {box('eseat', 6.7, 1.0, 0.42, 0.5, 0.5, 0.08, mat.dark)}
      {box('eback', 6.65, 1.42, 0.5, 0.6, 0.1, 0.45, mat.dark)}
    </g>,
  );

  // 录音棚在左前角：地面与后面先画，配音演员在里面，玻璃最后盖上去。
  const bx = 1.5;
  const by = 4.4;
  const bh = 2.0;
  const mic = P(1.08, 5.15, 1.4);
  add(
    6.0,
    <g key="booth">
      <polygon points={pts([P(0, by), P(bx, by), P(bx, RY), P(0, RY)])} fill="#2a2520" />
      <polygon points={pts([P(0.02, by, 0), P(0.02, RY, 0), P(0.02, RY, bh), P(0.02, by, bh)])} fill="#3a322a" />
      <polygon points={pts([P(0, by, 0), P(bx, by, 0), P(bx, by, bh), P(0, by, bh)])} fill="#332c25" />
      {[0, 1, 2, 3].map((i) => (
        <polygon
          key={`foam${i}`}
          points={pts([
            P(0.03, by + 0.2 + i * 0.38, 0.4),
            P(0.03, by + 0.5 + i * 0.38, 0.4),
            P(0.03, by + 0.5 + i * 0.38, 1.7),
            P(0.03, by + 0.2 + i * 0.38, 1.7),
          ])}
          fill="#2a241e"
        />
      ))}
      {seg('micstand', P(1.08, 5.15, 0), P(1.08, 5.15, 1.32), '#6f6557', 1.6)}
      <g data-who="voice" data-active={voicing ? 'true' : 'false'}>
        {voicing
          ? person('va', 0.55, 5.2, 0.1, 'mic', t, looks.voice)
          : person('va', 0.6, 5.45, Math.PI / 4, voiceIdle[idle.voice.act].pose, t, looks.voice)}
        {voicing
          ? null
          : idleProp(voiceIdle[idle.voice.act].prop, 0.6, 5.45, Math.PI / 4, voiceIdle[idle.voice.act].pose, t)}
      </g>
      <ellipse cx={mic[0]} cy={mic[1]} rx={3} ry={3.8} fill="#3e3832" />
      {voicing
        ? [0, 1, 2].map((i) => {
            const r = 5 + i * 4 + (frame % 3) * 1.3;
            return (
              <path
                key={`wave${i}`}
                d={`M${mic[0] + r * 0.7} ${mic[1] - r * 0.7} A${r} ${r} 0 0 1 ${mic[0] + r * 0.7} ${mic[1] + r * 0.7}`}
                fill="none"
                stroke="#d9a35f"
                strokeWidth={1.2}
                opacity={0.85 - i * 0.22}
              />
            );
          })
        : null}
      <polygon points={pts([P(0, RY, 0), P(bx, RY, 0), P(bx, RY, bh), P(0, RY, bh)])} className="pet-glass" />
      <polygon points={pts([P(bx, by, 0), P(bx, RY, 0), P(bx, RY, bh), P(bx, by, bh)])} className="pet-glass-dark" />
      {seg('post1', P(bx, RY, 0), P(bx, RY, bh), '#6f6557', 1.6)}
      {seg('post2', P(bx, by, 0), P(bx, by, bh), '#6f6557', 1.6)}
      {seg('post3', P(0, RY, 0), P(0, RY, bh), '#6f6557', 1.6)}
      {box('roofb', 0, by, bh, bx, RY - by, 0.14, mat.roof)}
      {box('onair', 0.45, 5.05, bh + 0.14, 0.6, 0.2, 0.18, voicing ? mat.rec : mat.dark)}
    </g>,
  );

  const leafSway = Math.sin(t / 1900) * 0.9;
  // 休息区：右前方的沙发，坐着闲着的摄影；茶几上一杯咖啡。
  add(
    9.6,
    <g key="sofa">
      {box('sback', 5.4, 4.3, 0, 2.0, 0.25, 0.9, mat.canvas)}
      {box('sseat', 5.4, 4.55, 0, 2.0, 0.6, 0.42, mat.canvas)}
      {box('sarmL', 5.25, 4.3, 0, 0.15, 0.85, 0.6, mat.canvas)}
    </g>,
  );
  add(12.3, box('sarmR', 7.4, 4.3, 0, 0.15, 0.85, 0.6, mat.canvas));
  add(
    12.7,
    <g key="coffee">
      {box('ctable', 5.75, 5.5, 0, 1.3, 0.35, 0.36, mat.walnut)}
      {box('cup', 6.1, 5.6, 0.36, 0.12, 0.12, 0.12, mat.paper)}
      {still ? null : steam(P(6.16, 5.66, 0.52), t)}
    </g>,
  );
  add(
    13.5,
    <g key="plant">
      {box('ppot', 7.45, 5.45, 0, 0.35, 0.35, 0.38, mat.pot)}
      <ellipse
        cx={P(7.62, 5.62, 0.75)[0] + leafSway * 0.5}
        cy={P(7.62, 5.62, 0.75)[1]}
        rx={9}
        ry={11}
        fill={mat.plant[1]}
      />
      <ellipse
        cx={P(7.62, 5.62, 0.85)[0] - 2 + leafSway}
        cy={P(7.62, 5.62, 0.85)[1] - 2}
        rx={6}
        ry={7.5}
        fill={mat.plant[0]}
      />
    </g>,
  );

  // 人：制作人与三位摄影，按站位排进去。
  const dIdle = mood === 'idle' ? directorIdle[idle.director.act] : null;
  const dPose: Pose = !dirArrived ? 'walk' : dIdle ? dIdle.pose : directorPose[mood];
  const chatting = dIdle !== null && idle.director.act === 'chat' && dirArrived;
  add(
    w.director.x + w.director.y + 0.05,
    <g key="director" data-who="director" data-walking={dirArrived ? 'false' : 'true'}>
      {person('dir', w.director.x, w.director.y, w.director.a, dPose, t, looks.director)}
      {dirArrived && (mood === 'waiting' || mood === 'done')
        ? slateProp(w.director, mood === 'done' && frame % 4 < 2, t)
        : null}
      {dirArrived && (mood === 'reading' || dIdle?.prop === 'script') ? scriptProp(w.director, t) : null}
      {dirArrived && dIdle && dIdle.prop !== 'script'
        ? idleProp(dIdle.prop, w.director.x, w.director.y, w.director.a, dPose, t)
        : null}
      {dirArrived && mood === 'thinking' ? thoughtDots(w.director, frame) : null}
      {dirArrived && mood === 'failed' ? mark(w.director, '×', '#e39a8c') : null}
      {dirArrived && mood === 'stopped' ? mark(w.director, '‖', '#a9a294') : null}
    </g>,
  );
  w.ops.forEach((op, i) => {
    const moving = !arrived(op);
    const act = operatorIdle[idle.ops[i].act];
    const onSofa = !moving && !filmingOps[i] && op.spot === operators[i].seat;
    // 制作人过来聊天时，沙发上的人都转过脸去，一个说一个笑。
    const listening = chatting && onSofa;
    const pose: Pose = moving
      ? 'walk'
      : filmingOps[i]
        ? 'operate'
        : listening
          ? i % 2 === 0
            ? 'laugh'
            : 'talk'
          : act.pose;
    // 自己聊天时朝旁边的人扭头（最右边那位朝左，其余朝右）；听制作人说话时都朝左边的制作人。
    const turn = !onSofa ? 0 : listening ? 0.8 : act.turn ? (i === operators.length - 1 ? act.turn : -act.turn) : 0;
    const angle = op.a + turn;
    const ot = t + i * 400;
    add(
      op.x + op.y + 0.04,
      <g
        key={`op${i}`}
        data-who={`op${i + 1}`}
        data-active={filmingOps[i] ? 'true' : 'false'}
        data-walking={moving ? 'true' : 'false'}
      >
        {person(`op${i}`, op.x, op.y, angle, pose, ot, looks[`op${i + 1}`])}
        {onSofa && !listening ? idleProp(act.prop, op.x, op.y, angle, pose, ot) : null}
      </g>,
    );
  });
  items.sort((a, b) => a.k - b.k);
  return { items, dPose };
}

export function buildTags(
  ops: Walker[],
  filmingOps: boolean[],
  shooting: string[],
  editing: boolean,
  voicing: boolean,
): { key: string; text: string; title: string; at: Pt }[] {
  // 标签挂在脚下（头顶归制作人的气泡）：开机的摄影写镜头号，干活的剪辑、配音写部门名。坐标是画布上的，画的时候换成屏幕上的。
  const tags: { key: string; text: string; title: string; at: Pt }[] = [];
  ops.forEach((op, i) => {
    if (!filmingOps[i] || !shooting[i]) return;
    const short = shooting[i].replace(/^scene-/, '');
    const text = i === 2 && shooting.length > 3 ? `${short}+${shooting.length - 3}` : short;
    tags.push({
      key: `op${i + 1}`,
      text,
      title: shooting.slice(i, i === 2 ? undefined : i + 1).join('、'),
      at: P(op.x + 0.15, op.y + 0.15),
    });
  });
  if (editing) tags.push({ key: 'editor', text: '剪辑', title: '剪辑', at: P(7.3, 1.6) });
  if (voicing) tags.push({ key: 'voice', text: '配音', title: '配音', at: P(1.5, RY) });
  return tags;
}
