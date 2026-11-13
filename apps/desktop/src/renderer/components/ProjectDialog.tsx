import { useEffect, useState } from 'react';
import { api, errorText, post } from '../api';
import type { CanvasOption, DirectoryEntry, Project, StylesResponse } from '../types';
import { Icon } from './Icon';
import { FilmStylePicker, styleKey, useFilmStyles } from './FilmStyles';

interface Props {
  projects: Project[];
  currentId: string;
  onClose: () => void;
  onOpened: () => void;
}

interface Listing {
  path: string;
  parent: string;
  root: string;
  entries: DirectoryEntry[];
}

type Mode = 'recent' | 'open' | 'create';

export function ProjectDialog({ projects, currentId, onClose, onOpened }: Props) {
  const [mode, setMode] = useState<Mode>(projects.length ? 'recent' : 'open');
  const [listing, setListing] = useState<Listing | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const browse = async (path = '') => {
    try {
      const result = await api<Listing>('/api/directories' + (path ? '?path=' + encodeURIComponent(path) : ''));
      setListing(result);
      setSelected('');
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  };

  useEffect(() => {
    if (mode !== 'recent' && !listing) void browse();
  }, [mode]);

  const run = async (work: () => Promise<unknown>) => {
    setWorking(true);
    setError('');
    try {
      await work();
      onOpened();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className={'modal' + (mode === 'create' ? ' wide' : '')} role="dialog" aria-label="项目" id="project-dialog">
        <header className="modal-head">
          <h2>项目</h2>
          <div className="segmented">
            <button className={mode === 'recent' ? 'on' : ''} onClick={() => setMode('recent')} disabled={!projects.length}>
              最近
            </button>
            <button className={mode === 'open' ? 'on' : ''} onClick={() => setMode('open')} id="mode-open">
              打开目录
            </button>
            <button className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')} id="mode-create">
              新建
            </button>
          </div>
          <span className="spacer" />
          <button className="ghost icon" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>

        {mode === 'recent' && (
          <RecentList
            projects={projects}
            currentId={currentId}
            onSwitch={(id) => run(() => post('/api/workspaces/switch', { project_id: id }))}
            onRemove={(id) => run(() => post('/api/projects/recent/remove', { project_id: id }))}
          />
        )}

        {mode !== 'recent' && (
          <DirectoryBrowser
            listing={listing}
            selected={selected}
            projectsOnly={mode === 'open'}
            onBrowse={browse}
            onSelect={setSelected}
          />
        )}

        {mode === 'open' && (
          <footer className="modal-foot">
            <code className="path">{selected || '选择一个项目目录（带 frame.md 或 scenes/）'}</code>
            <button
              id="open-project"
              className="primary"
              disabled={!selected || working}
              onClick={() => run(() => post('/api/projects/open', { path: selected }))}
            >
              打开
            </button>
          </footer>
        )}

        {mode === 'create' && listing && (
          <CreateForm
            parent={selected || listing.path}
            working={working}
            onCreate={(payload) => run(() => post('/api/projects/create', payload))}
          />
        )}

        {error && <p className="error-line pad">{error}</p>}
      </section>
    </div>
  );
}

function RecentList(props: {
  projects: Project[];
  currentId: string;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const sorted = [...props.projects].sort((a, b) => (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? ''));
  return (
    <ul className="list recent">
      {sorted.map((p) => (
        <li key={p.id} className={p.id === props.currentId ? 'active' : ''}>
          <button className="row" onClick={() => props.onSwitch(p.id)}>
            <strong>{p.name}</strong>
            <span className="path ellipsis">{p.path}</span>
          </button>
          <button className="ghost" title="从列表移除（不删除文件）" onClick={() => props.onRemove(p.id)}>
            移除
          </button>
        </li>
      ))}
    </ul>
  );
}

function DirectoryBrowser(props: {
  listing: Listing | null;
  selected: string;
  projectsOnly: boolean;
  onBrowse: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const { listing } = props;
  if (!listing) return <p className="muted pad">正在读取目录…</p>;
  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="ghost" disabled={!listing.parent} onClick={() => props.onBrowse(listing.parent)}>
          <Icon name="up" />
          上一级
        </button>
        <code className="path">{listing.path}</code>
        <span className="spacer" />
        <span className="muted small">{props.projectsOnly ? '单击项目选中，单击文件夹进入' : '单击选为父目录，双击进入'}</span>
      </div>
      <ul className="list dirs">
        {listing.entries.length === 0 && <li className="muted pad">没有子目录</li>}
        {listing.entries.map((entry) => (
          <li key={entry.path} className={entry.path === props.selected ? 'active' : ''}>
            <button
              className={'row directory-row' + (entry.is_project ? ' project-row' : '')}
              onClick={() => (entry.is_project || !props.projectsOnly ? props.onSelect(entry.path) : props.onBrowse(entry.path))}
              onDoubleClick={() => props.onBrowse(entry.path)}
            >
              <Icon name={entry.is_project ? 'film' : 'folder'} size={14} />
              <span className="ellipsis">{entry.name}</span>
              {entry.is_project && <span className="tag">项目</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreateForm(props: {
  parent: string;
  working: boolean;
  onCreate: (payload: { parent: string; name: string; canvas: string; film_style: string }) => void;
}) {
  const [styles, setStyles] = useState<StylesResponse | null>(null);
  const [name, setName] = useState('');
  const [canvas, setCanvas] = useState('');
  const [filmStyle, setFilmStyle] = useState('');
  const films = useFilmStyles(true);

  useEffect(() => {
    api<StylesResponse>('/api/styles').then((result) => {
      setStyles(result);
      setCanvas(result.default_canvas);
    });
  }, []);

  if (!styles) return <p className="muted pad">正在读取画幅…</p>;
  const chosenCanvas = styles.canvases.find((c) => c.id === canvas);
  const chosenStyle = films.data?.styles.find((s) => styleKey(s) === filmStyle);
  return (
    <div className="create">
      <div className="create-body">
        <div className="create-side">
          <label className="field">
            <span className="label">项目名</span>
            <input
              id="new-project-name"
              className="mono"
              value={name}
              placeholder="例如 summer-story"
              autoComplete="off"
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <span className="path">
              {props.parent}/{name.trim() || '…'}
            </span>
          </label>
          <div className="field" role="radiogroup" aria-label="画幅">
            <span className="label">画幅</span>
            {styles.canvases.map((c) => (
              <button
                key={c.id}
                role="radio"
                aria-checked={c.id === canvas}
                className={'canvas-option' + (c.id === canvas ? ' on' : '')}
                onClick={() => setCanvas(c.id)}
              >
                <CanvasShape option={c} />
                <span>
                  <strong>{c.label.replace(/\s+\d+×\d+$/, '').replace(/\s+/g, ' ')}</strong>
                  <span className="mono small muted">
                    {c.width}×{c.height}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <span className="small muted">画幅建好后不再改；整片风格之后可以在「风格」页换或去掉。</span>
        </div>
        <div className="create-main">
          <span className="label">整片风格</span>
          <FilmStylePicker
            layout="grid"
            data={films.data}
            error={films.error}
            posterVersion={films.posterVersion}
            selected={filmStyle}
            none={{ title: '不用整片风格', desc: '每个镜头按文案自己定视觉；之后也可以在「风格」页里选。' }}
            onPick={setFilmStyle}
          />
        </div>
      </div>
      <footer className="modal-foot">
        <span className="small muted">
          {chosenCanvas?.label.replace(/\s+/g, ' ')} · {chosenStyle ? chosenStyle.cn : '不用整片风格'}
        </span>
        <button
          id="create-project"
          className="primary"
          disabled={!name.trim() || props.working}
          onClick={() => props.onCreate({ parent: props.parent, name: name.trim(), canvas, film_style: filmStyle })}
        >
          创建并打开
        </button>
      </footer>
    </div>
  );
}

/** 画幅的比例示意：长边固定 40px。 */
function CanvasShape({ option }: { option: CanvasOption }) {
  const scale = 40 / Math.max(option.width, option.height);
  return (
    <span className="canvas-shape" aria-hidden="true">
      <i style={{ width: Math.round(option.width * scale), height: Math.round(option.height * scale) }} />
    </span>
  );
}
