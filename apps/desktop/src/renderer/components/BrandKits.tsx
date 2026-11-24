import { useCallback, useEffect, useState } from 'react';
import { api, errorText, post } from '../api';
import './brand-kits.css';

export interface BrandStyle {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  display_font: string;
  body_font: string;
  mono_font?: string;
  radius: string;
}

export interface BrandKitItem {
  id: string;
  name: string;
  source_url?: string;
  style: BrandStyle;
  effective_style: BrandStyle;
  rules: string[];
  updated_at: string;
}

interface BrandKitsResponse {
  dir: string;
  kits: BrandKitItem[];
  applied: { kit_id: string; name: string; style: BrandStyle } | null;
}

export function BrandKitsPanel(props: { version: number; onQuick?: (text: string) => void }) {
  const [data, setData] = useState<BrandKitsResponse | null>(null);
  const [url, setUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [newAccent, setNewAccent] = useState('#d4a359');
  const [newBg, setNewBg] = useState('#0f1115');
  const [newRules, setNewRules] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<BrandKitsResponse>('/api/brand-kits').then(
      (res) => {
        setData(res);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load, props.version]);

  const extractUrl = async () => {
    const clean = url.trim();
    if (!clean) return;
    setBusy('extract');
    setError('');
    setMessage('');
    try {
      const kit = await post<BrandKitItem>('/api/brand-kits/extract', { url: clean });
      setUrl('');
      setMessage(`已从官网提取品牌包「${kit.name}」`);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  const createManual = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy('create');
    setError('');
    setMessage('');
    try {
      const rules = newRules
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean);
      const kit = await post<BrandKitItem>('/api/brand-kits', {
        name,
        style: { bg: newBg, accent: newAccent },
        rules,
      });
      setNewName('');
      setNewRules('');
      setMessage(`已保存品牌包「${kit.name}」`);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  const applyKit = async (id: string) => {
    setBusy(`apply:${id}`);
    setError('');
    setMessage('');
    try {
      const res = await post<{ applied: { name: string } }>(`/api/brand-kits/${encodeURIComponent(id)}/apply`, {});
      setMessage(`已挂载品牌包「${res.applied.name}」到当前项目（仅视觉与产品事实，不锁死镜头节奏）`);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  const removeKit = async (id: string) => {
    setBusy(`del:${id}`);
    setError('');
    try {
      const resp = await fetch(`/api/brand-kits/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error(`删除失败（HTTP ${resp.status}）`);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="brand-kits" aria-label="品牌包">
      <div className="brand-kits-head">
        <h4>跨项目品牌包（Brand Kit）</h4>
        <span className="muted small">所有项目共用 · 仅约束配色、字体、Logo 与品牌事实，不锁死镜头节奏</span>
      </div>

      {data?.applied && (
        <div className="brand-kits-applied">
          <span className="brand-kits-dot" style={{ background: data.applied.style.accent }} />
          <span>当前项目已挂载：{data.applied.name}</span>
          {props.onQuick && (
            <button
              className="ghost small"
              onClick={() =>
                props.onQuick?.(
                  `请按已挂载的品牌包「${data.applied!.name}」（production/brand-kit.json）统一本片视觉配色与字体，保持现有分镜节奏不变。`,
                )
              }
            >
              通知剧组应用
            </button>
          )}
        </div>
      )}

      <div className="brand-kits-extract">
        <input
          type="url"
          value={url}
          placeholder="输入公开 HTTPS 官网地址，自动提取品牌配色与字体…"
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy !== ''}
        />
        <button className="primary" disabled={busy !== '' || !url.trim()} onClick={extractUrl}>
          {busy === 'extract' ? '提取中…' : '从官网提取'}
        </button>
      </div>

      <details className="brand-kits-manual">
        <summary>手动新建品牌包</summary>
        <div className="brand-kits-form">
          <input value={newName} placeholder="品牌名称" onChange={(e) => setNewName(e.target.value)} />
          <label>
            底色 <input type="color" value={newBg} onChange={(e) => setNewBg(e.target.value)} />
          </label>
          <label>
            主色 <input type="color" value={newAccent} onChange={(e) => setNewAccent(e.target.value)} />
          </label>
          <textarea
            rows={2}
            value={newRules}
            placeholder="品牌事实与视觉规则（每行一条，可选）"
            onChange={(e) => setNewRules(e.target.value)}
          />
          <button disabled={busy !== '' || !newName.trim()} onClick={createManual}>
            保存品牌包
          </button>
        </div>
      </details>

      {error && <p className="error-line">{error}</p>}
      {message && <p className="ok-line">{message}</p>}

      {data && data.kits.length > 0 && (
        <div className="brand-kits-grid">
          {data.kits.map((kit) => {
            const s = kit.effective_style;
            const active = data.applied?.kit_id === kit.id;
            return (
              <article key={kit.id} className={`brand-kit-card${active ? ' active' : ''}`}>
                <div className="brand-kit-swatches" aria-label="品牌色板">
                  {[s.bg, s.surface, s.accent, s.text, s.muted].map((c, idx) => (
                    <span key={idx} style={{ background: c }} title={c} />
                  ))}
                </div>
                <div className="brand-kit-info">
                  <strong>{kit.name}</strong>
                  <span className="muted small">{s.display_font}</span>
                  {kit.source_url && <span className="muted small">{kit.source_url}</span>}
                </div>
                <div className="brand-kit-actions">
                  <button
                    className={active ? 'ghost' : 'primary'}
                    disabled={busy !== ''}
                    onClick={() => applyKit(kit.id)}
                  >
                    {active ? '已挂载' : '挂载到本项目'}
                  </button>
                  <button className="ghost" disabled={busy !== ''} onClick={() => removeKit(kit.id)}>
                    删除
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
