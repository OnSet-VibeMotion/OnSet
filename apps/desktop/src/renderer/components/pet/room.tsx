import type { ReactElement } from 'react';
import { cameraY } from './crewState';
import { box, mat, P, type Pt, pts, RX, RY, room, seg, WALL, wallAt, wallQuad } from './iso';

/** 不会变的部分：地台、两面墙（带墙头）、墙上的海报与钟、影棚的卷纸背景。 */
export function roomShell(): ReactElement {
  const out: ReactElement[] = [];
  // 地台：一块有厚度的板子，房间像放在桌上的模型。
  out.push(
    box('slab', 0, 0, -0.32, RX, RY, 0.32, [room.slab, room['slab-left'], room['slab-right']], 'rgba(0,0,0,0.3)'),
  );
  for (let i = 0; i < RX; i++) {
    for (let j = 0; j < RY; j++) {
      if ((i + j) % 2 === 0) continue;
      out.push(
        <polygon
          key={`t${i}-${j}`}
          points={pts([P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)])}
          fill="rgba(255,240,220,0.025)"
        />,
      );
    }
  }
  // 两面墙：墙面加一条墙头，墙根一道暗影。
  out.push(
    <polygon key="wl" points={pts([P(0, 0), P(0, RY), P(0, RY, WALL), P(0, 0, WALL)])} fill={room['wall-left']} />,
  );
  out.push(
    <polygon key="wb" points={pts([P(0, 0), P(RX, 0), P(RX, 0, WALL), P(0, 0, WALL)])} fill={room['wall-back']} />,
  );
  out.push(
    <polygon
      key="wlcap"
      points={pts([P(-0.15, -0.15, WALL), P(0, 0, WALL), P(0, RY, WALL), P(-0.15, RY, WALL)])}
      fill={room.cap}
    />,
  );
  out.push(
    <polygon
      key="wbcap"
      points={pts([P(-0.15, -0.15, WALL), P(RX, -0.15, WALL), P(RX, 0, WALL), P(0, 0, WALL)])}
      fill={room.cap}
    />,
  );
  out.push(
    <polygon
      key="wlend"
      points={pts([P(-0.15, RY, -0.32), P(0, RY, -0.32), P(0, RY, WALL), P(-0.15, RY, WALL)])}
      fill="#1a1612"
    />,
  );
  out.push(
    <polygon
      key="wbend"
      points={pts([P(RX, -0.15, -0.32), P(RX, 0, -0.32), P(RX, 0, WALL), P(RX, -0.15, WALL)])}
      fill="#1f1a15"
    />,
  );
  out.push(<polygon key="aol" points={pts([P(0, 0), P(0.35, 0.35), P(0.35, RY), P(0, RY)])} fill="rgba(0,0,0,0.18)" />);
  out.push(<polygon key="aob" points={pts([P(0, 0), P(RX, 0), P(RX, 0.35), P(0.35, 0.35)])} fill="rgba(0,0,0,0.18)" />);
  // 影棚：卷纸背景从后墙垂下来铺到地上，上面一根卷轴。
  out.push(<polygon key="paper" points={pts(wallQuad('back', 2.9, 5.8, 0, 2.7))} fill={room.backdrop} />);
  out.push(
    <polygon key="sweep" points={pts([P(2.9, 0), P(5.8, 0), P(5.8, 1.15), P(2.9, 1.15)])} fill={room.backdrop} />,
  );
  out.push(
    <polygon
      key="sweepFade"
      points={pts([P(2.9, 0.85), P(5.8, 0.85), P(5.8, 1.15), P(2.9, 1.15)])}
      fill="rgba(0,0,0,0.14)"
    />,
  );
  out.push(box('roll', 2.75, 0.02, 2.72, 3.2, 0.12, 0.12, mat.metal));
  // 后墙的海报（一个太阳、两行字），在制作人台上方。
  out.push(
    <polygon
      key="poster"
      points={pts(wallQuad('back', 1.0, 1.9, 1.3, 2.5))}
      fill="#2a2520"
      stroke="#6f6557"
      strokeWidth={1.4}
    />,
  );
  const pc = wallAt('back', 1.45, 2.06);
  out.push(<ellipse key="sun" cx={pc[0]} cy={pc[1]} rx={4.6} ry={5.6} fill="#d9a35f" />);
  out.push(seg('pt1', wallAt('back', 1.15, 1.6), wallAt('back', 1.75, 1.6), '#8a8377', 1.4));
  out.push(seg('pt2', wallAt('back', 1.25, 1.48), wallAt('back', 1.65, 1.48), '#5d574d', 1.4));
  // 后墙的钟。
  const ck = wallAt('back', 7.3, 2.45);
  out.push(
    <ellipse key="clock" cx={ck[0]} cy={ck[1]} rx={6.5} ry={7.5} fill="#efe9dd" stroke="#6f6557" strokeWidth={1.4} />,
  );
  return <g>{out}</g>;
}

/** 后墙的钟走的是真实时间：时针、分针，外加一根一秒一跳的秒针。 */
export function clockHands(now: Date): ReactElement {
  const ck = wallAt('back', 7.3, 2.45);
  const hand = (turns: number, len: number): Pt => [
    ck[0] + Math.sin(turns * 2 * Math.PI) * len * 0.87,
    ck[1] - Math.cos(turns * 2 * Math.PI) * len,
  ];
  const sec = now.getSeconds() / 60;
  const min = (now.getMinutes() + sec) / 60;
  const hour = ((now.getHours() % 12) + min) / 12;
  return (
    <g key="clockHands">
      {seg('hh', ck, hand(hour, 3.6), '#2a2520', 1.3)}
      {seg('hm', ck, hand(min, 5.4), '#2a2520', 1)}
      {seg('hs', ck, hand(sec, 5.8), '#c0705f', 0.6)}
    </g>
  );
}

/** 屏幕：墙上一块深色，里面若干行字或片段条。 */
function screen(
  key: string,
  on: 'left' | 'back',
  a: number,
  b: number,
  z0: number,
  z1: number,
  rows: { from: number; to: number; z: number; color: string }[],
): ReactElement {
  return (
    <g key={key}>
      <polygon points={pts(wallQuad(on, a - 0.05, b + 0.05, z0 - 0.06, z1 + 0.06))} fill="#3e3832" />
      <polygon points={pts(wallQuad(on, a, b, z0, z1))} fill="#0b0a09" />
      {rows.map((row, i) => seg(`${key}${i}`, wallAt(on, row.from, row.z), wallAt(on, row.to, row.z), row.color, 2))}
    </g>
  );
}

/** 左墙的分镜板：软木板上两排卡片。排分镜时卡片亮起来，正在排的那张是黄铜色，一张张换过去。 */
export function storyboardWall(active: boolean, frame: number): ReactElement {
  const out: ReactElement[] = [
    <polygon key="sbframe" points={pts(wallQuad('left', 2.05, 4.2, 0.85, 2.45))} fill="#5c4632" />,
    <polygon key="sbcork" points={pts(wallQuad('left', 2.12, 4.13, 0.92, 2.38))} fill="#6b5537" />,
  ];
  const cols = 4;
  const current = frame % (cols * 2);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const a = 2.22 + col * 0.48;
      const z1 = 2.27 - row * 0.7;
      const card = active && i === current ? '#d9a35f' : active ? '#efe9dd' : '#a9a294';
      out.push(<polygon key={`card${i}`} points={pts(wallQuad('left', a, a + 0.4, z1 - 0.55, z1))} fill={card} />);
      out.push(
        <polygon
          key={`img${i}`}
          points={pts(wallQuad('left', a + 0.05, a + 0.35, z1 - 0.35, z1 - 0.05))}
          fill={active && i === current ? '#94693a' : '#5a5247'}
        />,
      );
      out.push(seg(`txt${i}`, wallAt('left', a + 0.06, z1 - 0.45), wallAt('left', a + 0.3, z1 - 0.45), '#8a8377', 1));
      const pin = wallAt('left', a + 0.2, z1 - 0.02);
      out.push(<circle key={`pin${i}`} cx={pin[0]} cy={pin[1]} r={1.3} fill="#e39a8c" />);
    }
  }
  return <g key="storyboard">{out}</g>;
}

/** 制作人台的显示器：跑命令时字往上滚，最后一行闪光标。 */
export function consoleScreen(active: boolean, frame: number): ReactElement {
  const widths = [0.7, 0.45, 0.85, 0.35, 0.6, 0.75];
  const rows = [0, 1, 2, 3].map((i) => {
    const w = widths[(i + (active ? frame : 0)) % widths.length];
    return { from: 0.75, to: 0.75 + w * 0.9, z: 1.95 - i * 0.18, color: active ? '#c2bbae' : '#2a2520' };
  });
  if (active && frame % 2 === 0) rows.push({ from: 0.75, to: 0.85, z: 1.23, color: '#d9a35f' });
  return screen('console', 'left', 0.65, 1.85, 1.1, 2.1, rows);
}

/** 剪辑台的两块屏：左边时间线（片段条与走动的播放头），右边是画面。 */
export function editScreens(active: boolean, frame: number): ReactElement[] {
  const c = (on: string) => (active ? on : '#2a2520');
  const head = 6.3 + ((frame % 20) / 20) * 0.8;
  const left = (
    <g key="edl">
      {screen('edl1', 'back', 6.2, 7.2, 1.15, 1.95, [
        { from: 6.3, to: 6.65, z: 1.75, color: c('#d9a35f') },
        { from: 6.7, to: 7.1, z: 1.75, color: c('#c2bbae') },
        { from: 6.3, to: 6.9, z: 1.55, color: c('#8a7f70') },
        { from: 6.95, to: 7.1, z: 1.55, color: c('#d9a35f') },
        { from: 6.3, to: 7.1, z: 1.35, color: '#2a2520' },
      ])}
      {active ? seg('playhead', wallAt('back', head, 1.9), wallAt('back', head, 1.22), '#e39a8c', 1.2) : null}
    </g>
  );
  const pic = wallAt('back', 7.62, 1.55);
  const right = (
    <g key="edr">
      {screen('edr1', 'back', 7.3, 7.95, 1.15, 1.95, [])}
      {active ? <ellipse cx={pic[0]} cy={pic[1]} rx={4} ry={4.6} fill="#d9a35f" /> : null}
    </g>
  );
  return [left, right];
}

/** 摄影机：三脚架上的机身，镜头朝后墙。在拍时录制灯闪。 */
export function cameraRig(key: string, cx: number, active: boolean, frame: number): ReactElement {
  const head = P(cx, cameraY + 0.12, 1.3);
  const feet: Pt[] = [P(cx - 0.32, cameraY + 0.35), P(cx + 0.3, cameraY + 0.3), P(cx, cameraY - 0.3)];
  const rec = P(cx + 0.25, cameraY - 0.02, 1.78);
  return (
    <g key={key}>
      {feet.map((f, i) => seg(`${key}f${i}`, head, f, '#4a4239', 2))}
      {box(`${key}b`, cx - 0.25, cameraY - 0.12, 1.3, 0.5, 0.42, 0.42, mat.dark)}
      {box(`${key}l`, cx - 0.1, cameraY - 0.4, 1.38, 0.22, 0.28, 0.24, mat.metal)}
      {box(`${key}r`, cx - 0.18, cameraY - 0.02, 1.72, 0.36, 0.22, 0.12, mat.metal)}
      {active && frame % 16 < 9 ? (
        <circle cx={rec[0]} cy={rec[1]} r={2} fill="#e39a8c" />
      ) : (
        <circle cx={rec[0]} cy={rec[1]} r={1.6} fill="#4a3a35" />
      )}
    </g>
  );
}

export function softbox(key: string, x: number, on: boolean): ReactElement {
  return (
    <g key={key}>
      {seg(`${key}p`, P(x, 0.55, 0), P(x, 0.55, 2.2), '#3e3832', 2)}
      {seg(`${key}a`, P(x - 0.25, 0.75, 0), P(x, 0.55, 0.25), '#3e3832', 1.6)}
      {seg(`${key}b`, P(x + 0.25, 0.75, 0), P(x, 0.55, 0.25), '#3e3832', 1.6)}
      {box(`${key}h`, x - 0.3, 0.45, 2.15, 0.6, 0.22, 0.42, on ? mat.lit : mat.dark)}
    </g>
  );
}
