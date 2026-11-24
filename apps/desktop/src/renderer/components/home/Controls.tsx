import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../../api';
import type { CanvasOption, DirectoryListing } from '../../types';
import { Icon } from '../Icon';
import { NativeDirectoryPicker, usesNativeDirectoryPicker } from '../NativeDirectoryPicker';

export function RotatingWord({ words }: { words: string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % words.length), 4000);
    return () => window.clearInterval(timer);
  }, [words.length]);
  return (
    <span className="rotating" aria-hidden="true">
      <span key={index} className="rotating-word">
        {words[index]}
      </span>
      <i className="rotating-caret" />
    </span>
  );
}

/** 占位文字的打字机：逐字打出、停留、逐字删掉，换下一条。聚焦时停在当前这条。 */
export function Typewriter({ lines, paused }: { lines: string[]; paused: boolean }) {
  const [state, setState] = useState({ line: 0, chars: 0, deleting: false });
  useEffect(() => setState({ line: 0, chars: 0, deleting: false }), [lines.join('|')]);
  useEffect(() => {
    if (paused) return;
    const line = lines[state.line % lines.length] ?? '';
    let delay = state.deleting ? 22 : 42;
    let next = state;
    if (!state.deleting && state.chars < line.length) next = { ...state, chars: state.chars + 1 };
    else if (!state.deleting) {
      if (lines.length === 1) return;
      delay = 1900;
      next = { ...state, deleting: true };
    } else if (state.chars > 0) next = { ...state, chars: state.chars - 1 };
    else {
      delay = 320;
      next = { line: (state.line + 1) % lines.length, chars: 0, deleting: false };
    }
    const timer = window.setTimeout(() => setState(next), delay);
    return () => window.clearTimeout(timer);
  }, [state, paused, lines]);
  const line = lines[state.line % lines.length] ?? '';
  return (
    <span className="typewriter" aria-hidden="true">
      {paused ? line : line.slice(0, state.chars)}
      {!paused && <i className="type-caret" />}
    </span>
  );
}

export function Dropdown(props: {
  id: string;
  label: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  children: ReactNode;
  align?: 'left' | 'right';
  flat?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) props.onOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && props.onOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [props.open]);
  return (
    <div className="dropdown" ref={box}>
      <button
        id={'home-' + props.id}
        className={'chip-button' + (props.flat ? ' flat' : '')}
        aria-expanded={props.open}
        aria-haspopup="menu"
        onClick={() => props.onOpen(!props.open)}
      >
        {props.label}
        <Icon name="chevron" size={10} />
      </button>
      {props.open && (
        <div className={'dropdown-menu' + (props.align === 'right' ? ' right' : '')} role="menu">
          {props.children}
        </div>
      )}
    </div>
  );
}

export function MenuItem(props: {
  title: string;
  desc?: string;
  icon?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitemradio"
      aria-checked={!!props.selected}
      className={'menu-item' + (props.selected ? ' selected' : '')}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon && <span className="menu-icon">{props.icon}</span>}
      <span className="menu-text">
        <span>{props.title}</span>
        {props.desc && <span className="menu-desc">{props.desc}</span>}
      </span>
      {props.selected && <span className="menu-check">✓</span>}
    </button>
  );
}

/** 保存位置：最近用过的目录加一个简单的目录浏览。 */
export function FolderPicker(props: {
  value: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (path: string) => void;
}) {
  const native = usesNativeDirectoryPicker();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState('');
  const browse = async (path: string) => {
    try {
      setListing(await api('/api/directories' + (path ? '?path=' + encodeURIComponent(path) : '')));
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    if (props.open && !native) void browse(props.value);
  }, [props.open, native]);
  const name = props.value ? props.value.split('/').filter(Boolean).pop() : '';
  if (native) {
    return (
      <NativeDirectoryPicker
        id="home-folder"
        value={props.value}
        label={'保存到：' + (name || '选择文件夹')}
        className="chip-button flat"
        onChange={props.onChange}
        onBeforePick={() => props.onOpen(false)}
      />
    );
  }
  return (
    <Dropdown id="folder" open={props.open} onOpen={props.onOpen} flat label={<>保存到：{name || '选择文件夹'}</>}>
      <div className="folder-browser">
        <div className="folder-path mono ellipsis" title={listing?.path}>
          {listing?.path ?? '…'}
        </div>
        {listing && listing.path !== listing.root && (
          <button className="menu-item" onClick={() => void browse(listing.parent)}>
            <span className="menu-text">
              <span>‹ 上一级</span>
            </span>
          </button>
        )}
        <div className="folder-list">
          {listing?.entries
            .filter((entry) => !entry.is_project)
            .map((entry) => (
              <button key={entry.path} className="menu-item" onClick={() => void browse(entry.path)}>
                <span className="menu-icon">
                  <Icon name="folder" size={13} />
                </span>
                <span className="menu-text">
                  <span>{entry.name}</span>
                </span>
              </button>
            ))}
        </div>
        {error && <p className="error-line">{error}</p>}
        <button
          className="folder-choose"
          disabled={!listing}
          onClick={() => {
            if (listing) props.onChange(listing.path);
            props.onOpen(false);
          }}
        >
          存到这里
        </button>
      </div>
    </Dropdown>
  );
}

export function CanvasGlyph({ canvas }: { canvas?: CanvasOption }) {
  const w = canvas ? canvas.width : 3;
  const h = canvas ? canvas.height : 4;
  const scale = 12 / Math.max(w, h);
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x={7 - (w * scale) / 2}
        y={7 - (h * scale) / 2}
        width={w * scale}
        height={h * scale}
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}
