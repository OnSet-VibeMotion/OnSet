import { useEffect, useState } from 'react';
import { api, errorText, post } from '../api';
import type { AgentProtocol, AgentService, AgentServicePreset, AgentServicesResponse, AgentVision } from '../types';
import { Icon } from './Icon';

/**
 * 导演的模型服务：一套就是「协议 + base URL + API key + 模型 + 能不能看图」。可以存几套、选一套在用；
 * 预设只是把表单填好，存下来与手填的没有区别。key 经系统钥匙串加密后写进用户目录里一个只有自己能读的文件，
 * 界面上不回显；钥匙串用不了时照实说一句。
 */

const protocolLabel: Record<AgentProtocol, string> = { openai: 'OpenAI 兼容', anthropic: 'Anthropic' };

interface Draft {
  id: string;
  name: string;
  preset: string;
  protocol: AgentProtocol;
  base_url: string;
  model: string;
  vision: boolean;
  key: string;
  /** 正在改的这套原来有没有 key（有的话 key 留空就是不换）。 */
  had_key: boolean;
}

const emptyDraft: Draft = { id: '', name: '', preset: '', protocol: 'openai', base_url: '', model: '', vision: true, key: '', had_key: false };

function fromPreset(p: AgentServicePreset, keep: Draft): Draft {
  return { ...keep, preset: p.id, name: p.label, protocol: p.protocol, base_url: p.base_url, model: p.model, vision: p.vision };
}

function fromService(s: AgentService): Draft {
  return { id: s.id, name: s.name, preset: s.preset, protocol: s.protocol, base_url: s.base_url, model: s.model, vision: s.vision, key: '', had_key: s.has_key };
}

export function DirectorServices({ version, onChange }: { version: number; onChange?: (data: AgentServicesResponse) => void }) {
  const [data, setData] = useState<AgentServicesResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<AgentServicesResponse>('/api/agent-services').then(
      (d) => {
        setData(d);
        // 一套都没有时直接打开表单，免得多点一下。
        if (d.services.length === 0) setDraft((cur) => cur ?? (d.presets[0] ? fromPreset(d.presets[0], emptyDraft) : { ...emptyDraft }));
      },
      (err) => setError(errorText(err)),
    );
  }, [version]);

  const apply = (next: AgentServicesResponse) => {
    setData(next);
    onChange?.(next);
    setError('');
  };
  const call = async (path: string, init?: RequestInit) => {
    try {
      apply(await api<AgentServicesResponse>(path, init));
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!data) return error ? <div className="settings-error">{error}</div> : null;
  const presetOf = (id: string) => data.presets.find((p) => p.id === id);

  return (
    <section className="agent-services" aria-label="导演的模型服务">
      <div className="agent-services-head">
        <div>
          <strong>导演的模型服务</strong>
          <span>编排选「导演」时用：填 base URL 和 API key 就能开工。可以存几套，选一套在用。</span>
        </div>
        {!draft && (
          <button className="pill" onClick={() => setDraft(data.presets[0] ? fromPreset(data.presets[0], emptyDraft) : { ...emptyDraft })}>
            <Icon name="plus" size={12} />
            添加
          </button>
        )}
      </div>
      {data.services.length > 0 && (
        <ul className="agent-service-list">
          {data.services.map((s) => {
            const active = s.id === data.active;
            return (
              <li key={s.id} data-service={s.id} className={active ? 'active' : ''}>
                <button
                  className="agent-service-pick"
                  role="radio"
                  aria-checked={active}
                  aria-label={`用 ${s.name}`}
                  onClick={() => !active && void call(`/api/agent-services/${s.id}/activate`, { method: 'POST' })}
                >
                  <span className="agent-service-dot" />
                </button>
                <span className="agent-service-main">
                  <span className="agent-service-name">
                    {s.name}
                    {active && <em>在用</em>}
                    {!s.vision && (
                      <span className="agent-service-vision" title="画面验收、整片复查要看截图；这个模型只读得了文字">
                        <Icon name="eye-off" size={11} />
                        看不了画面
                      </span>
                    )}
                  </span>
                  <small>
                    {protocolLabel[s.protocol]} · {s.base_url} · {s.model}
                    {!s.has_key && ' · 没有 API key'}
                  </small>
                </span>
                <span className="agent-service-actions">
                  <button className="link" onClick={() => setDraft(fromService(s))}>
                    编辑
                  </button>
                  <button className="link" onClick={() => void call(`/api/agent-services/${s.id}`, { method: 'DELETE' })}>
                    删除
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {draft && (
        <ServiceForm
          draft={draft}
          presets={data.presets}
          keyURL={presetOf(draft.preset)?.key_url ?? ''}
          onDraft={setDraft}
          onCancel={data.services.length > 0 ? () => setDraft(null) : undefined}
          onSaved={(next) => {
            apply(next);
            setDraft(null);
          }}
        />
      )}
      {data.storage && !data.storage.encrypted && data.storage.note && <p className="agent-services-note">{data.storage.note}</p>}
      {error && <div className="settings-error">{error}</div>}
    </section>
  );
}

function ServiceForm({
  draft,
  presets,
  keyURL,
  onDraft,
  onCancel,
  onSaved,
}: {
  draft: Draft;
  presets: AgentServicePreset[];
  keyURL: string;
  onDraft: (d: Draft) => void;
  onCancel?: () => void;
  onSaved: (next: AgentServicesResponse) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [listing, setListing] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch });
  // 改了预设里预填的地址或协议，就不再算那个预设（「去申请」链接也不再给）。
  const edit = (patch: Partial<Draft>) => set({ ...patch, ...('base_url' in patch || 'protocol' in patch ? { preset: '' } : {}) });

  const fetchModels = async () => {
    setListing('正在读取…');
    try {
      const r = await post<{ models: string[]; error?: string }>('/api/agent-services/models', { id: draft.id, protocol: draft.protocol, base_url: draft.base_url, key: draft.key });
      setModels(r.models);
      setListing(r.error ?? (r.models.length > 0 ? `读到 ${r.models.length} 个模型` : '这个服务没有列出模型，直接填模型名'));
    } catch (err) {
      setListing(errorText(err));
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const { had_key: _had, key, ...rest } = draft;
      onSaved(await post<AgentServicesResponse>('/api/agent-services', { ...rest, ...(key.trim() ? { key } : {}) }));
      setError('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="agent-service-form"
      aria-label={draft.id ? '编辑模型服务' : '添加模型服务'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="agent-service-presets" role="group" aria-label="从预设填">
        <span>从预设填</span>
        {presets.map((p) => (
          <button type="button" key={p.id} data-preset={p.id} className={'chip' + (draft.preset === p.id ? ' on' : '')} onClick={() => onDraft(fromPreset(p, draft))}>
            {p.label}
          </button>
        ))}
        <button type="button" data-preset="" className={'chip' + (draft.preset === '' ? ' on' : '')} onClick={() => set({ preset: '' })}>
          自定义
        </button>
      </div>
      <label>
        <span>名称</span>
        <input value={draft.name} placeholder="例如 公司中转" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label>
        <span>协议</span>
        <select aria-label="协议" value={draft.protocol} onChange={(e) => edit({ protocol: e.target.value as AgentProtocol })}>
          <option value="openai">OpenAI 兼容（/chat/completions）</option>
          <option value="anthropic">Anthropic（/v1/messages）</option>
        </select>
      </label>
      <label>
        <span>Base URL</span>
        <input aria-label="Base URL" value={draft.base_url} placeholder={draft.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'} onChange={(e) => edit({ base_url: e.target.value })} />
      </label>
      <label>
        <span>API key</span>
        <span className="agent-service-key">
          <input
            type="password"
            aria-label="API key"
            autoComplete="off"
            value={draft.key}
            placeholder={draft.had_key ? '已填写，留空不更换' : '粘贴 API key（本机服务可以不填）'}
            onChange={(e) => set({ key: e.target.value })}
          />
          {keyURL && (
            <a href={keyURL} target="_blank" rel="noreferrer">
              去申请
            </a>
          )}
        </span>
      </label>
      <label>
        <span>模型</span>
        <span className="agent-service-model">
          <input aria-label="模型" list="agent-service-models" value={draft.model} placeholder="模型名" onChange={(e) => set({ model: e.target.value })} />
          <datalist id="agent-service-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button type="button" className="link" disabled={draft.base_url.trim() === ''} onClick={() => void fetchModels()}>
            读取模型列表
          </button>
        </span>
      </label>
      {listing && <p className="agent-service-listing">{listing}</p>}
      <label className="agent-service-check">
        <input type="checkbox" checked={draft.vision} onChange={(e) => set({ vision: e.target.checked })} />
        <span>这个模型能看图片（画面验收、整片复查要看截图；看不了的话导演会把图交给你看）</span>
      </label>
      <div className="agent-service-buttons">
        <button type="submit" className="pill primary" disabled={busy || draft.base_url.trim() === '' || draft.model.trim() === ''}>
          保存
        </button>
        {onCancel && (
          <button type="button" className="link" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
      {error && <div className="settings-error">{error}</div>}
    </form>
  );
}

/**
 * 导演这次会用的模型服务看不了画面时的提示（设置页编排模型一栏、首次引导、开工前的对话里）。
 * 看不了时，导演会在画面验收与复查里把要看的图切给你，等你说结论。
 */
export function DirectorVisionNote({ model, version = 0, compact }: { model: string; version?: number; compact?: boolean }) {
  const [info, setInfo] = useState<AgentVision | null>(null);
  useEffect(() => {
    let live = true;
    api<AgentVision>('/api/agent-services/vision?model=' + encodeURIComponent(model)).then(
      (v) => live && setInfo(v),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, [model, version]);
  if (!info || info.vision !== false) return null;
  return (
    <div className={'vision-note' + (compact ? ' compact' : '')} role="note" id="director-vision-note">
      <span className="vision-note-icon">
        <Icon name="eye-off" size={compact ? 12 : 14} />
      </span>
      <span className="vision-note-text">
        <strong>
          导演现在用的 {info.service} · {info.model} 看不了画面
        </strong>
        <span>画面验收和整片复查要看截图的地方，它会把图切给你、等你说看得怎么样。想让它自己看，在设置里换一套能看图片的模型服务。</span>
      </span>
    </div>
  );
}
