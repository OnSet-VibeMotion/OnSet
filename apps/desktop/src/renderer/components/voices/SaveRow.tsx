import { useState } from 'react';

/** 名字 + 设为默认 + 存：三种办法共用。 */
export function SaveRow({
  first,
  busy,
  disabled,
  onSave,
}: {
  first: boolean;
  busy: boolean;
  disabled?: boolean;
  onSave: (name: string, makeDefault: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  return (
    <div className="voices-save">
      <input
        value={name}
        maxLength={40}
        placeholder="给它起个名字，例如：我的声音"
        onChange={(e) => setName(e.target.value)}
      />
      {!first && (
        <label className="voices-check">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
          <span>设为默认音色</span>
        </label>
      )}
      <button
        className="primary"
        disabled={busy || disabled || name.trim() === ''}
        onClick={() => onSave(name.trim(), makeDefault)}
      >
        {busy ? '正在存…' : '存进音色库'}
      </button>
    </div>
  );
}
