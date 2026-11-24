import { useState } from 'react';
import { errorText, post } from '../../api';

export function RememberForm({
  seriesId,
  seriesName,
  onDone,
}: {
  seriesId?: string;
  seriesName?: string;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'project' | 'series' | 'global'>(seriesId ? 'series' : 'project');
  const [global, setGlobal] = useState(false);
  const [notice, setNotice] = useState('');

  const submit = async () => {
    setNotice('');
    try {
      const payload = seriesId
        ? { note: text.trim(), scope, global: scope === 'global' }
        : { note: text.trim(), global };
      const result = await post<{ message: string }>('/api/memory/actions/remember', payload);
      setNotice(result.message);
      setText('');
      onDone();
    } catch (err) {
      setNotice(errorText(err));
    }
  };
  return (
    <>
      <div className="toolbar">
        <input
          className="feedback-note memory-preference"
          value={text}
          placeholder="例如：节奏慢一点，每个画面多停一秒"
          aria-label="偏好内容"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) void submit();
          }}
        />
        {seriesId ? (
          <select
            aria-label="偏好作用范围"
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value as 'project' | 'series' | 'global')}
          >
            <option value="project">仅本项目</option>
            <option value="series">本专栏（{seriesName || seriesId}）</option>
            <option value="global">所有项目</option>
          </select>
        ) : (
          <label className="small">
            <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.currentTarget.checked)} /> 用于所有项目
          </label>
        )}
        <button disabled={!text.trim()} onClick={() => void submit()}>
          记住
        </button>
      </div>
      {notice && <p className="small muted">{notice}</p>}
    </>
  );
}
