import { useEffect, useRef, useState } from 'react';
import { api, errorText, put } from '../api';
import type { Attachment, Scene, SeriesItem } from '../types';
import { Icon } from './Icon';
import './motion-effects.css';

interface Effect {
  id: string;
  name: string;
  category: string;
  summary: string;
  aliases?: string[];
  spec?: string[];
  example?: string;
  example_url?: string;
  preview?: string;
  renderer_skill?: string;
}

interface Source {
  id: string;
  name: string;
  version: string;
  effects: Effect[];
}

interface Entry {
  ref: string;
  source: Source;
  effect: Effect;
}

function draftMotion({ ref, source, effect }: Entry, scene: string): string {
  const skill = effect.renderer_skill ? `${source.id}/${effect.renderer_skill}` : '';
  return [
    `请在${scene ? '镜头 ' + scene : '合适的镜头'}启用动效「${effect.name}」（${ref}，来源版本 ${source.version}）：${effect.summary}`,
    '请把该标识写入对应镜头的 `production/scene-plan.json`（或 `scene.json`）的 `motion_effects` 字段，渲染时片场会自动展开动效配方，无需把大段英文参数写进画面描述；保留镜头时长和已有的节拍安排。',
    skill ? `该动效配套插件技能 ${skill}，渲染时会自动挂载（必要时也可显式保留在 plugin_skills）。` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function MotionEffects({
  version,
  scenes,
  sceneId,
  seriesId,
  onQuick,
}: {
  version: number;
  scenes: Scene[];
  sceneId: string;
  seriesId?: string;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean, appendDraft?: boolean) => void;
}) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [category, setCategory] = useState('');
  const [selectedRef, setSelectedRef] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [draftedRef, setDraftedRef] = useState('');
  const [boundSeries, setBoundSeries] = useState<SeriesItem | null>(null);
  const [seriesBusy, setSeriesBusy] = useState(false);
  const [seriesNote, setSeriesNote] = useState('');
  const [seriesErr, setSeriesErr] = useState('');
  const seriesFetchCtrlRef = useRef<AbortController | null>(null);
  const seriesWriteGenRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    api<{ sources: Source[] }>('/api/motion-effects', { signal: controller.signal }).then(
      ({ sources }) => {
        if (controller.signal.aborted) return;
        setSources(sources);
        setError('');
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setError(errorText(err));
      },
    );
    return () => controller.abort();
  }, [version, reload]);

  useEffect(() => {
    seriesFetchCtrlRef.current?.abort();
    seriesFetchCtrlRef.current = null;
    if (!seriesId) {
      setBoundSeries(null);
      return;
    }
    const controller = new AbortController();
    seriesFetchCtrlRef.current = controller;
    const gen = seriesWriteGenRef.current;
    api<{ series: SeriesItem }>(`/api/series/${encodeURIComponent(seriesId)}`, { signal: controller.signal }).then(
      ({ series }) => {
        if (!controller.signal.aborted && seriesWriteGenRef.current === gen) setBoundSeries(series);
      },
      () => {
        if (!controller.signal.aborted && seriesWriteGenRef.current === gen) setBoundSeries(null);
      },
    );
    return () => {
      controller.abort();
      if (seriesFetchCtrlRef.current === controller) seriesFetchCtrlRef.current = null;
    };
  }, [seriesId, version]);

  const seriesMotions = boundSeries?.defaults.motion_effects ?? [];
  const toggleSeriesMotion = async (ref: string) => {
    if (!boundSeries) return;
    // 保存开始时中止进行中的专栏读取并推进写入代次，防止旧读取晚到覆盖刚保存的常用动效。
    seriesWriteGenRef.current += 1;
    seriesFetchCtrlRef.current?.abort();
    seriesFetchCtrlRef.current = null;
    setSeriesBusy(true);
    setSeriesErr('');
    setSeriesNote('');
    const inSeries = seriesMotions.includes(ref);
    const next = inSeries ? seriesMotions.filter((item) => item !== ref) : [...seriesMotions, ref];
    try {
      const updated = await put<SeriesItem>(`/api/series/${encodeURIComponent(boundSeries.id)}`, {
        defaults: { ...boundSeries.defaults, motion_effects: next },
      });
      setBoundSeries(updated);
      setSeriesNote(inSeries ? `已从专栏「${updated.name}」常用动效移除。` : `已加入专栏「${updated.name}」常用动效。`);
    } catch (err) {
      setSeriesErr(errorText(err));
    } finally {
      setSeriesBusy(false);
    }
  };

  const activeSource = sources?.some((source) => source.id === sourceId) ? sourceId : '';
  const entries: Entry[] = (sources ?? [])
    .filter((source) => !activeSource || source.id === activeSource)
    .flatMap((source) => source.effects.map((effect) => ({ source, effect, ref: source.id + ':' + effect.id })));
  const categories = [...new Set(entries.map(({ effect }) => effect.category))];
  const activeCategory = categories.includes(category) ? category : '';
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^#/, ''))
    .filter(Boolean);
  const matches = entries.filter(({ source, effect, ref }) => {
    if (activeCategory && effect.category !== activeCategory) return false;
    const words = [ref, source.name, effect.name, effect.summary, ...(effect.aliases ?? [])].join(' ').toLowerCase();
    return terms.every((term) => words.includes(term));
  });
  const selected = matches.find((entry) => entry.ref === selectedRef) ?? matches[0];
  const targetId = scenes.some((scene) => scene.id === (target ?? sceneId)) ? (target ?? sceneId) : '';

  return (
    <section className="motion-effects" aria-label="动效目录">
      <div className="motion-filters">
        <label className="motion-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            aria-label="搜索动效"
            placeholder="搜索名称、关键词或编号"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label="来源"
          value={activeSource}
          onChange={(event) => {
            setSourceId(event.target.value);
            setCategory('');
          }}
        >
          <option value="">全部来源</option>
          {sources?.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
        <select aria-label="类别" value={activeCategory} onChange={(event) => setCategory(event.target.value)}>
          <option value="">全部类别</option>
          {categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="motion-message" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setError('');
              setReload((value) => value + 1);
            }}
          >
            重试
          </button>
        </div>
      )}
      {!sources && !error && (
        <p className="motion-message" role="status">
          正在读取动效…
        </p>
      )}
      {sources && !selected && (
        <p className="motion-message" role="status">
          没有找到匹配的动效。
        </p>
      )}

      {selected && (
        <div className="motion-layout">
          <div className="motion-catalog">
            <p className="motion-count" role="status">
              {matches.length} 个动效
            </p>
            <ul aria-label="动效列表">
              {matches.map(({ source, effect, ref }) => (
                <li key={ref}>
                  <button
                    type="button"
                    aria-pressed={ref === selected.ref}
                    onClick={() => {
                      setSelectedRef(ref);
                      setDraftedRef('');
                    }}
                  >
                    <span className="motion-row-name">{effect.name}</span>
                    <span className="motion-row-source">{source.name}</span>
                    <span className="motion-row-id">{effect.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <article className="motion-detail" aria-label="动效详情">
            {selected.effect.preview && (
              <iframe
                key={selected.ref}
                sandbox="allow-scripts"
                title={selected.effect.name + '预览'}
                src={selected.effect.preview}
              />
            )}
            <div className="motion-description">
              <p className="motion-reference">
                {selected.source.name} · {selected.effect.category}
              </p>
              <h2>{selected.effect.name}</h2>
              <p className="motion-summary">{selected.effect.summary}</p>
              <code title={selected.source.version}>{selected.ref}</code>
              {selected.effect.example_url && (
                <a href={selected.effect.example_url} target="_blank" rel="noreferrer">
                  查看示例 ↗
                </a>
              )}
              {selected.effect.example && <p className="motion-example">{selected.effect.example}</p>}
              <div className="motion-actions">
                <select
                  aria-label="目标镜头"
                  value={targetId}
                  onChange={(event) => {
                    setTarget(event.target.value);
                    setDraftedRef('');
                  }}
                >
                  <option value="">在对话里指定镜头</option>
                  {scenes.map((scene, index) => (
                    <option key={scene.id} value={scene.id}>
                      镜头 {String(index + 1).padStart(2, '0')} · {scene.id}
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  type="button"
                  onClick={() => {
                    onQuick(draftMotion(selected, targetId), [], true, true);
                    setDraftedRef(selected.ref);
                  }}
                >
                  写进对话
                </button>
                {boundSeries && (
                  <button
                    type="button"
                    className={seriesMotions.includes(selected.ref) ? 'motion-series-btn active' : 'motion-series-btn'}
                    disabled={seriesBusy}
                    onClick={() => void toggleSeriesMotion(selected.ref)}
                  >
                    {seriesMotions.includes(selected.ref) ? '已在专栏常用' : '加入本专栏常用'}
                  </button>
                )}
              </div>
              {draftedRef === selected.ref && (
                <p className="motion-feedback" role="status">
                  已填入对话草稿。
                </p>
              )}
              {seriesNote && (
                <p className="motion-feedback" role="status">
                  {seriesNote}
                </p>
              )}
              {seriesErr && (
                <p className="motion-error" role="alert">
                  {seriesErr}
                </p>
              )}
            </div>
          </article>
        </div>
      )}
    </section>
  );
}
