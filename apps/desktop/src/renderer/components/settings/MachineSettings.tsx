import { useRef, useState } from 'react';
import { errorText, post } from '../../api';
import type { MachineSetting } from '../../types';

/** 只属于这台电脑的几项（代理、插件中心地址、更新地址）：一行一个输入框，回车或离开时保存。 */
export function MachineSettings({ rows, onSaved }: { rows: MachineSetting[]; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState('');
  const revisions = useRef<Record<string, number>>({});
  const save = async (row: MachineSetting) => {
    const revision = revisions.current[row.key] ?? 0;
    const submitted = draft[row.key] ?? row.value;
    const value = submitted.trim();
    if (value === row.value) return;
    try {
      await post('/api/settings/global', { key: row.key, value });
      setErrors((e) => ({ ...e, [row.key]: '' }));
      if ((revisions.current[row.key] ?? 0) === revision) {
        setDraft((d) => {
          const next = { ...d };
          delete next[row.key];
          return next;
        });
        setSaved(row.key);
      }
      onSaved();
    } catch (err) {
      setErrors((e) => ({ ...e, [row.key]: errorText(err) }));
    }
  };
  return (
    <div className="settings-card machine-settings">
      {rows.map((row) => (
        <div className="settings-row" key={row.key} data-key={row.key}>
          <div className="settings-label">
            <strong>{row.label}</strong>
            <span>{row.hint}</span>
            {row.overridden && <em>这一项被电脑上的环境变量 {row.key} 定死了，这里改了不生效</em>}
            {errors[row.key] && <em>{errors[row.key]}</em>}
          </div>
          <div className="settings-controls">
            <input
              aria-label={row.label}
              className="machine-input"
              placeholder={row.placeholder}
              value={draft[row.key] ?? row.value}
              spellCheck={false}
              onChange={(e) => {
                revisions.current[row.key] = (revisions.current[row.key] ?? 0) + 1;
                setSaved('');
                setDraft((d) => ({ ...d, [row.key]: e.target.value }));
              }}
              onBlur={() => void save(row)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save(row);
              }}
            />
            {saved === row.key && <span className="machine-saved">已保存</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
