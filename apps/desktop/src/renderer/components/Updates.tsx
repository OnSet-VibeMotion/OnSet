import { useEffect, useState } from 'react';
import type { UpdateState } from '../types';
import { ago } from './Market';

/**
 * 客户端更新（主进程 main/updater.ts 经 preload 的 updateState / updateAction / onUpdate）：设置页「网络与更新」的一块，
 * 与顶栏齿轮上的小点（有新版本或下好了）。浏览器里（没有 preload）什么都不显示。
 */

export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const bridge = window.onset;
    if (!bridge?.updateState) return;
    let alive = true;
    void bridge.updateState().then((s) => alive && setState(s), () => {});
    const off = bridge.onUpdate?.((s) => setState(s));
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return state;
}

/** 有要用户看的更新：顶栏齿轮上点一个小点。 */
export function updateNeedsAttention(s: UpdateState | null): boolean {
  return s?.status === 'available' || s?.status === 'downloaded';
}

export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function UpdatePanel({ state }: { state: UpdateState | null }) {
  const [busy, setBusy] = useState<string[] | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  if (!state) return null;
  const act = (action: 'check' | 'download' | 'install' | 'open-release', force?: boolean) => window.onset?.updateAction?.(action, force);
  const install = async (force = false) => {
    const r = await act('install', force);
    if (r && !r.ok && r.busy && r.busy.length > 0) setBusy(r.busy);
  };
  const releaseLink = (
    <button className="link" onClick={() => void act('open-release')}>
      去发布页下载
    </button>
  );
  const s = state;
  return (
    <div className="settings-card update-panel" data-update={s.status} aria-label="版本更新">
      <div className="update-head">
        <div className="update-title">
          <strong>片场 {s.current}</strong>
          <span role="status">
            {s.status === 'disabled' && s.disabled_reason}
            {s.status === 'idle' && '还没检查过新版本'}
            {s.status === 'checking' && '正在检查新版本…'}
            {s.status === 'latest' && `已是最新版本${s.checked_at ? `（${ago(s.checked_at)}检查）` : ''}`}
            {s.status === 'available' && `有新版本 ${s.version}`}
            {s.status === 'downloading' && `正在下载 ${s.version}…`}
            {s.status === 'downloaded' && `新版本 ${s.version} 已经下载好，重启后换上`}
            {s.status === 'error' && '没有成功'}
          </span>
        </div>
        <div className="update-actions">
          {(s.status === 'idle' || s.status === 'latest' || (s.status === 'error' && s.version === '')) && (
            <button onClick={() => void act('check')}>检查更新</button>
          )}
          {s.status === 'available' && (
            <button className="primary" onClick={() => void act('download')}>
              下载
            </button>
          )}
          {s.status === 'error' && s.version !== '' && <button onClick={() => void act('download')}>重试下载</button>}
          {s.status === 'downloaded' && busy === null && (
            <button className="primary" onClick={() => void install()}>
              重启并安装
            </button>
          )}
        </div>
      </div>
      {s.status === 'downloading' && (
        <div className="update-progress">
          <div className="update-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.percent}>
            <span style={{ width: `${s.percent}%` }} />
          </div>
          <span>
            {s.percent}%{s.total > 0 && ` · ${sizeText(s.transferred)} / ${sizeText(s.total)}`}
            {s.bytes_per_second > 0 && ` · ${sizeText(s.bytes_per_second)}/s`}
          </span>
        </div>
      )}
      {s.status === 'error' && (
        <p className="update-error" role="alert">
          {s.error} {releaseLink}
        </p>
      )}
      {s.status === 'disabled' && <p className="update-note">{releaseLink}</p>}
      {busy !== null && (
        <div className="update-confirm" role="alertdialog" aria-label="重启会打断正在做的事">
          <strong>重启会打断这些正在做的事：</strong>
          <ul>
            {busy.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <span>打断的对话可以接着说，渲染了一半的镜头下次会接着做。也可以等它们做完再装；不装的话下次退出片场时会自动装上。</span>
          <div className="update-actions">
            <button className="primary" onClick={() => void install(true)}>
              仍然重启
            </button>
            <button onClick={() => setBusy(null)}>等会儿</button>
          </div>
        </div>
      )}
      {(s.status === 'available' || s.status === 'downloading' || s.status === 'downloaded') && s.notes && (
        <div className="update-notes">
          <button className="link" aria-expanded={showNotes} onClick={() => setShowNotes(!showNotes)}>
            {showNotes ? '收起更新说明' : '这一版改了什么'}
          </button>
          {showNotes && <pre>{s.notes}</pre>}
        </div>
      )}
    </div>
  );
}
