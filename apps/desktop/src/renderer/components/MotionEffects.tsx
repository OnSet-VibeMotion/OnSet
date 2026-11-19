import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import type { Attachment, Scene } from '../types';
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
  const skill = effect.renderer_skill ? source.id + '/' + effect.renderer_skill : '';
  return [
    `请在${scene ? '镜头 ' + scene : '合适的镜头'}使用「${effect.name}」（${ref}，来源版本 ${source.version}）。`,
    '把完整动效引用和来源版本记录在该镜头的画面描述里，保留镜头时长和已有的节拍安排。',
    skill ? `请在该镜头的 plugin_skills 里保留或加入 ${skill}。` : '',
    `动效参考（将示例内容替换成本镜头的内容）：${effect.summary}`,
    ...(effect.spec ?? []),
  ].filter(Boolean).join('\n');
}

export function MotionEffects({ version, scenes, sceneId, onQuick }: {
  version: number;
  scenes: Scene[];
  sceneId: string;
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

  const activeSource = sources?.some((source) => source.id === sourceId) ? sourceId : '';
  const entries: Entry[] = (sources ?? [])
    .filter((source) => !activeSource || source.id === activeSource)
    .flatMap((source) => source.effects.map((effect) => ({ source, effect, ref: source.id + ':' + effect.id })));
  const categories = [...new Set(entries.map(({ effect }) => effect.category))];
  const activeCategory = categories.includes(category) ? category : '';
  const terms = query.trim().toLowerCase().split(/\s+/).map((term) => term.replace(/^#/, '')).filter(Boolean);
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
          <input type="search" aria-label="搜索动效" placeholder="搜索名称、关键词或编号" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <select aria-label="来源" value={activeSource} onChange={(event) => { setSourceId(event.target.value); setCategory(''); }}>
          <option value="">全部来源</option>
          {sources?.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
        <select aria-label="类别" value={activeCategory} onChange={(event) => setCategory(event.target.value)}>
          <option value="">全部类别</option>
          {categories.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>

      {error && (
        <div className="motion-message" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => { setError(''); setReload((value) => value + 1); }}>重试</button>
        </div>
      )}
      {!sources && !error && <p className="motion-message" role="status">正在读取动效…</p>}
      {sources && !selected && <p className="motion-message" role="status">没有找到匹配的动效。</p>}

      {selected && (
        <div className="motion-layout">
          <div className="motion-catalog">
            <p className="motion-count" role="status">{matches.length} 个动效</p>
            <ul aria-label="动效列表">
              {matches.map(({ source, effect, ref }) => (
                <li key={ref}>
                  <button type="button" aria-pressed={ref === selected.ref} onClick={() => { setSelectedRef(ref); setDraftedRef(''); }}>
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
              <iframe key={selected.ref} sandbox="allow-scripts" title={selected.effect.name + '预览'} src={selected.effect.preview} />
            )}
            <div className="motion-description">
              <p className="motion-reference">{selected.source.name} · {selected.effect.category}</p>
              <h2>{selected.effect.name}</h2>
              <p className="motion-summary">{selected.effect.summary}</p>
              <code title={selected.source.version}>{selected.ref}</code>
              {selected.effect.example_url && <a href={selected.effect.example_url} target="_blank" rel="noreferrer">查看示例 ↗</a>}
              {selected.effect.example && <p className="motion-example">{selected.effect.example}</p>}
              <div className="motion-actions">
                <select aria-label="目标镜头" value={targetId} onChange={(event) => { setTarget(event.target.value); setDraftedRef(''); }}>
                  <option value="">在对话里指定镜头</option>
                  {scenes.map((scene, index) => (
                    <option key={scene.id} value={scene.id}>镜头 {String(index + 1).padStart(2, '0')} · {scene.id}</option>
                  ))}
                </select>
                <button className="primary" type="button" onClick={() => {
                  onQuick(draftMotion(selected, targetId), [], true, true);
                  setDraftedRef(selected.ref);
                }}>写进对话</button>
              </div>
              {draftedRef === selected.ref && <p className="motion-feedback" role="status">已填入对话草稿。</p>}
            </div>
          </article>
        </div>
      )}
    </section>
  );
}
