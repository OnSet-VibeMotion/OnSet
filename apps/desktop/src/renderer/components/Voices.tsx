import { useEffect, useRef, useState } from 'react';
import { api, errorText, post } from '../api';
import type { Attachment, VoiceEntry, VoiceLibrary } from '../types';
import { Icon } from './Icon';
import '../voices.css';

/**
 * 音色页：音色库在用户级目录，所有项目共用。确认过的声音存成「参考音频 + 逐字一致的文字稿」，
 * 用 Breeze 配音时从默认音色克隆，同一个账号的每部片子都是同一个声音。
 *
 * 这一页能试听、设默认、删除，以及上传自己录的一段声音；从试听里挑中的声音由编排工具在对话里存进来
 * （voice_save）。删除只有这里能做：编排工具没有删除音色的操作。
 */

const sourceNames: Record<VoiceEntry['source'], string> = {
  designed: '按描述设计',
  recorded: '本人录音',
  uploaded: '上传',
};

export function VoicesTab({ version }: { version: number }) {
  const [library, setLibrary] = useState<VoiceLibrary | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState('');
  const [armed, setArmed] = useState('');
  const audio = useRef<HTMLAudioElement>(null);

  const reload = () =>
    api<VoiceLibrary>('/api/voices').then(
      (value) => {
        setLibrary(value);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  useEffect(() => {
    void reload();
  }, [version]);

  const play = (name: string) => {
    const el = audio.current;
    if (!el) return;
    if (playing === name) {
      el.pause();
      setPlaying('');
      return;
    }
    el.src = `/api/voices/${encodeURIComponent(name)}/reference.wav?t=${Date.now()}`;
    void el.play();
    setPlaying(name);
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!library) return <div className="empty">{error || '正在读取音色库…'}</div>;
  return (
    <div className="voices-tab">
      <audio ref={audio} onEnded={() => setPlaying('')} hidden />
      <header className="voices-head">
        <h2>音色</h2>
        <p>确认过的声音存在这里，所有项目共用。用 Breeze 配音时从默认音色克隆，每部片子都是同一个声音；只靠一句描述设计的声音，每次生成都会变。</p>
      </header>

      {error && <div className="voices-error">{error}</div>}

      {library.voices.length === 0 ? (
        <div className="voices-empty">
          <p>音色库还是空的。两种办法存进第一个声音：</p>
          <ol>
            <li>配音试听时听到满意的，在对话里说「就用这个声音，以后都用它」。</li>
            <li>在下面上传一段你自己的录音。</li>
          </ol>
        </div>
      ) : (
        <ul className="voices-list">
          {library.voices.map((v) => (
            <li key={v.name} className={v.is_default ? 'voice is-default' : 'voice'}>
              <button className={playing === v.name ? 'voice-play armed' : 'voice-play'} title={playing === v.name ? '停止' : '试听'} onClick={() => play(v.name)}>
                <Icon name={playing === v.name ? 'pause' : 'play'} size={14} />
              </button>
              <div className="voice-body">
                <div className="voice-title">
                  <span className="voice-name">{v.name}</span>
                  {v.is_default && <span className="voice-badge">默认</span>}
                  <span className="voice-meta">
                    {v.duration_seconds.toFixed(1)} 秒 · {sourceNames[v.source]}
                  </span>
                </div>
                <p className="voice-text">「{v.text}」</p>
                {v.instruction && <p className="voice-instruction">设计时的描述：{v.instruction}</p>}
              </div>
              <div className="voice-actions">
                {!v.is_default && (
                  <button className="quiet" onClick={() => act(() => post(`/api/voices/${encodeURIComponent(v.name)}/default`))}>
                    设为默认
                  </button>
                )}
                {armed === v.name ? (
                  <button
                    className="armed"
                    onClick={() => {
                      setArmed('');
                      void act(() => api(`/api/voices/${encodeURIComponent(v.name)}`, { method: 'DELETE' }));
                    }}
                    onBlur={() => setArmed('')}
                  >
                    确认删除
                  </button>
                ) : (
                  <button className="ghost icon" title="删除" onClick={() => setArmed(v.name)}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <UploadVoice first={library.voices.length === 0} onSaved={reload} />
    </div>
  );
}

/** 上传一段自己的录音：先走 /api/uploads 落进项目，再转存进音色库。 */
function UploadVoice({ first, onSaved }: { first: boolean; onSaved: () => Promise<void> }) {
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
      await post('/api/voices', { name: name.trim(), text, upload: uploaded.attachments[0].path, source: 'recorded', make_default: makeDefault });
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
    <section className="voices-upload">
      <h3>上传自己的录音</h3>
      <p className="voices-hint">安静的房间里，用平时说话的语气读一两句，5 到 15 秒最好。下面的文字要和你说的逐字一致，克隆时靠它对齐。</p>
      <label>
        <span>名字</span>
        <input value={name} maxLength={40} placeholder="例如：我的声音" onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span>录音</span>
        <span className="voices-file">
          <input ref={input} type="file" hidden accept="audio/*,.m4a,.wav,.mp3,.aac,.flac" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="button" className="quiet" onClick={() => input.current?.click()}>
            <Icon name="attach" />
            {file ? '换一段' : '选择录音…'}
          </button>
          <span className="voice-meta">{file ? file.name : 'm4a、wav、mp3 都可以'}</span>
        </span>
      </label>
      <label>
        <span>说了什么</span>
        <textarea value={text} rows={3} placeholder="录音里说的话，一字不差" onChange={(e) => setText(e.target.value)} />
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
        <span className="voices-hint">只存你本人或已经取得授权的声音。</span>
      </div>
    </section>
  );
}
