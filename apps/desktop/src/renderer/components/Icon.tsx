// 线条图标，跟随文字颜色。只收界面里真正用到的几个。
const paths = {
  chevron: <path d="M3 4.5l3 3 3-3" />,
  prev: <path d="M7.5 2.5L4 6l3.5 3.5" />,
  next: <path d="M4.5 2.5L8 6 4.5 9.5" />,
  play: <path d="M3.5 2l6.5 4-6.5 4z" fill="currentColor" stroke="none" />,
  pause: <path d="M3.5 2.5v7M8.5 2.5v7" strokeWidth="2" />,
  stop: <rect x="2.5" y="2.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />,
  send: <path d="M6 10V2.5M2.5 6L6 2.5 9.5 6" />,
  close: <path d="M3 3l6 6M9 3L3 9" />,
  check: <path d="M2.5 6.2l2.3 2.3 4.7-5" />,
  panel: <path d="M1.5 2.5h9v7h-9zM7 2.5v7" />,
  plus: <path d="M6 2v8M2 6h8" />,
  search: <path d="M5.2 9a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6zM8 8l2.5 2.5" />,
  history: <path d="M2 6a4 4 0 1 0 1.2-2.85M2 1.8v1.7h1.7M6 3.8V6l1.6 1" />,
  down: <path d="M6 2.5v7M2.5 6L6 9.5 9.5 6" />,
  copy: <path d="M4 4V2.5h5.5V8H8M2.5 4h5.5v5.5H2.5z" />,
  brain: <path d="M4.5 2.5a2 2 0 0 0-2 2 1.8 1.8 0 0 0 .3 3.4 1.8 1.8 0 0 0 3.2 1.1V2.8a1.6 1.6 0 0 0-1.5-.3zM7.5 2.5a2 2 0 0 1 2 2 1.8 1.8 0 0 1-.3 3.4A1.8 1.8 0 0 1 6 9" />,
  file: <path d="M3 1.5h4l2 2v7H3zM7 1.5v2h2" />,
  alert: <path d="M6 1.5l4.8 8.5H1.2zM6 5v2.2M6 8.6v.1" />,
  edit: <path d="M7.8 2.2l2 2L4.5 9.5H2.5v-2z" />,
  trash: <path d="M2 3.5h8M4.5 3.5V2h3v1.5M3 3.5l.6 6.5h4.8L9 3.5" />,
  attach: <path d="M8.5 4.5L5 8a1.4 1.4 0 01-2-2l4-4a2.3 2.3 0 013.2 3.2L6 9.4" />,
  region: <rect x="1.5" y="1.5" width="9" height="9" rx="1" strokeDasharray="2 1.6" />,
  more: <path d="M2.5 6h.01M6 6h.01M9.5 6h.01" strokeWidth="2" />,
  pointer: <path d="M2 1.5l3.4 8.5 1.3-3.4 3.4-1.3z" />,
  up: <path d="M6 9.5V2.5M2.5 6L6 2.5 9.5 6" />,
  folder: <path d="M1.5 3.5h3l1 1.2h5v5.3h-9z" />,
  spark: <path d="M6 1.5l1.1 3.4 3.4 1.1-3.4 1.1L6 10.5 4.9 7.1 1.5 6l3.4-1.1z" />,
  'eye-off': (
    <>
      <path d="M1.2 6s1.8-3.3 4.8-3.3S10.8 6 10.8 6 9 9.3 6 9.3 1.2 6 1.2 6z" />
      <path d="M2 2l8 8" />
    </>
  ),
  brush: <path d="M10 1.8L5.6 6.3M5.6 6.3a1.6 1.6 0 0 0-2.3 0C2.5 7.1 3.1 8.5 1.8 9.9c1.6.4 3.4.1 4.1-.9a1.6 1.6 0 0 0-.3-2.7z" />,
  route: <path d="M3 2.2a1 1 0 1 0 0 .01M9 9.8a1 1 0 1 0 0 .01M3 3.4v1.6a1.5 1.5 0 0 0 1.5 1.5h3A1.5 1.5 0 0 1 9 8v.6" />,
  // 齿轮（照 Lucide 的 settings，ISC 许可；原图 24 格，缩一半，线宽随之加倍）。
  settings: (
    <g transform="scale(0.5)" strokeWidth="2.8">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </g>
  ),
  globe: <path d="M6 1.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9zM1.5 6h9M6 1.5c1.4 1.3 2 2.8 2 4.5s-.6 3.2-2 4.5M6 1.5C4.6 2.8 4 4.3 4 6s.6 3.2 2 4.5" />,
  plug: <path d="M4.5 1.5v2.5M7.5 1.5v2.5M3 4h6v1.8a3 3 0 0 1-6 0zM6 8.8v1.7" />,
  mic: <path d="M6 1.5a1.5 1.5 0 0 1 1.5 1.5v2.5a1.5 1.5 0 0 1-3 0V3A1.5 1.5 0 0 1 6 1.5zM3 5.5a3 3 0 0 0 6 0M6 8.5v2" />,
  layers: <path d="M6 1.5l4.5 2.3L6 6.1 1.5 3.8zM1.5 6L6 8.3 10.5 6M1.5 8.2L6 10.5l4.5-2.3" />,
  list: <path d="M4 3h6.5M4 6h6.5M4 9h6.5M1.6 3h.01M1.6 6h.01M1.6 9h.01" strokeWidth="1.5" />,
  pages: <path d="M2 2h3.5v3.5H2zM6.5 2H10v3.5H6.5zM2 6.5h3.5V10H2zM6.5 6.5H10V10H6.5z" />,
  film: (
    <>
      <rect x="1.5" y="2" width="9" height="8" rx="1" />
      <path d="M1.5 4.5h9M1.5 7.5h9M4 2v8" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 12 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
