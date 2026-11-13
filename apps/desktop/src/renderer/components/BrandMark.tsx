import { useId } from 'react';

/**
 * 顶栏的品牌标：应用图标（apps/desktop/build/icon.svg）的小尺寸版本。
 * 26px 下顶光、帧格与投影都看不见，只留底、衬线 A 与胶片；片孔改少改大，免得糊成一条线。
 * 改图标时两边一起改。
 */
export function BrandMark(props: { size?: number }) {
  const id = useId().replace(/:/g, '');
  const size = props.size ?? 26;
  return (
    <svg width={size} height={size} viewBox="100 100 824 824" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a241d" />
          <stop offset="1" stopColor="#0e0c0a" />
        </linearGradient>
        <linearGradient id={`${id}brass`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f0cf98" />
          <stop offset=".5" stopColor="#d9a35f" />
          <stop offset="1" stopColor="#b07d40" />
        </linearGradient>
        <clipPath id={`${id}sq`}>
          <rect x="100" y="100" width="824" height="824" rx="185" />
        </clipPath>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill={`url(#${id}bg)`} />
      <g clipPath={`url(#${id}sq)`}>
        <g fill="#f1e8d6" transform="translate(512 520) scale(.88) translate(-512 -520)">
          <path d="M476 226 L540 226 L760 786 L648 786 L486 374 L340 786 L278 786 Z" />
          <rect x="226" y="764" width="156" height="34" rx="6" />
          <rect x="594" y="764" width="218" height="34" rx="6" />
        </g>
        <rect x="100" y="532" width="824" height="120" fill={`url(#${id}brass)`} />
        <g fill="#14110d">
          {[150, 260, 370, 480, 590, 700, 810].map((x) => (
            <g key={x}>
              <rect x={x} y="546" width="52" height="28" rx="8" />
              <rect x={x} y="610" width="52" height="28" rx="8" />
            </g>
          ))}
        </g>
      </g>
      <rect x="104" y="104" width="816" height="816" rx="181" fill="none" stroke="#4a3a24" strokeWidth="8" />
    </svg>
  );
}
