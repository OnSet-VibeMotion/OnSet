import { useState } from 'react';
import { errorText } from '../api';

export function usesNativeDirectoryPicker(): boolean {
  return window.onset?.platform === 'win32' && typeof window.onset.selectDirectory === 'function';
}

export function NativeDirectoryPicker(props: {
  id: string;
  value: string;
  label: string;
  className?: string;
  disabled?: boolean;
  onChange: (directory: string) => void;
  onBeforePick?: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const choose = async () => {
    if (working || props.disabled) return;
    props.onBeforePick?.();
    setWorking(true);
    setError('');
    try {
      const selected = await window.onset?.selectDirectory?.(props.value || undefined);
      if (selected) props.onChange(selected);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="native-directory-picker">
      <button id={props.id} className={props.className} title={props.value} aria-haspopup="dialog" disabled={working || props.disabled} onClick={() => void choose()}>
        {working ? '正在选择…' : props.label}
      </button>
      {error && <p className="error-line" role="alert">{error}</p>}
    </div>
  );
}
