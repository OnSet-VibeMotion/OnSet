import { useRef, useState } from 'react';
import { api, errorText, post } from '../../api';
import type { Attachment } from '../../types';
import { Icon } from '../Icon';

/** 上传一段自己的录音：先走 /api/uploads 落进项目，再转存进音色库。 */
export function UploadVoice({ first, onSaved }: { first: boolean; onSaved: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const ready = name.trim() !== '' && text.trim() !== '' && file !== null && !busy;
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const uploaded = await api<{ attachments: Attachment[] }>('/api/uploads', { method: 'POST', body: form });
      await post('/api/voices', {
        name: name.trim(),
        text,
        upload: uploaded.attachments[0].path,
        source: 'recorded',
        make_default: makeDefault,
      });
      setName('');
      setText('');
      setFile(null);
      setMakeDefault(false);
      if (input.current) input.current.value = '';
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="voices-upload voices-way-body">
      <p className="voices-hint">
        已经录好的一段音频（手机录音、播客片段都行），一两句话，5 到 15
        秒最好。下面的文字要和录音里说的逐字一致，克隆时靠它对齐。
      </p>
      <label>
        <span>名字</span>
        <input value={name} maxLength={40} placeholder="例如：我的声音" onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span>录音</span>
        <span className="voices-file">
          <input
            ref={input}
            type="file"
            hidden
            accept="audio/*,.m4a,.wav,.mp3,.aac,.flac"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button type="button" className="quiet" onClick={() => input.current?.click()}>
            <Icon name="attach" />
            {file ? '换一段' : '选择录音…'}
          </button>
          <span className="voice-meta">{file ? file.name : 'm4a、wav、mp3 都可以'}</span>
        </span>
      </label>
      <label>
        <span>说了什么</span>
        <textarea
          value={text}
          rows={3}
          placeholder="录音里说的话，一字不差"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {!first && (
        <label className="voices-check">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
          <span>存好后设为默认音色</span>
        </label>
      )}
      {error && <div className="voices-error">{error}</div>}
      <div className="voices-submit">
        <button className="primary" disabled={!ready} onClick={() => void submit()}>
          {busy ? '正在存…' : '存进音色库'}
        </button>
      </div>
    </section>
  );
}
