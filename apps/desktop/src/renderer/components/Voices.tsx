import { playerProps } from '../media';
import { useEffect, useRef, useState } from 'react';
import { api, errorText, post } from '../api';
import type { Attachment, SetupStatus, VoiceDraft, VoiceEntry, VoiceLibrary } from '../types';
import { Icon } from './Icon';
import '../voices.css';

/**
 * 音色页：音色库在用户级目录，所有项目共用。确认过的声音存成「参考音频 + 逐字一致的文字稿」，
 * 用 Breeze 配音时从默认音色克隆，同一个账号的每部片子都是同一个声音。
 *
 * 这一页能试听、设默认、删除，也能直接做一个新声音，不用开项目对话、也不管项目配音选的是谁：
 * 对着麦克风念一段（录我的声音）、按一句描述让本机 Breeze 念几段挑一个（按描述设计）、或上传录好的音频。
 * 配音试听时挑中的声音也可以由编排工具在对话里存进来（voice_save）。删除只有这里能做。
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
      <audio
        ref={audio}
        onEnded={() => setPlaying('')}
        onPause={(event) => {
          if (window.onset?.platform === 'win32' && event.currentTarget.paused) setPlaying('');
        }}
        hidden
      />
      <header className="voices-head">
        <h2>音色</h2>
        <p>确认过的声音存在这里，所有项目共用。用 Breeze 配音时从默认音色克隆，每部片子都是同一个声音；只靠一句描述设计的声音，每次生成都会变。</p>
      </header>

      {error && <div className="voices-error">{error}</div>}

      {library.voices.length === 0 ? (
        <div className="voices-empty">
          <p>音色库还是空的。在下面录一段自己的声音，或者描述一个你想要的声音，存进第一个音色。</p>
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

      <NewVoice library={library} onSaved={reload} />
    </div>
  );
}

type Way = 'record' | 'design' | 'upload';

/** 做一个新声音：三种办法，存进去的都是「参考音频 + 逐字一致的文字稿」。 */
function NewVoice({ library, onSaved }: { library: VoiceLibrary; onSaved: () => Promise<void> }) {
  const [way, setWay] = useState<Way>('record');
  const first = library.voices.length === 0;
  const ways: [Way, string][] = [
    ['record', '录我的声音'],
    ['design', '按描述设计'],
    ['upload', '上传录音'],
  ];
  return (
    <section className="voices-new">
      <h3>新的声音</h3>
      <div className="voices-ways" role="tablist">
        {ways.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={way === id} className={way === id ? 'way armed' : 'way quiet'} onClick={() => setWay(id)}>
            {label}
          </button>
        ))}
      </div>
      {way === 'record' && <RecordVoice sample={library.sample_text} first={first} onSaved={onSaved} />}
      {way === 'design' && <DesignVoice library={library} first={first} onSaved={onSaved} />}
      {way === 'upload' && <UploadVoice first={first} onSaved={onSaved} />}
    </section>
  );
}

/** 名字 + 设为默认 + 存：三种办法共用。 */
function SaveRow({ first, busy, disabled, onSave }: { first: boolean; busy: boolean; disabled?: boolean; onSave: (name: string, makeDefault: boolean) => void }) {
  const [name, setName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  return (
    <div className="voices-save">
      <input value={name} maxLength={40} placeholder="给它起个名字，例如：我的声音" onChange={(e) => setName(e.target.value)} />
      {!first && (
        <label className="voices-check">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
          <span>设为默认音色</span>
        </label>
      )}
      <button className="primary" disabled={busy || disabled || name.trim() === ''} onClick={() => onSave(name.trim(), makeDefault)}>
        {busy ? '正在存…' : '存进音色库'}
      </button>
    </div>
  );
}

/** 录音最长 30 秒（参考音频的上限），少于 3 秒存不进去。 */
const maxRecordSeconds = 30;

/** 对着麦克风念一段：念的就是页面上这段字，逐字稿自然对得上；念错了可以在下面改。 */
function RecordVoice({ sample, first, onSaved }: { sample: string; first: boolean; onSaved: () => Promise<void> }) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'done'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [take, setTake] = useState<{ blob: Blob; url: string } | null>(null);
  const [text, setText] = useState(sample);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number>(0);

  useEffect(
    () => () => {
      window.clearInterval(timer.current);
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const start = async () => {
    setError('');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      const name = (err as DOMException).name;
      setError(name === 'NotAllowedError' ? '没有麦克风权限：在「系统设置 → 隐私与安全性 → 麦克风」里允许这个应用，再点一次开始录音。' : `打不开麦克风：${(err as Error).message}`);
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      window.clearInterval(timer.current);
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      setTake((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { blob, url: URL.createObjectURL(blob) };
      });
      setPhase('done');
    };
    recorder.current = rec;
    rec.start();
    setSeconds(0);
    setPhase('recording');
    const began = Date.now();
    timer.current = window.setInterval(() => {
      const s = (Date.now() - began) / 1000;
      setSeconds(s);
      if (s >= maxRecordSeconds && rec.state === 'recording') rec.stop();
    }, 200);
  };

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };

  const save = async (name: string, makeDefault: boolean) => {
    if (!take) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', take.blob, take.blob.type.includes('mp4') ? 'take.m4a' : 'take.webm');
      form.append('name', name);
      form.append('text', text);
      form.append('make_default', String(makeDefault));
      await api('/api/voice-record', { method: 'POST', body: form });
      setTake(null);
      setPhase('idle');
      setText(sample);
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="voices-way-body">
      <p className="voices-hint">找个安静的地方，用平时说话的语气把下面这段念一遍，十秒左右。克隆出来的声音会学你念它时的音色和语气。</p>
      <blockquote className="voices-sample">{sample}</blockquote>
      <div className="voices-recorder">
        {phase === 'recording' ? (
          <button className="armed voices-rec" onClick={stop}>
            <span className="rec-dot" />
            停止 · {seconds.toFixed(0)} 秒
          </button>
        ) : (
          <button className={phase === 'done' ? 'quiet voices-rec' : 'primary voices-rec'} onClick={() => void start()}>
            <span className="rec-dot idle" />
            {phase === 'done' ? '重录' : '开始录音'}
          </button>
        )}
        {take && phase === 'done' && <audio src={take.url} {...playerProps} />}
      </div>
      {take && phase === 'done' && (
        <>
          <label className="voices-field">
            <span>你念的是</span>
            <textarea value={text} rows={3} onChange={(e) => setText(e.target.value)} />
          </label>
          <p className="voices-hint">念错、漏了字的话照实改上面这段，要和录音一字不差，克隆时靠它对齐。</p>
          <SaveRow first={first} busy={busy} disabled={text.trim() === ''} onSave={(n, d) => void save(n, d)} />
        </>
      )}
      {error && <div className="voices-error">{error}</div>}
    </div>
  );
}

const designPresets = [
  '三十多岁的男性，声音沉稳清晰，语气平静、真诚，语速适中',
  '二十多岁的女性，声音明亮温柔，语气亲切，像在和朋友聊天',
  '四十多岁的男性，嗓音低沉有磁性，说话不紧不慢，很有说服力',
  '三十岁左右的女性，声音干净利落，语气知性、自信',
  '二十出头的男生，声音清爽有活力，语速稍快，带一点笑意',
];

/** 按描述设计：本机 Breeze 按一句描述念一段，同一句描述每次都不一样，多生成几段挑一个存下来。 */
function DesignVoice({ library, first, onSaved }: { library: VoiceLibrary; first: boolean; onSaved: () => Promise<void> }) {
  const [instruction, setInstruction] = useState('');
  const [text, setText] = useState(library.sample_text);
  const [drafts, setDrafts] = useState<VoiceDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState('');
  const [picked, setPicked] = useState('');
  const [playing, setPlaying] = useState('');
  const [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement>(null);

  if (!library.design.ready) return <InstallBreeze design={library.design} onReady={onSaved} />;

  const generate = async () => {
    setBusy(true);
    setError('');
    try {
      const draft = await post<VoiceDraft>('/api/voice-design', { instruction, text });
      setDrafts((old) => [draft, ...old]);
      setPicked(draft.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const play = (id: string) => {
    const el = audio.current;
    if (!el) return;
    if (playing === id) {
      el.pause();
      setPlaying('');
      return;
    }
    el.src = `/api/voice-drafts/${id}.wav`;
    void el.play();
    setPlaying(id);
  };

  const save = async (id: string, name: string, makeDefault: boolean) => {
    setSaving(id);
    setError('');
    try {
      await post(`/api/voice-drafts/${id}/save`, { name, make_default: makeDefault });
      setDrafts((old) => old.filter((d) => d.id !== id));
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving('');
    }
  };

  return (
    <div className="voices-way-body">
      <audio
        ref={audio}
        onEnded={() => setPlaying('')}
        onPause={(event) => {
          if (window.onset?.platform === 'win32' && event.currentTarget.paused) setPlaying('');
        }}
        hidden
      />
      <p className="voices-hint">用一句话描述想要的声音：性别、年龄段、音色和语气。同一句描述每次生成的声音都不一样，多生成几段，挑一段最满意的存下来，以后就一直是它。</p>
      <label className="voices-field">
        <span>想要的声音</span>
        <textarea value={instruction} rows={2} maxLength={200} placeholder="例如：三十多岁的男性，声音沉稳清晰，语气平静、真诚" onChange={(e) => setInstruction(e.target.value)} />
      </label>
      <div className="voices-presets">
        {designPresets.map((p) => (
          <button key={p} className="quiet voices-preset" onClick={() => setInstruction(p)}>
            {p.split('，')[0]}
          </button>
        ))}
      </div>
      <label className="voices-field">
        <span>念这段</span>
        <textarea value={text} rows={2} maxLength={120} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="voices-submit">
        <button className="primary" disabled={busy || instruction.trim() === ''} onClick={() => void generate()}>
          {busy ? '正在生成…' : drafts.length > 0 ? '再生成一段' : '生成试听'}
        </button>
        {busy && <span className="voices-hint">本机生成，大约半分钟到一分钟</span>}
      </div>
      {drafts.length > 0 && (
        <ul className="voices-drafts">
          {drafts.map((d, i) => (
            <li key={d.id} className={picked === d.id ? 'draft is-picked' : 'draft'}>
              <div className="draft-row">
                <button className={playing === d.id ? 'voice-play armed' : 'voice-play'} title={playing === d.id ? '停止' : '试听'} onClick={() => play(d.id)}>
                  <Icon name={playing === d.id ? 'pause' : 'play'} size={14} />
                </button>
                <div className="voice-body">
                  <span className="voice-name">第 {drafts.length - i} 段</span>
                  <p className="voice-instruction">{d.instruction}</p>
                </div>
                {picked !== d.id && (
                  <button className="quiet" onClick={() => setPicked(d.id)}>
                    用这段
                  </button>
                )}
              </div>
              {picked === d.id && <SaveRow first={first} busy={saving === d.id} onSave={(n, def) => void save(d.id, n, def)} />}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="voices-error">{error}</div>}
    </div>
  );
}

/** 本机还没装 Breeze 时：在这里直接装，进度与安装页是同一个任务。 */
function InstallBreeze({ design, onReady }: { design: VoiceLibrary['design']; onReady: () => Promise<void> }) {
  const [progress, setProgress] = useState<{ running: boolean; percent?: number; stage: string; error?: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!progress?.running) return;
    const id = window.setInterval(async () => {
      try {
        const status = await api<SetupStatus>('/api/setup');
        const item = status.task?.items[design.install_id];
        const ready = status.items.find((i) => i.id === design.install_id)?.ready ?? false;
        if (ready) {
          setProgress(null);
          await onReady();
          return;
        }
        setProgress({ running: status.task?.running ?? false, percent: item?.percent, stage: item?.stage ?? '', error: item?.error ?? status.task?.error });
      } catch (err) {
        setError(errorText(err));
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [progress?.running, design.install_id]);

  if (!design.supported) return <div className="voices-way-body voices-empty">{design.problem}。可以改用「录我的声音」或「上传录音」。</div>;

  const install = async () => {
    setError('');
    try {
      await post('/api/setup/run', { only: [design.install_id] });
      setProgress({ running: true, stage: '准备安装' });
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="voices-way-body voices-install">
      <p>
        {window.onset?.platform === 'win32'
          ? '按描述设计使用本机 Breeze TTS 2 Q8_0，通过 NVIDIA CUDA 生成；模型与运行资源约 6.2 GB。'
          : '按描述设计要用本机的 Breeze TTS 2：不联网生成，只能在 Apple Silicon 的 Mac 上运行，模型约 4.6 GB。'}
      </p>
      {progress?.running ? (
        <div className="voices-progress">
          <div className="bar">
            <span style={{ width: `${progress.percent ?? 2}%` }} />
          </div>
          <span className="voice-meta">
            {progress.stage || '安装中'}
            {progress.percent !== undefined ? ` · ${Math.round(progress.percent)}%` : ''}
          </span>
        </div>
      ) : (
        <button className="primary" onClick={() => void install()}>
          安装 Breeze TTS 2
        </button>
      )}
      {(error || progress?.error) && <div className="voices-error">{error || progress?.error}</div>}
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
    <section className="voices-upload voices-way-body">
      <p className="voices-hint">已经录好的一段音频（手机录音、播客片段都行），一两句话，5 到 15 秒最好。下面的文字要和录音里说的逐字一致，克隆时靠它对齐。</p>
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
      </div>
    </section>
  );
}
