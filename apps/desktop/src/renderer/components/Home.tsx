import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api';
import type { AgentsResponse, Project, SeriesItem, SeriesListResponse, StylesResponse } from '../types';
import { rendererState } from './agentReady';
import { Creation, type CreationJob } from './Creation';
import { Composer } from './home/Composer';
import { RotatingWord } from './home/Controls';
import { HomeRail } from './home/HomeRail';
import {
  fallbackModes,
  LAST_TOOL,
  type ProjectSummary,
  projectName,
  ratioLabel,
  rotatingWords,
  templatesOf,
} from './home/helpers';
import { TemplateArt } from './home/TemplateArt';
import { droppedMaterials, fileMaterials, type HomeMaterial } from './homeAttachments';
import { Icon } from './Icon';
import { SetupGuide, useSetup } from './SetupGuide';
import { BindSeriesModal } from './series/BindSeriesModal';
import { SeriesContextBar } from './series/SeriesContextBar';
import { SeriesModal } from './series/SeriesModal';
import '../home.css';
import '../series.css';

export type { ProjectSummary } from './home/helpers';

/**
 * 启动页。结构照 OpenDesign 的首页（EntryShell + HomeHero）：左侧栏放专栏与最近项目，
 * 中间是标题、一个大输入框和「从模板开始」。在这里说要做什么、拖进文章，
 * 发送就建项目、上传附件、开始整片制作，直接进到项目里看它做。
 */

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
  onProjectsChanged?: () => Promise<unknown>;
  onBrowse: () => void;
  /** 新项目建好、制作已经开始：切到项目，打开这个会话。 */
  onStarted: (projectId: string, sessionId: string) => Promise<void>;
  onBack?: () => void;
  /** 打开新手引导。 */
  onGuide?: () => void;
}

export function Home(props: Props) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<HomeMaterial[]>([]);
  const [reading, setReading] = useState(0);
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
  // 专栏列表、当前开片归属专栏与弹窗状态。
  const [seriesList, setSeriesList] = useState<SeriesItem[]>([]);
  const [activeSeriesId, setActiveSeriesId] = useState('');
  const [episodeInput, setEpisodeInput] = useState('');
  const pendingSeriesMode = useRef<{ delivery: string; narration: string } | null>(null);
  const [seriesModal, setSeriesModal] = useState<{ open: boolean; item: SeriesItem | null }>({
    open: false,
    item: null,
  });
  const [bindTarget, setBindTarget] = useState<Project | null>(null);
  // 正在新建时的任务：交给开机画面（Creation）一步步做完。
  const [job, setJob] = useState<CreationJob | null>(null);
  const [error, setError] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);

  const loadSeries = useCallback(async () => {
    try {
      const res = await api<SeriesListResponse>('/api/series');
      setSeriesList(res.series ?? []);
    } catch {
      // 刷新失败时保留已加载列表，避免已选中的专栏被静默清成独立视频。
    }
  }, []);

  useEffect(() => {
    void loadSeries();
  }, [loadSeries]);

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
    if ((!tool || !installed.some((agent) => agent.id === tool)) && installed.length)
      setTool(props.agents?.orchestrator || installed[0].id);
  }, [props.agents]);

  const working = job !== null;
  const setup = useSetup();
  // 技能与 CLI 没准备好时建了项目也装不上技能、渲染不了：先引导去跑 onset setup。
  const prereqsReady = setup.status?.ready !== false;
  // 新建的项目用全局设置里的渲染工具：没装的话整片会一路做到第一次渲染才报错，先说清楚。
  const drawing = rendererState(props.agents, props.agents?.global_renderer ?? '');
  const canSend =
    !working &&
    reading === 0 &&
    prereqsReady &&
    drawing.ok &&
    (text.trim() !== '' || files.length > 0) &&
    !!tool &&
    !!parent;
  const modes = styles?.modes?.length ? styles.modes : fallbackModes;
  const templates = templatesOf(modes);
  const current = templates.find((t) => t.id === template);
  const canvasInfo = styles?.canvases.find((c) => c.id === canvas);
  const modeInfo = modes.find((m) => m.id === mode) ?? modes[0];
  const activeSeries = seriesList.find((s) => s.id === activeSeriesId) ?? null;

  const chooseMode = (next: string) => {
    pendingSeriesMode.current = null;
    setMode(next);
  };

  // 若用户在 /api/styles 返回前选中了非口播专栏，目录就绪后仅补齐一次 mode，避免后续刷新覆盖单期修改。
  useEffect(() => {
    const pending = pendingSeriesMode.current;
    if (!styles || !pending) return;
    const matched = styles.modes.find((m) => m.delivery === pending.delivery && m.narration === pending.narration);
    if (matched) setMode(matched.id);
    pendingSeriesMode.current = null;
  }, [styles]);

  /** 选定某个专栏作为本次开片上下文：自动套用该专栏预设，单期仍可覆盖。 */
  const applySeriesContext = (item: SeriesItem) => {
    setActiveSeriesId(item.id);
    setEpisodeInput(String(item.next_episode));
    setTemplate('');
    if (item.defaults.canvas) setCanvas(item.defaults.canvas);
    pendingSeriesMode.current = null;
    if (item.defaults.delivery || item.defaults.narration) {
      const target = { delivery: item.defaults.delivery || 'speech', narration: item.defaults.narration || 'solo' };
      const matched = styles?.modes?.find((m) => m.delivery === target.delivery && m.narration === target.narration);
      if (matched) setMode(matched.id);
      else if (!styles?.modes?.length) pendingSeriesMode.current = target;
    }
    setFilmStyle(item.defaults.film_style ?? '');
    if (item.parent_dir) setParent(item.parent_dir);
    if (item.defaults.orchestrator && installed.some((a) => a.id === item.defaults.orchestrator)) {
      setTool(item.defaults.orchestrator);
    }
    textarea.current?.focus();
  };

  const addFiles = (list: FileList | File[]) => {
    const materials = fileMaterials(list);
    setError('');
    setFiles((items) => [...items, ...materials].slice(0, 10));
  };
  const drop = async (data: DataTransfer) => {
    setReading((count) => count + 1);
    setError('');
    try {
      const materials = await droppedMaterials(data);
      setFiles((items) => [...items, ...materials].slice(0, 10));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setReading((count) => count - 1);
    }
  };

  const pickTemplate = (id: string) => {
    const t = templates.find((item) => item.id === id);
    if (!t) return;
    setTemplate(id);
    setCanvas(t.canvas);
    chooseMode(t.mode);
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
    const parsedEp = activeSeries ? Number.parseInt(episodeInput, 10) : Number.NaN;
    const episode = activeSeries && Number.isInteger(parsedEp) && parsedEp >= 1 ? parsedEp : activeSeries?.next_episode;
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
      materials: files,
      ...(activeSeries
        ? {
            seriesId: activeSeries.id,
            seriesName: activeSeries.name,
            episode,
            namingPattern: activeSeries.naming_pattern,
          }
        : {}),
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
            void loadSeries();
            void props.onStarted(projectId, sessionId);
          }}
          onClose={(message) => {
            setJob(null);
            setError(message);
          }}
        />
      )}
      {seriesModal.open && (
        <SeriesModal
          initial={seriesModal.item}
          styles={styles}
          modes={modes}
          defaultParent={parent || props.defaultParent}
          projects={props.projects}
          summaries={props.summaries}
          onSaved={async (saved) => {
            await loadSeries();
            if (!seriesModal.item) applySeriesContext(saved);
          }}
          onDeleted={async (deletedId) => {
            if (activeSeriesId === deletedId) setActiveSeriesId('');
            await loadSeries();
            await props.onProjectsChanged?.();
          }}
          onStartNext={(item) => applySeriesContext(item)}
          onOpenProject={props.onOpen}
          onClose={() => setSeriesModal({ open: false, item: null })}
        />
      )}
      {bindTarget && (
        <BindSeriesModal
          project={bindTarget}
          seriesList={seriesList}
          onDone={async () => {
            await loadSeries();
            await props.onProjectsChanged?.();
          }}
          onClose={() => setBindTarget(null)}
        />
      )}
      <HomeRail
        projects={props.projects}
        summaries={props.summaries}
        currentId={props.currentId}
        seriesList={seriesList}
        activeSeriesId={activeSeriesId}
        onSelectSeries={applySeriesContext}
        onCreateSeries={() => setSeriesModal({ open: true, item: null })}
        onManageSeries={(item) => setSeriesModal({ open: true, item })}
        onBindProject={(p) => setBindTarget(p)}
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
            <p className="home-banner" role="alert">
              <Icon name="alert" size={14} />
              <span>{drawing.reason}</span>
            </p>
          )}

          {activeSeries && (
            <SeriesContextBar
              series={activeSeries}
              episode={episodeInput}
              onEpisode={setEpisodeInput}
              onManage={() => setSeriesModal({ open: true, item: activeSeries })}
              onClear={() => ((pendingSeriesMode.current = null), setActiveSeriesId(''))}
            />
          )}

          <Composer
            text={text}
            onText={setText}
            files={files}
            onRemoveFile={(index) => setFiles((items) => items.filter((_, i) => i !== index))}
            onAddFiles={addFiles}
            onDrop={drop}
            reading={reading}
            working={working}
            canSend={canSend}
            prereqsReady={prereqsReady}
            drawingOk={drawing.ok}
            drawingReason={drawing.reason}
            styles={styles}
            canvas={canvas}
            canvasInfo={canvasInfo}
            onCanvas={setCanvas}
            modes={modes}
            mode={mode}
            modeInfo={modeInfo}
            onMode={chooseMode}
            currentTemplate={current}
            onClearTemplate={() => setTemplate('')}
            agents={props.agents}
            tool={tool}
            onTool={setTool}
            filmStyle={filmStyle}
            onFilmStyle={setFilmStyle}
            parent={parent}
            onParent={setParent}
            onSubmit={submit}
            textareaRef={textarea}
          />
          {error && <p className="home-status error">{error}</p>}

          <h3 className="templates-title">从模板开始…</h3>
          <div className="templates">
            {templates.map((t) => (
              <button
                key={t.id}
                className={'template-card' + (t.id === template ? ' selected' : '')}
                onClick={() => pickTemplate(t.id)}
              >
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
