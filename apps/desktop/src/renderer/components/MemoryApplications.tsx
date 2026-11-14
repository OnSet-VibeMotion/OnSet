import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import type { MemoryRow } from '../types';
import type { RunAction } from './Preview';

interface Match { scene_id: string; text: string; renderer: string; model: string; selected: boolean; features: string[]; keywords: string[]; global: boolean; omit_reason: string; source_scene?: boolean; reading_context?: { compound_cues: number[]; hint: string } }
interface Applications { name: string; status: string; enabled: boolean; scanned: number; unreadable: number; matches: Match[] }

export function MemoryApplications({ memory, featureLabels, run }: { memory: MemoryRow; featureLabels: Record<string, string>; run: RunAction }) {
  const [data, setData] = useState<Applications | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [holdoutOnly, setHoldoutOnly] = useState(false);
  useEffect(() => { setData(null); setSelected([]); }, [memory.status]);
  const find = async () => {
    setLoading(true); setError('');
    try {
      const result = await api<Applications>(`/api/memory/applications?name=${encodeURIComponent(memory.name)}`);
      setData(result);
      setSelected(result.matches.filter((m) => m.selected).slice(0, 3).map((m) => m.scene_id));
    } catch (err) { setError(errorText(err)); } finally { setLoading(false); }
  };
  const examine = () => {
    const renderers = [...new Set(data?.matches.filter((m) => selected.includes(m.scene_id)).map((m) => m.renderer))];
    void run('/api/memory/actions/exam', { renderers, scenes: selected, ...(holdoutOnly ? { holdout_only: true } : {}), ...(memory.status === 'trial' ? { trial: memory.name } : { name: memory.name }) });
  };
  return <div className="memory-applications">
    <button className="link small" disabled={loading} onClick={() => void find()}>{loading ? '正在查找…' : '查找适用镜头'}</button>
    {error && <p role="status">{error}</p>}
    {data && <div className="memory-application-results">
      <p className="small muted">已检查当前项目 {data.scanned} 个镜头。{memory.status === 'active' ? '按当前召回结果匹配。' : '以下是加入这条经验时的预演，经验仍保持停用或试用状态。'}</p>
      {!data.enabled && <p className="small muted">当前项目关闭了记忆；以下仅显示匹配条件，正式渲染不会带上。</p>}
      {data.matches.length === 0 ? <p>没有找到适用镜头。可以切换项目再查，或检查经验的特征、关键词与工具／模型范围。</p>
        : <ul>{data.matches.map((m) => <li key={m.scene_id}>
          <label><input type="checkbox" checked={selected.includes(m.scene_id)} disabled={!m.selected || !memory.examinable || (holdoutOnly && m.source_scene)} onChange={(e) => { const checked = e.currentTarget.checked; setSelected((old) => checked ? [...old, m.scene_id] : old.filter((id) => id !== m.scene_id)); }} />
            <strong>{m.scene_id}</strong><span>{m.renderer}{m.model ? ` · ${m.model}` : ''}</span></label>
          <p>{m.text}</p>
          {m.source_scene && <p className="small muted">参与过这条经验的总结，不能作为新镜头迁移证据。</p>}
          {m.reading_context && <p>{m.reading_context.hint}</p>}
          <p className="small muted">{m.global ? '适用于所有镜头' : [...m.features.map((f) => featureLabels[f] ?? f), ...m.keywords].join('、')}{m.selected ? ' · 试用时能召回' : ` · ${m.omit_reason === 'budget' ? '字数预算不足' : '经验条数已到上限'}`}</p>
        </li>)}</ul>}
      {data.unreadable > 0 && <p className="small muted">另有 {data.unreadable} 个镜头暂时无法读取。</p>}
      {memory.examinable && data.matches.length > 0 && <>
        <label><input type="checkbox" checked={holdoutOnly} onChange={(e) => {
          const checked = e.currentTarget.checked;
          setHoldoutOnly(checked);
          if (checked) setSelected(data.matches.filter((m) => m.selected && !m.source_scene).slice(0, 3).map((m) => m.scene_id));
        }} />仅验证所选新镜头</label>
        <button disabled={selected.length === 0} onClick={examine}>用所选 {selected.length} 个镜头{memory.status === 'trial' ? '考试' : '重新考试'}</button>
        <p className="small muted">{holdoutOnly ? '只用所选新镜头检验迁移，不重放来源旧题。' : '所选镜头会作为补充考题，与原错题一起做对照。'}仍要求试用组确有改善且不退步；通过后才生效。</p>
      </>}
      {!memory.examinable && <p className="small muted">这条经验需要人评或相邻镜头检查，不能用单镜头机器考试判断。</p>}
    </div>}
  </div>;
}
