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
  settings: (
    <>
      <circle cx="6" cy="6" r="1.6" />
      <path d="M6 1.2v1.4M6 9.4v1.4M1.2 6h1.4M9.4 6h1.4M2.6 2.6l1 1M8.4 8.4l1 1M2.6 9.4l1-1M8.4 3.6l1-1" />
    </>
  ),
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
