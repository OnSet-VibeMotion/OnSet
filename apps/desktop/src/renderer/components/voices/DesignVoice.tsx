import { useEffect, useState } from 'react';
import { api, errorText, post } from '../../api';
import type { SetupStatus, VoiceDraft, VoiceLibrary } from '../../types';
import { Icon } from '../Icon';
import { type VoicePlayer, VoiceTrack } from '../VoiceWave';
import { SaveRow } from './SaveRow';

const designPresets = [
  '三十多岁的男性，声音沉稳清晰，语气平静、真诚，语速适中',
  '二十多岁的女性，声音明亮温柔，语气亲切，像在和朋友聊天',
  '四十多岁的男性，嗓音低沉有磁性，说话不紧不慢，很有说服力',
  '三十岁左右的女性，声音干净利落，语气知性、自信',
  '二十出头的男生，声音清爽有活力，语速稍快，带一点笑意',
];

/** 按描述设计：本机 Breeze 按一句描述念一段，同一句描述每次都不一样，多生成几段挑一个存下来。 */
export function DesignVoice({
  library,
  first,
  player,
  onSaved,
}: {
  library: VoiceLibrary;
  first: boolean;
  player: VoicePlayer;
  onSaved: () => Promise<void>;
}) {
  const [instruction, setInstruction] = useState('');
  const [text, setText] = useState(library.sample_text);
  const [drafts, setDrafts] = useState<VoiceDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState('');
  const [picked, setPicked] = useState('');
  const [error, setError] = useState('');

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

  const save = async (id: string, name: string, makeDefault: boolean) => {
    setSaving(id);
    setError('');
    try {
      await post(`/api/voice-drafts/${id}/save`, { name, make_default: makeDefault });
      if (player.current === `draft:${id}`) player.stop();
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
      <p className="voices-hint">
        用一句话描述想要的声音：性别、年龄段、音色和语气。同一句描述每次生成的声音都不一样，多生成几段，挑一段最满意的存下来，以后就一直是它。
      </p>
      <label className="voices-field">
        <span>想要的声音</span>
        <textarea
          value={instruction}
          rows={2}
          maxLength={200}
          placeholder="例如：三十多岁的男性，声音沉稳清晰，语气平静、真诚"
          onChange={(e) => setInstruction(e.target.value)}
        />
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
          {drafts.map((d, i) => {
            const id = `draft:${d.id}`;
            const url = `/api/voice-drafts/${d.id}.wav`;
            const on = player.current === id && player.playing;
            return (
              <li key={d.id} className={picked === d.id ? 'draft is-picked' : 'draft'}>
                <div className="draft-row">
                  <button
                    className={on ? 'voice-play armed' : 'voice-play'}
                    title={on ? '停止' : '试听'}
                    onClick={() => player.toggle(id, url)}
                  >
                    <Icon name={on ? 'pause' : 'play'} size={14} />
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
                <VoiceTrack id={id} url={url} text={d.text} player={player} height={40} />
                {picked === d.id && (
                  <SaveRow first={first} busy={saving === d.id} onSave={(n, def) => void save(d.id, n, def)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <div className="voices-error">{error}</div>}
    </div>
  );
}

/** 本机还没装 Breeze 时：在这里直接装，进度与安装页是同一个任务。 */
function InstallBreeze({ design, onReady }: { design: VoiceLibrary['design']; onReady: () => Promise<void> }) {
  const [progress, setProgress] = useState<{
    running: boolean;
    percent?: number;
    stage: string;
    error?: string;
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!progress?.running) return;
    const id = window.setInterval(() => {
      void (async () => {
        try {
          const status = await api<SetupStatus>('/api/setup');
          const item = status.task?.items[design.install_id];
          const ready = status.items.find((i) => i.id === design.install_id)?.ready ?? false;
          if (ready) {
            setProgress(null);
            await onReady();
            return;
          }
          setProgress({
            running: status.task?.running ?? false,
            percent: item?.percent,
            stage: item?.stage ?? '',
            error: item?.error ?? status.task?.error,
          });
        } catch (err) {
          setError(errorText(err));
        }
      })();
    }, 1000);
    return () => window.clearInterval(id);
  }, [progress?.running, design.install_id]);

  if (!design.supported) {
    return <div className="voices-way-body voices-empty">{design.problem}。可以改用「录我的声音」或「上传录音」。</div>;
  }

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
