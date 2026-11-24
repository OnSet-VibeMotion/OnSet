import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../../api';
import { Icon } from '../Icon';
import { Bars, useLiveLevels, type VoicePlayer, VoiceTrack } from '../VoiceWave';
import { SaveRow } from './SaveRow';

/** 录音最长 30 秒（参考音频的上限），少于 3 秒存不进去。 */
const maxRecordSeconds = 30;

/** 对着麦克风念一段：念的就是页面上这段字，逐字稿自然对得上；念错了可以在下面改。 */
export function RecordVoice({
  sample,
  first,
  player,
  onSaved,
}: {
  sample: string;
  first: boolean;
  player: VoicePlayer;
  onSaved: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'done'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [take, setTake] = useState<{ blob: Blob; url: string } | null>(null);
  const [text, setText] = useState(sample);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number>(0);
  const levels = useLiveLevels(stream);

  useEffect(
    () => () => {
      window.clearInterval(timer.current);
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const start = async () => {
    setError('');
    if (player.current === 'take') player.stop();
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const name = (err as DOMException).name;
      setError(
        name === 'NotAllowedError'
          ? '没有麦克风权限：在「系统设置 → 隐私与安全性 → 麦克风」里允许这个应用，再点一次开始录音。'
          : `打不开麦克风：${(err as Error).message}`,
      );
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(media);
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    rec.onstop = () => {
      media.getTracks().forEach((t) => t.stop());
      window.clearInterval(timer.current);
      setStream(null);
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      setTake((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { blob, url: URL.createObjectURL(blob) };
      });
      setPhase('done');
    };
    recorder.current = rec;
    rec.start();
    setStream(media);
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
      if (player.current === 'take') player.stop();
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
      <p className="voices-hint">
        找个安静的地方，用平时说话的语气把下面这段念一遍，十秒左右。克隆出来的声音会学你念它时的音色和语气。
      </p>
      {phase === 'done' && take ? (
        <div className="voices-take">
          <div className="voices-take-head">
            <button
              className={player.current === 'take' && player.playing ? 'voice-play armed' : 'voice-play'}
              title="回放"
              onClick={() => player.toggle('take', take.url)}
            >
              <Icon name={player.current === 'take' && player.playing ? 'pause' : 'play'} size={14} />
            </button>
            <span className="voice-name">刚才这段</span>
            <span className="voice-meta">回放时字会跟着亮，对不上的地方多半是念错或漏了</span>
          </div>
          <VoiceTrack id="take" url={take.url} text={text} player={player} height={56} />
        </div>
      ) : (
        <blockquote className={phase === 'recording' ? 'voices-sample is-recording' : 'voices-sample'}>
          {sample}
        </blockquote>
      )}
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
        {phase === 'recording' && (
          <div className="voices-live">
            <Bars levels={levels} height={36} />
            <div className="voices-limit" title={`最长 ${maxRecordSeconds} 秒`}>
              <span style={{ width: `${Math.min(100, (seconds / maxRecordSeconds) * 100)}%` }} />
            </div>
          </div>
        )}
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
