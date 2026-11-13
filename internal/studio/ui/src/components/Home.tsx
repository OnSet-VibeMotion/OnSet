import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, errorText } from '../api';
import type { AgentsResponse, CanvasOption, DirectoryEntry, Project, StylesResponse } from '../types';
import { Creation, type CreationJob } from './Creation';
import { Icon } from './Icon';
import '../home.css';

/**
 * 启动页。结构照 OpenDesign 的首页（EntryShell + HomeHero）：左侧栏放最近项目，
 * 中间是标题、一个大输入框和「从模板开始」。在这里说要做什么、拖进文章，
 * 发送就建项目、上传附件、开始整片制作，直接进到项目里看它做。
 */

export interface ProjectSummary {
  stage: string;
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
  onOpen: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onBrowse: () => void;
  /** 新项目建好、制作已经开始：切到项目，打开这个会话。 */
  onStarted: (projectId: string, sessionId: string) => Promise<void>;
  onBack?: () => void;
}

/** 制作方式：映射到 am init 的 --delivery 与 --narration。 */
const modes = [
  { id: 'speech', label: '口播讲解', hint: '配音 + 动画，最常用', delivery: 'speech', narration: 'solo' },
  { id: 'cast', label: '角色对白', hint: '多个角色你一言我一语', delivery: 'speech', narration: 'cast' },
  { id: 'beat', label: '音乐卡点', hint: '没有配音，画面踩着节拍切', delivery: 'beat', narration: 'solo' },
  { id: 'song', label: '歌曲 MV', hint: '把内容写成一首歌来讲', delivery: 'song', narration: 'solo' },
] as const;
type ModeID = (typeof modes)[number]['id'];

/** 模板就是几种常见的视频形式：点一下把画幅、制作方式和示例填好。 */
const templates: { id: string; title: string; desc: string; canvas: string; mode: ModeID; example: string }[] = [
  { id: 'explainer', title: '口播科普', desc: '3:4 竖屏，讲清一个概念', canvas: 'vertical-3x4', mode: 'speech', example: '把这篇文章做成 3 分钟的口播科普，讲清楚核心概念' },
  { id: 'short', title: '竖屏快讲', desc: '9:16，一分钟抓住注意力', canvas: 'vertical-9x16', mode: 'speech', example: '做一条 60 秒的竖屏快讲，开头三秒就抛出反常识的结论' },
  { id: 'landscape', title: '横屏讲解', desc: '16:9，适合 B 站长视频', canvas: 'landscape-16x9', mode: 'speech', example: '做成 5 分钟的横屏讲解视频，分三个小节，配图表' },
  { id: 'beat', title: '音乐卡点', desc: '没有配音，节奏驱动', canvas: 'vertical-9x16', mode: 'beat', example: '用一首轻快的曲子做卡点短片，每个重拍切一个画面' },
  { id: 'song', title: '歌曲 MV', desc: '把知识写成一首歌', canvas: 'vertical-9x16', mode: 'song', example: '把这篇文章写成一首歌，做成带歌词的 MV' },
  { id: 'cast', title: '角色对白', desc: '两个角色对话讲道理', canvas: 'vertical-3x4', mode: 'cast', example: '用两个角色一问一答的方式讲这件事，一个好奇一个专业' },
];

const rotatingWords = ['科普视频', '竖屏快讲', '卡点短片', '歌曲 MV', '对白短剧'];
const placeholders = [
  '粘贴一篇文章，做成 3 分钟的口播科普',
  '拖进一份讲稿，做一条 60 秒的竖屏视频',
  '讲讲复利是怎么回事，配上数据图表',
  '把这周的产品更新做成一条横屏讲解',
];

const stageLabels: Record<string, string> = {
  setup: '准备',
  plan: '脚本与分镜',
  render: '渲染',
  assemble: '合成',
  review: '复查',
  publish: '发布',
};

const LAST_TOOL = 'am-studio:home-tool';

export function Home(props: Props) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [styles, setStyles] = useState<StylesResponse | null>(null);
  const [canvas, setCanvas] = useState('');
  const [mode, setMode] = useState<ModeID>('speech');
  const [style, setStyle] = useState('');
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
  }, []);
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
  const canSend = !working && (text.trim() !== '' || files.length > 0) && !!tool && !!parent;
  const current = templates.find((t) => t.id === template);
  const canvasInfo = styles?.canvases.find((c) => c.id === canvas);
  const modeInfo = modes.find((m) => m.id === mode)!;
  const styleLabel = style ? styles?.styles.find((s) => s.id === style)?.name ?? style : '自动定风格';

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
    const m = modes.find((item) => item.id === mode)!;
    const message = text.trim();
    setJob({
      parent,
      name: projectName(message, files),
      canvas,
      canvasInfo,
      style,
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
    <div class="home">
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
      />
      <main class="home-main">
        <section class={'home-hero' + (props.projects.length === 0 ? ' centered' : '')}>
          <h1 aria-label="今天想做一条什么视频？">
            今天想做一条
            <RotatingWord words={rotatingWords} />？
          </h1>
          <p class="home-sub">粘贴一篇文章、拖进讲稿，或者说说你想要的视频。剩下的交给编排工具。</p>

          <div class="composer-card">
            <div
              class={'input-card' + (focused ? ' focused' : '') + (dragging ? ' dragging' : '')}
              onFocusIn={() => setFocused(true)}
              onFocusOut={(e) => {
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
                <ul class="home-tray">
                  {files.map((file, index) => (
                    <li key={index} title={file.name}>
                      <Icon name="file" size={15} />
                      <span class="doc-text">
                        <span class="doc-name">{file.name}</span>
                        <span class="doc-meta">{formatSize(file.size)}</span>
                      </span>
                      <button class="remove" aria-label="移除" onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>
                        <Icon name="close" size={9} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div class="prompt-editor">
                <textarea
                  id="home-prompt"
                  ref={textarea}
                  rows={2}
                  value={text}
                  aria-label="想做什么视频"
                  onInput={(e) => setText(e.currentTarget.value)}
                  onPaste={(e) => {
                    const pasted = e.clipboardData?.files;
                    if (pasted && pasted.length) {
                      e.preventDefault();
                      addFiles(pasted);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                {!text && <Typewriter lines={current ? [current.example] : placeholders} paused={focused} />}
              </div>
              <div class="input-foot">
                <div class="foot-left">
                  <button class="round" aria-label="添加文件" title="添加文章、图片、音频（也可以拖进来或粘贴）" onClick={() => fileInput.current?.click()}>
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
                    <button class="template-chip" title="取消模板" onClick={() => setTemplate('')}>
                      {current.title}
                      <Icon name="close" size={9} />
                    </button>
                  )}
                </div>
                <div class="foot-right">
                  <Dropdown
                    id="tool"
                    align="right"
                    open={menu === 'tool'}
                    onOpen={(open) => setMenu(open ? 'tool' : '')}
                    label={props.agents?.agents.find((a) => a.id === tool)?.label ?? '编排工具'}
                  >
                    {props.agents?.agents.map((agent) => (
                      <MenuItem
                        key={agent.id}
                        selected={agent.id === tool}
                        disabled={!agent.installed}
                        title={agent.label}
                        desc={agent.installed ? '编排整片制作' : `没有找到 ${agent.command}`}
                        onClick={() => {
                          setTool(agent.id);
                          setMenu('');
                        }}
                      />
                    ))}
                  </Dropdown>
                  <button id="home-send" class="send" disabled={!canSend} onClick={() => void submit()} aria-label="开始制作" title="建项目并开始制作（Enter）">
                    {working ? <span class="spinner" /> : <Icon name="up" size={15} />}
                  </button>
                </div>
              </div>
              {focused && !working && <span class="composer-beam" aria-hidden="true" />}
            </div>
            <div class="under-row">
              <Dropdown id="style" open={menu === 'style'} onOpen={(open) => setMenu(open ? 'style' : '')} label={<>风格：{styleLabel}</>} flat>
                <MenuItem
                  selected={style === ''}
                  title="自动定风格"
                  desc="由模型按内容和文案定配色、字体与版式"
                  onClick={() => {
                    setStyle('');
                    setMenu('');
                  }}
                />
                {styles?.styles.map((s) => (
                  <MenuItem
                    key={s.id}
                    selected={s.id === style}
                    title={s.name}
                    desc={s.label}
                    onClick={() => {
                      setStyle(s.id);
                      setMenu('');
                    }}
                  />
                ))}
              </Dropdown>
              <FolderPicker value={parent} open={menu === 'folder'} onOpen={(open) => setMenu(open ? 'folder' : '')} onChange={setParent} />
            </div>
          </div>
          {error && <p class="home-status error">{error}</p>}

          <h3 class="templates-title">从模板开始…</h3>
          <div class="templates">
            {templates.map((t) => (
              <button key={t.id} class={'template-card' + (t.id === template ? ' selected' : '')} onClick={() => pickTemplate(t.id)}>
                <span class="template-art">
                  <TemplateArt id={t.id} />
                </span>
                <span class="template-text">
                  <strong>{t.title}</strong>
                  <span>{t.desc}</span>
                </span>
              </button>
            ))}
          </div>
          <button class="blank-link" onClick={props.onBrowse}>
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
    <nav class="home-rail" aria-label="项目">
      <label class="rail-search">
        <Icon name="search" size={14} />
        <input value={query} placeholder="搜索项目" aria-label="搜索项目" onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      {props.onBack && (
        <button class="rail-btn" onClick={props.onBack}>
          <Icon name="prev" size={14} />
          回到当前项目
        </button>
      )}
      <button class="rail-btn" onClick={props.onBrowse}>
        <Icon name="folder" size={14} />
        打开文件夹…
      </button>
      <button class="rail-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        最近项目
        <Icon name="chevron" size={11} />
      </button>
      {open && (
        <ul class="rail-recent">
          {recent.length === 0 && <li class="rail-empty">{query ? '没有匹配的项目' : '还没有项目'}</li>}
          {recent.map((p) => {
            const summary = props.summaries[p.id];
            return (
              <li key={p.id} class={'rail-row' + (p.id === props.currentId ? ' on' : '')}>
                <button class="rail-item" title={p.path} onClick={() => void props.onOpen(p.id)} disabled={summary?.missing}>
                  <span class={'rail-dot' + (summary?.busy ? ' busy' : summary && summary.total > 0 && summary.completed === summary.total ? ' ok' : '')} />
                  <span class="rail-name">
                    <span class="ellipsis">{p.name}</span>
                    <span class="rail-meta ellipsis">{summaryText(summary)}</span>
                  </span>
                </button>
                <button class="rail-more" aria-label={`从最近项目移除 ${p.name}`} title="从列表移除（不删文件）" onClick={() => void props.onRemove(p.id)}>
                  <Icon name="close" size={10} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {missing.length > 0 && (
        <button class="rail-cleanup" onClick={() => void cleanup()} title={missing.map((p) => p.path).join('\n')}>
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
  const stage = stageLabels[summary.stage] ?? summary.stage;
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
    <span class="rotating" aria-hidden="true">
      <span key={index} class="rotating-word">
        {words[index]}
      </span>
      <i class="rotating-caret" />
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
    <span class="typewriter" aria-hidden="true">
      {paused ? line : line.slice(0, state.chars)}
      {!paused && <i class="type-caret" />}
    </span>
  );
}

function Dropdown(props: {
  id: string;
  label: preact.ComponentChildren;
  open: boolean;
  onOpen: (open: boolean) => void;
  children: preact.ComponentChildren;
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
    <div class="dropdown" ref={box}>
      <button
        id={'home-' + props.id}
        class={'chip-button' + (props.flat ? ' flat' : '')}
        aria-expanded={props.open}
        aria-haspopup="menu"
        onClick={() => props.onOpen(!props.open)}
      >
        {props.label}
        <Icon name="chevron" size={10} />
      </button>
      {props.open && (
        <div class={'dropdown-menu' + (props.align === 'right' ? ' right' : '')} role="menu">
          {props.children}
        </div>
      )}
    </div>
  );
}

function MenuItem(props: { title: string; desc?: string; icon?: preact.ComponentChildren; selected?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button role="menuitemradio" aria-checked={!!props.selected} class={'menu-item' + (props.selected ? ' selected' : '')} disabled={props.disabled} onClick={props.onClick}>
      {props.icon && <span class="menu-icon">{props.icon}</span>}
      <span class="menu-text">
        <span>{props.title}</span>
        {props.desc && <span class="menu-desc">{props.desc}</span>}
      </span>
      {props.selected && <span class="menu-check">✓</span>}
    </button>
  );
}

/** 保存位置：最近用过的目录加一个简单的目录浏览。 */
function FolderPicker(props: { value: string; open: boolean; onOpen: (open: boolean) => void; onChange: (path: string) => void }) {
  const [listing, setListing] = useState<{ path: string; parent: string; root: string; entries: DirectoryEntry[] } | null>(null);
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
    if (props.open) void browse(props.value);
  }, [props.open]);
  const name = props.value ? props.value.split('/').filter(Boolean).pop() : '';
  return (
    <Dropdown id="folder" open={props.open} onOpen={props.onOpen} flat label={<>保存到：{name || '选择文件夹'}</>}>
      <div class="folder-browser">
        <div class="folder-path mono ellipsis" title={listing?.path}>
          {listing?.path ?? '…'}
        </div>
        {listing && listing.path !== listing.root && (
          <button class="menu-item" onClick={() => void browse(listing.parent)}>
            <span class="menu-text">
              <span>‹ 上一级</span>
            </span>
          </button>
        )}
        <div class="folder-list">
          {listing?.entries
            .filter((entry) => !entry.is_project)
            .map((entry) => (
              <button key={entry.path} class="menu-item" onClick={() => void browse(entry.path)}>
                <span class="menu-icon">
                  <Icon name="folder" size={13} />
                </span>
                <span class="menu-text">
                  <span>{entry.name}</span>
                </span>
              </button>
            ))}
        </div>
        {error && <p class="error-line">{error}</p>}
        <button
          class="folder-choose"
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
      <rect x={7 - (w * scale) / 2} y={7 - (h * scale) / 2} width={w * scale} height={h * scale} rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" />
    </svg>
  );
}

/** 模板卡上的小插图：几笔线条加一处琥珀色点缀。 */
function TemplateArt({ id }: { id: string }) {
  const frame = (w: number, h: number) => <rect x={30 - w / 2} y={21 - h / 2} width={w} height={h} rx="3" class="art-line" />;
  switch (id) {
    case 'explainer':
      return (
        <svg viewBox="0 0 60 42">
          {frame(24, 32)}
          <rect x="22" y="12" width="16" height="3" rx="1.5" class="art-accent" />
          <path d="M22 20h16M22 25h12M22 30h14" class="art-line" />
        </svg>
      );
    case 'short':
      return (
        <svg viewBox="0 0 60 42">
          {frame(20, 36)}
          <circle cx="30" cy="17" r="5" class="art-accent" />
          <path d="M24 28h12M26 32h8" class="art-line" />
        </svg>
      );
    case 'landscape':
      return (
        <svg viewBox="0 0 60 42">
          {frame(44, 26)}
          <path d="M14 28l7-6 6 4 8-9 11 11" class="art-line" />
          <circle cx="35" cy="17" r="2.5" class="art-accent" />
        </svg>
      );
    case 'beat':
      return (
        <svg viewBox="0 0 60 42">
          <path d="M10 26v-6M16 30v-14M22 24v-4M28 32v-20M34 28v-10M40 25v-6M46 30v-14M52 24v-4" class="art-line" />
          <path d="M28 32v-20" class="art-accent-stroke" />
        </svg>
      );
    case 'song':
      return (
        <svg viewBox="0 0 60 42">
          <path d="M24 30V12l16-4v18" class="art-line" />
          <circle cx="21" cy="30" r="4" class="art-accent" />
          <circle cx="37" cy="26" r="4" class="art-line-fill" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 60 42">
          <rect x="8" y="10" width="20" height="12" rx="6" class="art-line" />
          <rect x="32" y="20" width="20" height="12" rx="6" class="art-accent-stroke" />
          <circle cx="14" cy="32" r="3" class="art-line" />
          <circle cx="46" cy="12" r="3" class="art-accent" />
        </svg>
      );
  }
}

/** 项目名：说的话第一句，或第一个文件名；去掉路径符号，截到 24 字，加上日期。 */
function projectName(message: string, files: File[]): string {
  let base = message.split('\n').find((line) => line.trim()) ?? '';
  if (!base && files.length) base = files[0].name.replace(/\.[^.]+$/, '');
  base = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[，。！？、；：,.!?;:]+.*$/, '')
    .trim()
    .replace(/\s+/g, '-');
  base = Array.from(base).slice(0, 24).join('') || '新视频';
  const now = new Date();
  return `${base}-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}
