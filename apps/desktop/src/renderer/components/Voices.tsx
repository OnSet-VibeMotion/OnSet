import { useEffect, useState } from 'react';
import { api, errorText, post } from '../api';
import type { VoiceEntry, VoiceLibrary } from '../types';
import '../voices.css';
import { Icon } from './Icon';
import { useVoicePlayer, type VoicePlayer, VoiceTrack } from './VoiceWave';
import { DesignVoice } from './voices/DesignVoice';
import { RecordVoice } from './voices/RecordVoice';
import { UploadVoice } from './voices/UploadVoice';

/**
 * 音色页：音色库在用户级目录，所有项目共用。确认过的声音存成「参考音频 + 逐字一致的文字稿」，
 * 用 Breeze 配音时从默认音色克隆，同一个账号的每部片子都是同一个声音。
 *
 * 每个声音画成波形，放的时候文字稿逐字点亮（时间按音频的能量包络估，见 voiceTiming.ts），点波形或点字
 * 从那里开始放。整页共用一个隐藏的播放器，同一时间只放一段。
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

const voiceURL = (v: VoiceEntry) =>
  `/api/voices/${encodeURIComponent(v.name)}/reference.wav?v=${encodeURIComponent(v.created)}`;

export function VoicesTab({ version }: { version: number }) {
  const [library, setLibrary] = useState<VoiceLibrary | null>(null);
  const [error, setError] = useState('');
  const player = useVoicePlayer();

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

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!library) return <div className="empty">{error || '正在读取音色库…'}</div>;
  // 默认音色排在最前、画得大一点。
  const voices = [...library.voices].sort((a, b) => Number(b.is_default) - Number(a.is_default));
  const fallback = library.voices.find((v) => v.is_default);
  return (
    <div className="voices-tab">
      {player.audio}
      <header className="voices-head">
        <div>
          <h2>音色</h2>
          <p>
            确认过的声音存在这里，所有项目共用。用 Breeze
            配音时从默认音色克隆，每部片子都是同一个声音；只靠一句描述设计的声音，每次生成都会变。
          </p>
        </div>
        {library.voices.length > 0 && (
          <dl className="voices-stats">
            <div>
              <dt>声音</dt>
              <dd>{library.voices.length}</dd>
            </div>
            <div>
              <dt>默认</dt>
              <dd className="serif">{fallback?.name ?? '—'}</dd>
            </div>
          </dl>
        )}
      </header>

      {error && <div className="voices-error">{error}</div>}

      {voices.length === 0 ? (
        <div className="voices-empty">
          <p>音色库还是空的。在下面录一段自己的声音，或者描述一个你想要的声音，存进第一个音色。</p>
        </div>
      ) : (
        <ul className="voices-list">
          {voices.map((v) => (
            <VoiceCard
              key={v.name}
              voice={v}
              player={player}
              onDefault={() => void act(() => post(`/api/voices/${encodeURIComponent(v.name)}/default`))}
              onDelete={() => {
                if (player.current === `voice:${v.name}`) player.stop();
                void act(() => api(`/api/voices/${encodeURIComponent(v.name)}`, { method: 'DELETE' }));
              }}
            />
          ))}
        </ul>
      )}

      <NewVoice library={library} player={player} onSaved={reload} />
    </div>
  );
}

function VoiceCard({
  voice: v,
  player,
  onDefault,
  onDelete,
}: {
  voice: VoiceEntry;
  player: VoicePlayer;
  onDefault: () => void;
  onDelete: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const id = `voice:${v.name}`;
  const on = player.current === id && player.playing;
  return (
    <li className={v.is_default ? 'voice is-default' : 'voice'}>
      <div className="voice-top">
        <button
          className={on ? 'voice-play armed' : 'voice-play'}
          title={on ? '停止' : '试听'}
          onClick={() => player.toggle(id, voiceURL(v))}
        >
          <Icon name={on ? 'pause' : 'play'} size={v.is_default ? 16 : 14} />
        </button>
        <div className="voice-title">
          <span className="voice-name">{v.name}</span>
          {v.is_default && <span className="voice-badge">默认</span>}
          <span className="voice-meta">
            {v.duration_seconds.toFixed(1)} 秒 · {sourceNames[v.source]}
          </span>
        </div>
        <div className="voice-actions">
          {!v.is_default && (
            <button className="quiet" onClick={onDefault}>
              设为默认
            </button>
          )}
          {armed ? (
            <button
              className="armed"
              onClick={() => {
                setArmed(false);
                onDelete();
              }}
              onBlur={() => setArmed(false)}
            >
              确认删除
            </button>
          ) : (
            <button className="ghost icon" title="删除" onClick={() => setArmed(true)}>
              <Icon name="trash" />
            </button>
          )}
        </div>
      </div>
      <VoiceTrack id={id} url={voiceURL(v)} text={v.text} player={player} height={v.is_default ? 64 : 40} />
      {v.instruction && <p className="voice-instruction">设计时的描述：{v.instruction}</p>}
    </li>
  );
}

type Way = 'record' | 'design' | 'upload';

/** 做一个新声音：三种办法，存进去的都是「参考音频 + 逐字一致的文字稿」。 */
function NewVoice({
  library,
  player,
  onSaved,
}: {
  library: VoiceLibrary;
  player: VoicePlayer;
  onSaved: () => Promise<void>;
}) {
  const [way, setWay] = useState<Way>('record');
  const first = library.voices.length === 0;
  const ways: [Way, string, string][] = [
    ['record', '录我的声音', '对着麦克风念一段'],
    ['design', '按描述设计', '本机 Breeze 生成'],
    ['upload', '上传录音', '已经录好的音频'],
  ];
  return (
    <section className="voices-new">
      <h3>新的声音</h3>
      <div className="voices-ways" role="tablist">
        {ways.map(([id, label, hint]) => (
          <button
            key={id}
            role="tab"
            aria-selected={way === id}
            className={way === id ? 'way is-on' : 'way'}
            onClick={() => setWay(id)}
          >
            <span className="way-label">{label}</span>
            <span className="way-hint">{hint}</span>
          </button>
        ))}
      </div>
      {way === 'record' && <RecordVoice sample={library.sample_text} first={first} player={player} onSaved={onSaved} />}
      {way === 'design' && <DesignVoice library={library} first={first} player={player} onSaved={onSaved} />}
      {way === 'upload' && <UploadVoice first={first} onSaved={onSaved} />}
    </section>
  );
}
