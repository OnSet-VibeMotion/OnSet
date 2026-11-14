import { useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../api';
import { hunks, lineDiff } from '../diff';
import type { TurnFile } from '../types';
import { Icon } from './Icon';

export function DiffDialog({ turnId, path, onClose }: { turnId: string; path: string; onClose: () => void }) {
  const [file, setFile] = useState<TurnFile | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<TurnFile>(`/api/turns/${turnId}/file?path=${encodeURIComponent(path)}`).then(setFile, (err) => setError(errorText(err)));
  }, [turnId, path]);
  const lines = useMemo(() => (file?.text ? hunks(lineDiff(file.before, file.after)) : []), [file]);
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal wide" role="dialog" aria-label="改动">
        <header className="modal-head">
          <code className="path">{path}</code>
          <span className="spacer" />
          <button className="ghost icon" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        {error && <p className="error-line">{error}</p>}
        {file && !file.text && <p className="muted pad">二进制文件，不显示差异。</p>}
        {file?.text && (
          <pre className="diff" id="diff">
            {lines.map((line, index) =>
              line.kind === '…' ? (
                <div key={index} className="skip">
                  ⋯ {line.count} 行未改动
                </div>
              ) : (
                <div key={index} className={line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}>
                  {line.kind} {line.text}
                </div>
              ),
            )}
          </pre>
        )}
      </section>
    </div>
  );
}
