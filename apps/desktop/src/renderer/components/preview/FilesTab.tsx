import { useEffect, useState } from 'react';
import { api, errorText, post, rawURL } from '../../api';
import { playerProps } from '../../media';
import { canReveal, revealInFinder, revealLabel } from '../../reveal';
import type { TreeFile } from '../../types';
import { FileTree } from '../Sidebar';
import { Empty } from './shared';

const videoExt = /\.(mp4|mov|webm)$/i;
const imageExt = /\.(png|jpe?g|webp|gif|svg)$/i;
const audioExt = /\.(wav|mp3|m4a|aac|flac|ogg|opus)$/i;

interface FileResponse {
  path: string;
  size: number;
  binary: boolean;
  content: string;
}

/** mtime 是这个文件自己的修改时间（文件树里有就给）：内容与媒体地址只随它变，不随整个项目的 version 变。 */
export function FileView({ path, version, mtime }: { path: string; version: number; mtime?: number }) {
  const stamp = mtime ?? version;
  const [file, setFile] = useState<FileResponse | null>(null);
  const [error, setError] = useState('');
  const media = videoExt.test(path) || imageExt.test(path) || audioExt.test(path);
  useEffect(() => {
    setFile(null);
    setError('');
    if (!path || media) return;
    api<FileResponse>('/api/files?path=' + encodeURIComponent(path)).then(setFile, (err) => setError(errorText(err)));
  }, [path, stamp]);

  if (!path) return <Empty>在左边的文件树里选一个文件。</Empty>;
  return (
    <div className="file-tab">
      <div className="toolbar">
        <code className="path">{path}</code>
        <span className="spacer" />
        {canReveal && (
          <button id="reveal-file" onClick={() => revealInFinder(path)}>
            {revealLabel}
          </button>
        )}
        <a className="button" href={rawURL(path, stamp)} target="_blank" rel="noreferrer">
          新窗口打开
        </a>
      </div>
      {videoExt.test(path) && (
        <div className="stage-frame">
          <video {...playerProps} preload="metadata" src={rawURL(path, stamp)} />
        </div>
      )}
      {imageExt.test(path) && <img className="file-image" src={rawURL(path, stamp)} alt="" />}
      {audioExt.test(path) && <audio {...playerProps} src={rawURL(path, stamp)} />}
      {error && <p className="error-line">{error}</p>}
      {file &&
        (file.binary ? (
          <Empty>二进制文件或超过 2 MB，不显示内容。</Empty>
        ) : (
          <pre className="text" id="file-content" data-ctx-source={path} data-ctx-label={path.split('/').pop()}>
            {file.content}
          </pre>
        ))}
    </div>
  );
}

/** 文件页：左边文件树，右边内容。文件树原来常驻左侧栏，现在只在这里出现。 */
export function FilesTab(props: {
  tree: TreeFile[];
  recent: Set<string>;
  path: string;
  version: number;
  onFile: (path: string) => void;
}) {
  const changed = props.tree.filter((f) => props.recent.has(f.path)).length;
  const [exportMsg, setExportMsg] = useState('');
  const [exporting, setExporting] = useState(false);
  const exportZip = async () => {
    setExporting(true);
    setExportMsg('');
    try {
      const res = await post<{ archive_path: string; file_count: number }>('/api/project-zip/export', {});
      setExportMsg(`已导出 ${res.file_count} 个文件：${res.archive_path}`);
    } catch (err) {
      setExportMsg(errorText(err));
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="files-tab">
      <aside className="files-tree" aria-label="文件">
        <div className="toolbar" style={{ padding: '6px 8px' }}>
          <button
            className="ghost small"
            disabled={exporting}
            onClick={() => void exportZip()}
            title="导出自包含便携工程 ZIP（自动剔除密钥与缓存并自验）"
          >
            {exporting ? '正在打包…' : '导出便携 ZIP'}
          </button>
        </div>
        {exportMsg && (
          <div className="recent-count" title={exportMsg}>
            {exportMsg}
          </div>
        )}
        {changed > 0 && <div className="recent-count">本轮改动 {changed} 个文件</div>}
        <FileTree files={props.tree} selected={props.path} recent={props.recent} onFile={props.onFile} />
      </aside>
      <div className="files-view">
        <FileView
          path={props.path}
          version={props.version}
          mtime={props.tree.find((f) => f.path === props.path)?.mtime}
        />
      </div>
    </div>
  );
}
