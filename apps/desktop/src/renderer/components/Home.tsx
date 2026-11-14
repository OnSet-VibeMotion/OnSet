import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../api';
import type { AgentsResponse, CanvasOption, DirectoryListing, ModeOption, Project, StylesResponse } from '../types';
import { FilmStyleDialog, styleKey, useFilmStyles } from './FilmStyles';
import { SetupGuide, useSetup } from './SetupGuide';
import { Creation, type CreationJob } from './Creation';
import { Icon } from './Icon';
import { NativeDirectoryPicker, usesNativeDirectoryPicker } from './NativeDirectoryPicker';
import { rendererState } from './agentReady';
import { canReveal, revealInFinder } from '../reveal';
import '../home.css';

/**
 * 启动页。结构照 OpenDesign 的首页（EntryShell + HomeHero）：左侧栏放最近项目，
 * 中间是标题、一个大输入框和「从模板开始」。在这里说要做什么、拖进文章，
 * 发送就建项目、上传附件、开始整片制作，直接进到项目里看它做。
 */

export interface ProjectSummary {
  /** 制作走到了顶栏的哪一步（与顶栏同一个来源）与它的名字；没有流程记录时为空。 */
  stage: string;
  stage_label: string;
  completed: number;
  total: number;
  busy?: string;
  missing?: boolean;
}

interface Props {
  projects: Project[];
  summaries: Record<string, ProjectSummary>;
  defaultParent: string;
  currentId: string;
  agents: AgentsResponse | null;
  /** 装、去掉插件后加一：重读做法（插件可能带来新的做法）。 */
  pluginsVersion?: number;
  onOpen: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onBrowse: () => void;
  /** 新项目建好、制作已经开始：切到项目，打开这个会话。 */
  onStarted: (projectId: string, sessionId: string) => Promise<void>;
  onBack?: () => void;
  /** 打开新手引导。 */
  onGuide?: () => void;
}

/**
 * 制作方式：映射到 onset init 的 --delivery 与 --narration。选项来自后端（/api/styles 的 modes：
 * 宿主的口播、内置插件登记的做法与已装的第三方插件带来的做法）；还没取到时只有口播。
 */
const fallbackModes: ModeOption[] = [{ id: 'speech', label: '口播讲解', hint: '配音 + 动画，最常用', delivery: 'speech', narration: 'solo' }];

interface Template {
  id: string;
  title: string;
  desc: string;
  canvas: string;
  mode: string;
  example: string;
}

/** 口播的几种常见形式（画幅不同）。别的做法的模板来自后端给的做法里带了 example 的那几种。 */
const speechTemplates: Template[] = [
  { id: 'explainer', title: '口播科普', desc: '讲清一个概念', canvas: 'vertical-3x4', mode: 'speech', example: '把这篇文章做成 3 分钟的口播科普，讲清楚核心概念' },
  { id: 'short', title: '竖屏快讲', desc: '一分钟抓住注意力', canvas: 'vertical-9x16', mode: 'speech', example: '做一条 60 秒的竖屏快讲，开头三秒就抛出反常识的结论' },
  { id: 'landscape', title: '横屏讲解', desc: '适合 B 站长视频', canvas: 'landscape-16x9', mode: 'speech', example: '做成 5 分钟的横屏讲解视频，分三个小节，配图表' },
];

/** 模板就是几种常见的视频形式：点一下把画幅、制作方式和示例填好。 */
function templatesOf(modes: readonly ModeOption[]): Template[] {
  return [
    ...speechTemplates,
    ...modes
      .filter((m) => m.example && m.canvas)
      .map((m) => ({ id: m.id, title: m.label, desc: m.hint, canvas: m.canvas!, mode: m.id, example: m.example! })),
  ];
}

const rotatingWords = ['科普视频', '竖屏快讲', '卡点短片', '歌曲 MV', '对白短剧'];
const placeholders = [
  '粘贴一篇文章，做成 3 分钟的口播科普',
  '拖进一份讲稿，做一条 60 秒的竖屏视频',
  '讲讲复利是怎么回事，配上数据图表',
  '把这周的产品更新做成一条横屏讲解',
];

const LAST_TOOL = 'onset-studio:home-tool';

export function Home(props: Props) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [styles, setStyles] = useState<StylesResponse | null>(null);
  const [canvas, setCanvas] = useState('');
  const [mode, setMode] = useState('speech');
  const [filmStyle, setFilmStyle] = useState('');
  const [parent, setParent] = useState('');
  const [tool, setTool] = useState(() => {
    try {
      return localStorage.getItem(LAST_TOOL) ?? '';
    } catch {
      return '';
    }
  });
  const [template, setTemplate] = useState('');
  const [menu, setMenu] = useState('');
  // 正在新建时的任务：交给开机画面（Creation）一步步做完。
  const [job, setJob] = useState<CreationJob | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<StylesResponse>('/api/styles').then(
      (result) => {
        setStyles(result);
        setCanvas((current) => current || result.default_canvas);
      },
      () => setStyles(null),
    );
  }, [props.pluginsVersion]);
  useEffect(() => {
    if (!parent && props.defaultParent) setParent(props.defaultParent);
  }, [props.defaultParent]);
  // 没指定过编排工具时取第一个装好的。
  const installed = props.agents?.agents.filter((agent) => agent.installed) ?? [];
  useEffect(() => {
    if ((!tool || !installed.some((agent) => agent.id === tool)) && installed.length) setTool(props.agents?.orchestrator || installed[0].id);
  }, [props.agents]);

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const working = job !== null;
  const setup = useSetup();
  // 技能与 CLI 没准备好时建了项目也装不上技能、渲染不了：先引导去跑 onset setup。
  const prereqsReady = setup.status?.ready !== false;
  // 新建的项目用全局设置里的渲染工具：没装的话整片会一路做到第一次渲染才报错，先说清楚。
  const drawing = rendererState(props.agents, props.agents?.global_renderer ?? '');
  const canSend = !working && prereqsReady && drawing.ok && (text.trim() !== '' || files.length > 0) && !!tool && !!parent;
  const modes = styles?.modes?.length ? styles.modes : fallbackModes;
  const templates = templatesOf(modes);
  const current = templates.find((t) => t.id === template);
  const canvasInfo = styles?.canvases.find((c) => c.id === canvas);
  const modeInfo = modes.find((m) => m.id === mode) ?? modes[0];
  const films = useFilmStyles(menu === 'style' || filmStyle !== '');
  const styleLabel = filmStyle ? films.data?.styles.find((s) => styleKey(s) === filmStyle)?.cn ?? filmStyle : '不用整片风格';

  const addFiles = (list: FileList | File[]) => setFiles((current) => [...current, ...Array.from(list)].slice(0, 10));

  const pickTemplate = (id: string) => {
    const t = templates.find((item) => item.id === id);
    if (!t) return;
    setTemplate(id);
    setCanvas(t.canvas);
    setMode(t.mode);
    textarea.current?.focus();
  };

  const submit = () => {
    if (!canSend) return;
    setError('');
    try {
      localStorage.setItem(LAST_TOOL, tool);
    } catch {
      // 记不住上次选的工具不影响建项目。
    }
    const m = modes.find((item) => item.id === mode) ?? modes[0];
    const message = text.trim();
    setJob({
      parent,
      name: projectName(message, files),
      canvas,
      canvasInfo,
      filmStyle,
      delivery: m.delivery,
      narration: m.narration,
      modeLabel: m.label,
      tool,
      toolLabel: props.agents?.agents.find((a) => a.id === tool)?.label ?? tool,
      message,
      files,
    });
  };

  return (
    <div className="home">
      {job && (
        <Creation
          job={job}
          onDone={(projectId, sessionId) => {
            setText('');
            setFiles([]);
            setJob(null);
            void props.onStarted(projectId, sessionId);
          }}
          onClose={(message) => {
            setJob(null);
            setError(message);
          }}
        />
      )}
      <HomeRail
        projects={props.projects}
        summaries={props.summaries}
        currentId={props.currentId}
        onOpen={props.onOpen}
        onRemove={props.onRemove}
        onBrowse={props.onBrowse}
        onBack={props.onBack}
        onGuide={props.onGuide}
      />
      <main className="home-main">
        <section className={'home-hero' + (props.projects.length === 0 ? ' centered' : '')}>
          <h1 aria-label="今天想做一条什么视频？">
            今天想做一条
            <RotatingWord words={rotatingWords} />？
          </h1>
          <p className="home-sub">粘贴一篇文章、拖进讲稿，或者说说你想要的视频。剩下的交给 AI。</p>
          {setup.status && setup.status.items.some((item) => !item.ready) && (
            <div className="home-setup">
              <SetupGuide setup={setup} />
            </div>
          )}

          {!drawing.ok && (
            <div className="home-renderer" role="alert" id="home-renderer">
              <span className="home-renderer-icon">
                <Icon name="brush" size={14} />
              </span>
              <span className="home-renderer-text">
                <strong>还差一家画镜头的工具</strong>
                <span>{drawing.reason}。</span>
              </span>
              {props.onGuide && (
                <button className="pill" onClick={props.onGuide}>
                  去选一个
                </button>
              )}
            </div>
          )}

          <div className="composer-card">
            <div
              className={'input-card' + (focused ? ' focused' : '') + (dragging ? ' dragging' : '')}
              onFocus={() => setFocused(true)}
              onBlur={(e) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setFocused(false);
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer?.types.includes('Files')) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                setDragging(false);
                if (!e.dataTransfer?.files.length) return;
                e.preventDefault();
                addFiles(e.dataTransfer.files);
              }}
            >
              {files.length > 0 && (
                <ul className="home-tray">
                  {files.map((file, index) => (
                    <li key={index} title={file.name}>
                      <Icon name="file" size={15} />
                      <span className="doc-text">
                        <span className="doc-name">{file.name}</span>
                        <span className="doc-meta">{formatSize(file.size)}</span>
                      </span>
                      <button className="remove" aria-label="移除" onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>
                        <Icon name="close" size={9} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="prompt-editor">
                <textarea
                  id="home-prompt"
                  ref={textarea}
                  rows={2}
                  value={text}
                  aria-label="想做什么视频"
                  onChange={(e) => setText(e.currentTarget.value)}
                  onPaste={(e) => {
                    const pasted = e.clipboardData?.files;
                    if (pasted && pasted.length) {
                      e.preventDefault();
                      addFiles(pasted);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                {!text && <Typewriter lines={current ? [current.example] : placeholders} paused={focused} />}
              </div>
              <div className="input-foot">
                <div className="foot-left">
                  <button className="round" aria-label="添加文件" title="添加文章、图片、音频（也可以拖进来或粘贴）" onClick={() => fileInput.current?.click()}>
                    <Icon name="plus" size={14} />
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      if (e.currentTarget.files) addFiles(e.currentTarget.files);
                      e.currentTarget.value = '';
                    }}
                  />
                  <Dropdown
                    id="canvas"
                    open={menu === 'canvas'}
                    onOpen={(open) => setMenu(open ? 'canvas' : '')}
                    label={
                      <>
                        <CanvasGlyph canvas={canvasInfo} />
                        {canvasInfo ? shortCanvas(canvasInfo) : '画幅'}
                      </>
                    }
                  >
                    {styles?.canvases.map((c) => (
                      <MenuItem
                        key={c.id}
                        selected={c.id === canvas}
                        title={shortCanvas(c)}
                        desc={`${c.width}×${c.height}`}
                        icon={<CanvasGlyph canvas={c} />}
                        onClick={() => {
                          setCanvas(c.id);
                          setMenu('');
                        }}
                      />
                    ))}
                  </Dropdown>
                  <Dropdown id="mode" open={menu === 'mode'} onOpen={(open) => setMenu(open ? 'mode' : '')} label={modeInfo.label}>
                    {modes.map((m) => (
                      <MenuItem
                        key={m.id}
                        selected={m.id === mode}
                        title={m.label}
                        desc={m.hint}
                        onClick={() => {
                          setMode(m.id);
                          setMenu('');
                        }}
                      />
                    ))}
                  </Dropdown>
                  {current && (
                    <button className="template-chip" title="取消模板" onClick={() => setTemplate('')}>
                      {current.title}
                      <Icon name="close" size={9} />
                    </button>
                  )}
                </div>
                <div className="foot-right">
                  <Dropdown
                    id="tool"
                    align="right"
                    open={menu === 'tool'}
                    onOpen={(open) => setMenu(open ? 'tool' : '')}
                    label={props.agents?.agents.find((a) => a.id === tool)?.label ?? 'AI'}
                  >
                    {props.agents?.agents.map((agent) => (
                      <MenuItem
                        key={agent.id}
                        selected={agent.id === tool}
                        disabled={!agent.installed}
                        title={agent.label}
                        desc={agent.installed ? '编排整片制作' : (agent.hint ?? `没有找到 ${agent.command}`)}
                        onClick={() => {
                          setTool(agent.id);
                          setMenu('');
                        }}
                      />
                    ))}
                  </Dropdown>
                  <button id="home-send" className="send" disabled={!canSend} onClick={() => void submit()} aria-label="开始制作" title={!prereqsReady ? '先在工具准备页把必需的工具装好' : !drawing.ok ? drawing.reason : '建项目并开始制作（Enter）'}>
                    {working ? <span className="spinner" /> : <Icon name="up" size={15} />}
                  </button>
                </div>
              </div>
              {focused && !working && <span className="composer-beam" aria-hidden="true" />}
            </div>
            <div className="under-row">
              <div className="dropdown">
                <button id="home-style" className="chip-button flat" aria-haspopup="dialog" aria-expanded={menu === 'style'} onClick={() => setMenu('style')}>
                  整片风格：{styleLabel}
                  <Icon name="chevron" size={10} />
                </button>
              </div>
              {menu === 'style' && (
                <FilmStyleDialog
                  title="选一种整片风格"
                  intro="全片所有镜头都画成这一种风格；内容仍来自每个镜头自己的文案。"
                  data={films.data}
                  error={films.error}
                  posterVersion={films.posterVersion}
                  selected={filmStyle}
                  none={{ title: '不用整片风格', desc: '每个镜头按文案自己定配色、字体与动效。AI 会在稿件审核时按题材推荐几种风格，也可以之后在「风格」页里选。' }}
                  onPick={setFilmStyle}
                  onClose={() => setMenu('')}
                />
              )}
              <FolderPicker value={parent} open={menu === 'folder'} onOpen={(open) => setMenu(open ? 'folder' : '')} onChange={setParent} />
            </div>
          </div>
          {error && <p className="home-status error">{error}</p>}

          <h3 className="templates-title">从模板开始…</h3>
          <div className="templates">
            {templates.map((t) => (
              <button key={t.id} className={'template-card' + (t.id === template ? ' selected' : '')} onClick={() => pickTemplate(t.id)}>
                <span className="template-art">
                  <TemplateArt id={t.id} canvas={t.canvas} />
                </span>
                <span className="template-text">
                  <span className="template-head">
                    <strong>{t.title}</strong>
                    <span className="template-ratio">{ratioLabel(t.canvas)}</span>
                  </span>
                  <span className="template-desc">{t.desc}</span>
                </span>
              </button>
            ))}
          </div>
          <button className="blank-link" onClick={props.onBrowse}>
            …或打开已有项目、手动新建 ›
          </button>
        </section>
      </main>
    </div>
  );
}

function HomeRail(props: {
  projects: Project[];
  summaries: Record<string, ProjectSummary>;
  currentId: string;
  onOpen: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onBrowse: () => void;
  onBack?: () => void;
  onGuide?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(true);
  // 目录已经不在的项目（删掉或挪走了）不混在列表里，底部给一个一键清理。
  const missing = props.projects.filter((p) => props.summaries[p.id]?.missing);
  const recent = useMemo(
    () =>
      [...props.projects]
        .filter((p) => !props.summaries[p.id]?.missing)
        .sort((a, b) => (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? ''))
        .filter((p) => !query || p.name.includes(query) || p.path.includes(query)),
    [props.projects, props.summaries, query],
  );
  const cleanup = async () => {
    for (const p of missing) await props.onRemove(p.id);
  };
  return (
    <nav className="home-rail" aria-label="项目">
      <label className="rail-search">
        <Icon name="search" size={14} />
        <input value={query} placeholder="搜索项目" aria-label="搜索项目" onChange={(e) => setQuery(e.currentTarget.value)} />
      </label>
      {props.onBack && (
        <button className="rail-btn" onClick={props.onBack}>
          <Icon name="prev" size={14} />
          回到当前项目
        </button>
      )}
      <button className="rail-btn" onClick={props.onBrowse}>
        <Icon name="folder" size={14} />
        打开文件夹…
      </button>
      {props.onGuide && (
        <button className="rail-btn" id="open-guide" onClick={props.onGuide}>
          <Icon name="route" size={14} />
          新手引导
        </button>
      )}
      <button className="rail-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        最近项目
        <Icon name="chevron" size={11} />
      </button>
      {open && (
        <ul className="rail-recent">
          {recent.length === 0 && <li className="rail-empty">{query ? '没有匹配的项目' : '还没有项目'}</li>}
          {recent.map((p) => {
            const summary = props.summaries[p.id];
            return (
              <li key={p.id} className={'rail-row' + (p.id === props.currentId ? ' on' : '')}>
                <button className="rail-item" title={p.path} onClick={() => void props.onOpen(p.id)} disabled={summary?.missing}>
                  <span className={'rail-dot' + (summary?.busy ? ' busy' : summary && summary.total > 0 && summary.completed === summary.total ? ' ok' : '')} />
                  <span className="rail-name">
                    <span className="ellipsis">{p.name}</span>
                    <span className="rail-meta ellipsis">{summaryText(summary)}</span>
                  </span>
                </button>
                {canReveal && !summary?.missing && (
                  <button className="rail-more rail-reveal" aria-label={`在 Finder 中打开 ${p.name}`} title="在 Finder 中打开" onClick={() => revealInFinder('', p.id)}>
                    <Icon name="folder" size={11} />
                  </button>
                )}
                <button className="rail-more" aria-label={`从最近项目移除 ${p.name}`} title="从列表移除（不删文件）" onClick={() => void props.onRemove(p.id)}>
                  <Icon name="close" size={10} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {missing.length > 0 && (
        <button className="rail-cleanup" onClick={() => void cleanup()} title={missing.map((p) => p.path).join('\n')}>
          清理 {missing.length} 个已不存在的项目
        </button>
      )}
    </nav>
  );
}

function summaryText(summary?: ProjectSummary): string {
  if (!summary) return '';
  if (summary.missing) return '目录不见了';
  if (summary.busy) return summary.busy;
  const stage = summary.stage_label;
  if (!stage) return summary.total ? `${summary.completed}/${summary.total} 镜头` : '';
  return summary.total ? `${stage} · ${summary.completed}/${summary.total} 镜头` : stage;
}

function RotatingWord({ words }: { words: string[] }) {
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
function Typewriter({ lines, paused }: { lines: string[]; paused: boolean }) {
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

function Dropdown(props: {
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

function MenuItem(props: { title: string; desc?: string; icon?: ReactNode; selected?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button role="menuitemradio" aria-checked={!!props.selected} className={'menu-item' + (props.selected ? ' selected' : '')} disabled={props.disabled} onClick={props.onClick}>
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
function FolderPicker(props: { value: string; open: boolean; onOpen: (open: boolean) => void; onChange: (path: string) => void }) {
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
    return <NativeDirectoryPicker id="home-folder" value={props.value} label={'保存到：' + (name || '选择文件夹')} className="chip-button flat" onChange={props.onChange} onBeforePick={() => props.onOpen(false)} />;
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

function shortCanvas(c: CanvasOption): string {
  const ratio = c.width === 1080 && c.height === 1440 ? '3:4' : c.width === 1080 && c.height === 1920 ? '9:16' : c.width === 1920 && c.height === 1080 ? '16:9' : `${c.width}×${c.height}`;
  return `${ratio} ${c.height > c.width ? '竖屏' : '横屏'}`;
}

function CanvasGlyph({ canvas }: { canvas?: CanvasOption }) {
  const w = canvas ? canvas.width : 3;
  const h = canvas ? canvas.height : 4;
  const scale = 12 / Math.max(w, h);
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x={7 - (w * scale) / 2} y={7 - (h * scale) / 2} width={w * scale} height={h * scale} rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** 画幅 id（如 vertical-3x4）里的宽高比，认不出时按 3:4。 */
function ratioOf(canvas: string): [number, number] {
  const m = /(\d+)x(\d+)$/.exec(canvas);
  return m ? [Number(m[1]), Number(m[2])] : [3, 4];
}

function ratioLabel(canvas: string): string {
  const [w, h] = ratioOf(canvas);
  return `${w}:${h}`;
}

/**
 * 模板卡上的小样片：按模板真实的画幅画一块小屏幕，屏幕里是这种片子典型的一帧构图
 * （标题、图表、字幕、波形、歌词、对白），悬停时动起来。只用色板里的颜色。
 */
function TemplateArt({ id, canvas }: { id: string; canvas: string }) {
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
            <rect key={i} x={x(0.16 + i * 0.25)} y={y(0.78 - hgt * 0.62)} width={fw * 0.16} height={fh * hgt * 0.62} rx="1.5" className={'tpl-bar' + (i === 2 ? ' tpl-accent' : ' tpl-soft')} style={{ animationDelay: `${i * 90}ms` }} />
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
            <rect key={i} x={x(0.1 + i * 0.205)} y={y(0.05)} width={fw * 0.18} height="1.6" rx="0.8" className={i === 0 ? 'tpl-accent' : 'tpl-dim'} />
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
            return <path key={i} d={`M${bx} ${y(0.66) - half}V${y(0.66) + half}`} className={'tpl-wave' + (i % 4 === 3 ? ' strong' : '')} style={{ animationDelay: `${i * 60}ms` }} />;
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
          <rect x={x(0.12)} y={y(0.62)} width={fw * 0.76} height={fh * 0.04} rx="1.5" className="tpl-accent tpl-karaoke" />
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
            <circle key={i} cx={x(0.38 + i * 0.09)} cy={y(0.73)} r="1.1" className="tpl-dot" style={{ animationDelay: `${i * 140}ms` }} />
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

/** 备用的项目名：说的话第一句，或第一个文件名；去掉路径符号，截到 24 字。AI 起名起不出来时用它，日期由开机画面加。 */
function projectName(message: string, files: File[]): string {
  let base = message.split('\n').find((line) => line.trim()) ?? '';
  if (!base && files.length) base = files[0].name.replace(/\.[^.]+$/, '');
  base = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[，。！？、；：,.!?;:]+.*$/, '')
    .trim()
    .replace(/\s+/g, '-');
  return Array.from(base).slice(0, 24).join('') || '新视频';
}

function formatSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}
