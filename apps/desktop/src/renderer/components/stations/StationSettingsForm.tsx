import { useState } from 'react';
import { errorText, post } from '../../api';
import type { StationInfo, StationSetting } from '../../types';

/** 插件的设置：按清单出表单。密钥只写不读，界面上只显示「已填写」。 */
export function StationSettingsForm({ station, onSaved }: { station: StationInfo; onSaved: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const save = async (setting: StationSetting, value: unknown) => {
    try {
      await post(`/api/stations/${encodeURIComponent(station.id)}/settings`, { key: setting.key, value });
      setDrafts((d) => ({ ...d, [setting.key]: '' }));
      setError('');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  if (station.settings.length === 0) return null;
  return (
    <div className="station-settings">
      <div className="station-prompt-label">它的设置</div>
      {station.settings.map((st) => (
        <div className="station-setting" key={st.key} data-setting={st.key}>
          <div className="station-setting-label">
            <strong>{st.label}</strong>
            {st.description && <span>{st.description}</span>}
          </div>
          {st.type === 'boolean' ? (
            <input
              type="checkbox"
              aria-label={st.label}
              checked={st.value === true}
              onChange={(e) => void save(st, e.target.checked)}
            />
          ) : st.type === 'select' ? (
            <select
              aria-label={st.label}
              value={String(st.value ?? '')}
              onChange={(e) => void save(st, e.target.value)}
            >
              {st.default === undefined && <option value="">未选择</option>}
              {st.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : st.type === 'secret' ? (
            <div className="station-secret">
              <span className={st.set ? 'ok' : 'muted'}>{st.set ? '已填写' : '未填写'}</span>
              <input
                type="password"
                aria-label={st.label}
                placeholder={st.set ? '填新的会替换' : '粘贴到这里'}
                value={drafts[st.key] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [st.key]: e.target.value }))}
              />
              <button
                disabled={(drafts[st.key] ?? '').trim() === ''}
                onClick={() => void save(st, (drafts[st.key] ?? '').trim())}
              >
                保存
              </button>
              {st.set && (
                <button className="link danger" onClick={() => void save(st, '')}>
                  清除
                </button>
              )}
            </div>
          ) : (
            <input
              aria-label={st.label}
              inputMode={st.type === 'number' ? 'decimal' : undefined}
              defaultValue={st.value === undefined ? '' : String(st.value)}
              placeholder={st.default === undefined ? '' : `缺省：${String(st.default)}`}
              onBlur={(e) => {
                if (e.target.value !== (st.value === undefined ? '' : String(st.value))) void save(st, e.target.value);
              }}
            />
          )}
        </div>
      ))}
      {error && <div className="settings-error">{error}</div>}
    </div>
  );
}
