import { useId } from 'react';

/**
 * 顶栏的品牌标：应用图标（apps/desktop/build/icon.svg）的小尺寸版本——场记板做成的一座小片场。
 * 26px 下投影、地上的光与窗格都看不见，只留底、拍杆、顶条、楼身、亮着的门与两扇窗；
 * 斜条改成 4 道（6 道在这个尺寸会糊成灰）。改图标时两边一起改。
 */
const ink = '#1a1612';
const X0 = 236;
const X1 = 788;
const Y0 = 466;
const Y1 = 786;
const BH = 76;
const W = X1 - X0;
const N = 4;
const step = W / N;

/** 斜条：顶条与拍杆用同一组 x，合上时对得齐。 */
function stripes(y: number, fill: string) {
  return Array.from({ length: N }, (_, i) => {
    const a = X0 + step * (i + 0.25);
    const b = X0 + step * (i + 0.75);
    return <polygon key={i} points={`${a},${y} ${b},${y} ${b - 26},${y + BH} ${a - 26},${y + BH}`} fill={fill} />;
  });
}

export function BrandMark(props: { size?: number }) {
  const id = useId().replace(/:/g, '');
  const size = props.size ?? 26;
  const armY = Y0 - BH - 14;
  return (
    <svg width={size} height={size} viewBox="100 100 824 824" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a231b" />
          <stop offset="1" stopColor="#0e0c0a" />
        </linearGradient>
        <linearGradient id={`${id}brass`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2d29c" />
          <stop offset=".55" stopColor="#d9a35f" />
          <stop offset="1" stopColor="#a8763b" />
        </linearGradient>
        <linearGradient id={`${id}ivory`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f8f1e4" />
          <stop offset="1" stopColor="#dccfb6" />
        </linearGradient>
        <linearGradient id={`${id}lamp`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe7b8" />
          <stop offset=".55" stopColor="#f3c47a" />
          <stop offset="1" stopColor="#d99a4e" />
        </linearGradient>
        <clipPath id={`${id}band`}>
          <rect x={X0} y={Y0} width={W} height={BH} rx="16" />
        </clipPath>
        <clipPath id={`${id}arm`}>
          <rect x={X0} y={armY} width={W + 4} height={BH} rx="16" />
        </clipPath>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill={`url(#${id}bg)`} />
      {/* 楼身、顶条、两扇窗与门 */}
      <rect x={X0} y={Y0} width={W} height={Y1 - Y0} rx="30" fill={`url(#${id}ivory)`} />
      <rect x={X0} y={Y0} width={W} height={BH} rx="16" fill={ink} />
      <g clipPath={`url(#${id}band)`}>{stripes(Y0, `url(#${id}ivory)`)}</g>
      <rect x="278" y="596" width="104" height="104" rx="12" fill={`url(#${id}lamp)`} />
      <rect x="642" y="596" width="104" height="104" rx="12" fill={`url(#${id}lamp)`} />
      <path d={`M440 ${Y1} v-120 a72 72 0 0 1 144 0 v120 z`} fill={`url(#${id}lamp)`} />
      {/* 张开的拍杆 */}
      <g transform={`rotate(-14 ${X0} ${Y0 - 14})`}>
        <rect x={X0} y={armY} width={W + 4} height={BH} rx="16" fill={`url(#${id}brass)`} />
        <g clipPath={`url(#${id}arm)`}>{stripes(armY, ink)}</g>
      </g>
      <circle cx={X0 + 12} cy={Y0 - 8} r="21" fill={ink} />
      <rect x="104" y="104" width="816" height="816" rx="181" fill="none" stroke="#4a3a24" strokeWidth="8" />
    </svg>
  );
}
