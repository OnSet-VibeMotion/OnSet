import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { chooseSkin } from '../skin';
import type { SkinsResponse, SkinView } from '../types';

/**
 * 设置页「外观」：列出全部界面皮肤（放映室、内置插件的、已装插件带的），点一下整个客户端与桌宠立刻换上。
 * 每张卡片是一块按皮肤自己的颜色画的小样（底、面板、一行字、强调色），不用截图。
 */
export function SkinPicker({ version }: { version: number }) {
  const [data, setData] = useState<SkinsResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api<SkinsResponse>('/api/skins').then(setData, (err) => setError(errorText(err)));
  }, [version]);

  if (!data) return error ? <div className="settings-error">{error}</div> : null;

  const pick = async (s: SkinView) => {
    if (s.id === data.current || busy) return;
    setBusy(s.id);
    setError('');
    try {
      await chooseSkin(s.id);
      setData({ ...data, current: s.id });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="skins" aria-label="外观">
      <div className="skins-head">
        <h3>外观</h3>
        <span>换整个客户端与桌宠的配色。插件也能带来新的皮肤。</span>
      </div>
      <div className="skins-grid" role="radiogroup" aria-label="界面皮肤">
        {data.skins.map((s) => {
          const [bg, panel, ink, accent] = s.swatch;
          const on = s.id === data.current;
          return (
            <button
              key={s.id}
              className={'skin-card' + (on ? ' on' : '')}
              role="radio"
              aria-checked={on}
              data-skin={s.id}
              disabled={busy !== '' && busy !== s.id}
              onClick={() => void pick(s)}
              title={s.description}
            >
              <span className="skin-sample" style={{ background: bg }} aria-hidden="true">
                <span className="skin-sample-bar" style={{ background: panel }}>
                  <i style={{ background: accent }} />
                </span>
                <span className="skin-sample-line" style={{ background: ink }} />
                <span className="skin-sample-line short" style={{ background: ink, opacity: 0.55 }} />
                <span className="skin-sample-pill" style={{ background: accent }} />
              </span>
              <span className="skin-meta">
                <strong>{s.name}</strong>
                <em>{s.origin === 'host' ? '自带' : s.plugin}{s.pet.page_url ? ' · 换了桌宠' : ''}</em>
              </span>
            </button>
          );
        })}
      </div>
      {data.problems.map((p) => (
        <div className="settings-error" key={`${p.plugin}/${p.file}`}>
          插件「{p.plugin}」的皮肤 {p.file} 读不出来：{p.message}
        </div>
      ))}
      {error && <div className="settings-error">{error}</div>}
    </section>
  );
}
