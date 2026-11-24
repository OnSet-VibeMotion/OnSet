import type { ReactNode } from 'react';
import { ratioOf } from './helpers';

/**
 * 模板卡上的小样片：按模板真实的画幅画一块小屏幕，屏幕里是这种片子典型的一帧构图
 * （标题、图表、字幕、波形、歌词、对白），悬停时动起来。只用色板里的颜色。
 */
export function TemplateArt({ id, canvas }: { id: string; canvas: string }) {
  const [rw, rh] = ratioOf(canvas);
  const W = 200;
  const H = 120;
  let fh = 96;
  let fw = (fh * rw) / rh;
  if (fw > 156) {
    fw = 156;
    fh = (fw * rh) / rw;
  }
  const fx = (W - fw) / 2;
  const fy = (H - fh) / 2;
  const x = (f: number) => fx + f * fw;
  const y = (f: number) => fy + f * fh;
  const clip = `tpl-clip-${id}`;

  let scene: ReactNode;
  switch (id) {
    case 'explainer':
      scene = (
        <>
          <rect x={x(0.12)} y={y(0.1)} width={fw * 0.5} height={fh * 0.055} rx="1.5" className="tpl-accent" />
          <rect x={x(0.12)} y={y(0.2)} width={fw * 0.34} height={fh * 0.03} rx="1" className="tpl-dim" />
          {[0.32, 0.5, 0.74].map((hgt, i) => (
            <rect
              key={i}
              x={x(0.16 + i * 0.25)}
              y={y(0.78 - hgt * 0.62)}
              width={fw * 0.16}
              height={fh * hgt * 0.62}
              rx="1.5"
              className={'tpl-bar' + (i === 2 ? ' tpl-accent' : ' tpl-soft')}
              style={{ animationDelay: `${i * 90}ms` }}
            />
          ))}
          <path d={`M${x(0.1)} ${y(0.8)}H${x(0.9)}`} className="tpl-rule" />
          <rect x={x(0.22)} y={y(0.87)} width={fw * 0.56} height={fh * 0.035} rx="1" className="tpl-cap" />
        </>
      );
      break;
    case 'short':
      scene = (
        <>
          {[0, 1, 2, 3].map((i) => (
            <rect
              key={i}
              x={x(0.1 + i * 0.205)}
              y={y(0.05)}
              width={fw * 0.18}
              height="1.6"
              rx="0.8"
              className={i === 0 ? 'tpl-accent' : 'tpl-dim'}
            />
          ))}
          <text x={x(0.5)} y={y(0.47)} className="tpl-hook" textAnchor="middle" style={{ fontSize: fw * 0.42 }}>
            ?!
          </text>
          <rect x={x(0.2)} y={y(0.56)} width={fw * 0.6} height={fh * 0.025} rx="1" className="tpl-dim" />
          <rect x={x(0.14)} y={y(0.78)} width={fw * 0.72} height={fh * 0.06} rx={fh * 0.03} className="tpl-pill" />
          <rect x={x(0.22)} y={y(0.8)} width={fw * 0.44} height={fh * 0.02} rx="1" className="tpl-cap tpl-type" />
        </>
      );
      break;
    case 'landscape': {
      const pts = [0.72, 0.62, 0.66, 0.46, 0.5, 0.28].map((v, i) => `${x(0.48 + i * 0.085)},${y(v)}`).join(' ');
      scene = (
        <>
          <rect x={x(0.07)} y={y(0.2)} width={fw * 0.3} height={fh * 0.08} rx="1.5" className="tpl-accent" />
          <rect x={x(0.07)} y={y(0.36)} width={fw * 0.26} height={fh * 0.045} rx="1" className="tpl-dim" />
          <rect x={x(0.07)} y={y(0.46)} width={fw * 0.2} height={fh * 0.045} rx="1" className="tpl-dim" />
          <path d={`M${x(0.46)} ${y(0.16)}V${y(0.78)}H${x(0.94)}`} className="tpl-rule" />
          <polyline points={pts} className="tpl-line" pathLength={1} />
          <circle cx={x(0.905)} cy={y(0.28)} r="2.2" className="tpl-accent tpl-ping" />
          <rect x={x(0)} y={y(0.94)} width={fw} height={fh * 0.06} className="tpl-track" />
          <rect x={x(0)} y={y(0.94)} width={fw * 0.38} height={fh * 0.06} className="tpl-accent tpl-progress" />
        </>
      );
      break;
    }
    case 'beat': {
      const amps = [0.3, 0.6, 0.38, 0.9, 0.45, 0.7, 0.32, 0.95, 0.5, 0.66, 0.36, 0.85, 0.42];
      const n = amps.length;
      scene = (
        <>
          {[0.25, 0.5, 0.75].map((c) => (
            <path key={c} d={`M${x(c)} ${y(0.08)}V${y(0.92)}`} className="tpl-cut" />
          ))}
          <rect x={x(0.04)} y={y(0.1)} width={fw * 0.21} height={fh * 0.28} rx="1.5" className="tpl-soft" />
          <rect x={x(0.29)} y={y(0.1)} width={fw * 0.42} height={fh * 0.28} rx="1.5" className="tpl-accent-soft" />
          <rect x={x(0.75)} y={y(0.1)} width={fw * 0.21} height={fh * 0.28} rx="1.5" className="tpl-soft" />
          {amps.map((a, i) => {
            const bx = x(0.08 + (i * 0.84) / (n - 1));
            const half = fh * 0.2 * a;
            return (
              <path
                key={i}
                d={`M${bx} ${y(0.66) - half}V${y(0.66) + half}`}
                className={'tpl-wave' + (i % 4 === 3 ? ' strong' : '')}
                style={{ animationDelay: `${i * 60}ms` }}
              />
            );
          })}
          <path d={`M${x(0.5)} ${y(0.4)}V${y(0.92)}`} className="tpl-playhead" />
        </>
      );
      break;
    }
    case 'song':
      scene = (
        <>
          <circle cx={x(0.5)} cy={y(0.24)} r={fw * 0.2} className="tpl-disc" />
          <circle cx={x(0.5)} cy={y(0.24)} r={fw * 0.05} className="tpl-accent" />
          <rect x={x(0.2)} y={y(0.52)} width={fw * 0.6} height={fh * 0.025} rx="1" className="tpl-dim" />
          <rect x={x(0.12)} y={y(0.62)} width={fw * 0.76} height={fh * 0.04} rx="1.5" className="tpl-soft" />
          <rect
            x={x(0.12)}
            y={y(0.62)}
            width={fw * 0.76}
            height={fh * 0.04}
            rx="1.5"
            className="tpl-accent tpl-karaoke"
          />
          <rect x={x(0.24)} y={y(0.73)} width={fw * 0.52} height={fh * 0.025} rx="1" className="tpl-dim" />
          <rect x={x(0.3)} y={y(0.81)} width={fw * 0.4} height={fh * 0.025} rx="1" className="tpl-dim" />
        </>
      );
      break;
    default: {
      const r = fw * 0.075;
      scene = (
        <>
          <circle cx={x(0.16)} cy={y(0.22)} r={r} className="tpl-soft" />
          <rect x={x(0.28)} y={y(0.13)} width={fw * 0.56} height={fh * 0.16} rx={fh * 0.05} className="tpl-bubble a" />
          <rect x={x(0.33)} y={y(0.19)} width={fw * 0.38} height={fh * 0.025} rx="1" className="tpl-dim" />
          <circle cx={x(0.84)} cy={y(0.48)} r={r} className="tpl-accent" />
          <rect x={x(0.16)} y={y(0.39)} width={fw * 0.56} height={fh * 0.16} rx={fh * 0.05} className="tpl-bubble b" />
          <rect x={x(0.22)} y={y(0.45)} width={fw * 0.4} height={fh * 0.025} rx="1" className="tpl-ink" />
          <circle cx={x(0.16)} cy={y(0.74)} r={r} className="tpl-soft" />
          <rect x={x(0.28)} y={y(0.65)} width={fw * 0.4} height={fh * 0.16} rx={fh * 0.05} className="tpl-bubble a c" />
          {[0, 1, 2].map((i) => (
            <circle
              key={i}
              cx={x(0.38 + i * 0.09)}
              cy={y(0.73)}
              r="1.1"
              className="tpl-dot"
              style={{ animationDelay: `${i * 140}ms` }}
            />
          ))}
        </>
      );
    }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <rect x={fx} y={fy} width={fw} height={fh} rx="4" />
        </clipPath>
      </defs>
      <rect x={fx} y={fy + 3} width={fw} height={fh} rx="4" className="tpl-shadow" />
      <rect x={fx} y={fy} width={fw} height={fh} rx="4" className="tpl-screen" />
      <g clipPath={`url(#${clip})`}>{scene}</g>
      <rect x={fx + 0.5} y={fy + 0.5} width={fw - 1} height={fh - 1} rx="3.5" className="tpl-bezel" />
    </svg>
  );
}
