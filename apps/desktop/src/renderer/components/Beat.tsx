import { useEffect, useMemo, useRef, useState } from 'react';
import { forUser, rawURL } from '../api';
import type { Attachment, BeatState } from '../types';
import { useBeatState, useMusic, usePlayer } from './beat/audio';
import { Counter } from './beat/Counter';
import { BarsList, FixPanel } from './beat/FixPanel';
import { barsOf, bpmOf, clock, detectMeter, lowerBound, regridDownbeats, sameTimes, steps } from './beat/grid';
import { Lane } from './beat/Lane';
import { nextStep } from './beat/NextStep';
import { Story } from './beat/Story';
import type { RunAction } from './Preview';
import type { PageViewProps } from './pageViews';
import '../beat.css';

/**
 * 「节拍」页：卡点模式下代替口播稿页排在第一步。
 *
 * 以前只能听 grid-click.wav（每拍一声、重拍更高）再在终端里看 onset beat bars 的表。这里把同一份网格画出来：
 * 波形上的每一拍、每个重拍和小节号，播放时大字数拍；重拍错位或拍号判错时，在页面上换拍号、换起始拍
 * 立刻就能听到（咔嗒由 WebAudio 按预览的网格现合成，不用等 ffmpeg 重做试听轨），听对了再写回草稿、确认。
 * 写文件只经 onset beat regrid / onset beat confirm 两个写任务，客户端自己不改网格。
 */

interface Props {
  beat: BeatState | null;
  version: number;
  busy: string;
  run: RunAction;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  onScene: (id: string) => void;
}

/** 节拍页（卡点插件登记的页面 beat）：自己读 /api/beat。 */
export function BeatPage(props: PageViewProps) {
  const beat = useBeatState(props.version);
  return (
    <BeatTab
      beat={beat}
      version={props.version}
      busy={props.busy}
      run={props.run}
      onQuick={props.onQuick}
      onScene={props.onScene}
    />
  );
}

/** 不在节拍页时的一行提示：网格还没确认、或分镜计划算不出来时才出现。 */
export function BeatBanner({ version, onTab }: PageViewProps) {
  const beat = useBeatState(version);
  if (!beat?.enabled) return null;
  let text = '';
  if (!beat.grid) text = '卡点模式：还没有节拍网格。';
  else if (beat.grid.kind === 'draft') text = '节拍网格还没确认：试听一遍，重拍对上了再确认。';
  else if (beat.plan_error) text = '分镜计划和节拍网格对不上：' + beat.plan_error;
  if (!text) return null;
  return (
    <div className="banner beat" id="beat-banner">
      <span>{text}</span>
      {onTab && (
        <button className="primary" onClick={() => onTab('beat')}>
          去节拍页
        </button>
      )}
    </div>
  );
}

export function BeatTab(props: Props) {
  const b = props.beat;
  const grid = b?.grid ?? null;
  const music = b?.music_path ? rawURL(b.music_path) : null;
  const { buffer, peaks, error: musicError } = useMusic(music);
  const detected = useMemo(() => (grid ? detectMeter(grid) : { meter: 4, anchor: 0 }), [grid]);
  const [meter, setMeter] = useState(detected.meter);
  const [anchor, setAnchor] = useState(detected.anchor);
  const [clicks, setClicks] = useState(true);
  const [adjusting, setAdjusting] = useState(false);
  /** 只有动过拍号或起始拍才按预览算重拍；没动时照原网格显示（手改、拼接过的网格不一定是规整的 N 拍一小节）。 */
  const [touched, setTouched] = useState(false);
  const gridKey = grid ? `${grid.kind}:${grid.beats.length}:${grid.downbeats.join(',')}` : '';
  useEffect(() => {
    setMeter(detected.meter);
    setAnchor(detected.anchor);
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridKey]);

  const beats = grid?.beats ?? [];
  const saved = grid?.downbeats ?? [];
  const preview = useMemo(
    () => (beats.length > 0 ? regridDownbeats(beats, meter, Math.min(anchor, meter - 1)) : saved),
    [anchor, beats, meter, saved],
  );
  const changed = touched && grid !== null && !sameTimes(preview, saved);
  const downbeats = changed ? preview : saved;
  const duration = grid?.duration_seconds ?? b?.track?.duration_seconds ?? buffer?.duration ?? 0;
  const player = usePlayer(buffer, beats, downbeats, clicks);
  const bars = useMemo(() => barsOf({ beats, downbeats, duration_seconds: duration }), [beats, downbeats, duration]);
  const bpm = useMemo(() => bpmOf(beats), [beats]);
  const odd = bars.slice(0, -1).filter((bar) => bar.beats !== meter);
  const problems = changed ? [] : (b?.problems ?? []);
  const confirmed = grid?.kind === 'confirmed';
  const plan = confirmed && !changed ? (b?.plan ?? []) : [];
  const busy = props.busy !== '';

  // 空格播放 / 暂停；播放中按 T 表示「这一拍是重拍」，起始拍随之改。
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey)
    )
      return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (player.playing) player.pause();
      else player.play(player.pausedAt);
    } else if (e.key === 't' || e.key === 'T') {
      tapDownbeat();
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const tapDownbeat = () => {
    if (beats.length === 0) return;
    const t = player.playing ? player.now() : player.pausedAt;
    // 人反应慢半拍：取离按下时刻最近的一拍，偏后 80 毫秒算作上一拍。
    const at = t - 0.08;
    let i = lowerBound(beats, at);
    if (i >= beats.length || (i > 0 && at - beats[i - 1] < beats[i] - at)) i -= 1;
    setAnchor(((Math.max(0, i) % meter) + meter) % meter);
    setTouched(true);
    setAdjusting(true);
  };

  const togglePlay = () => (player.playing ? player.pause() : player.play(player.pausedAt));

  // 每一步各自判断做没做完，「现在」是第一个没做完的。
  const done = [!!b?.story, !!b?.track, !!grid, confirmed && !changed, !!b?.plan, false];
  const stage = Math.max(0, done.indexOf(false));
  const next = nextStep(stage, b, busy, props.onQuick);

  if (!b?.enabled)
    return (
      <div className="beat-tab">
        <p className="beat-note">这个项目没有启用卡点模式。</p>
      </div>
    );

  return (
    <div className="beat-tab">
      <header className="beat-head">
        <div className="beat-title-row">
          <h1 className="beat-title">节拍</h1>
          {grid && (
            <span className={'beat-status ' + (confirmed && !changed ? 'ok' : 'pending')}>
              {changed ? '预览中，未写回' : confirmed ? '已确认' : '草稿，待确认'}
            </span>
          )}
        </div>
        <ol className="beat-steps">
          {steps.map((label, i) => (
            <li key={label} className={done[i] ? 'done' : i === stage ? 'now' : ''}>
              <span>{String(i + 1).padStart(2, '0')}</span>
              {label}
            </li>
          ))}
        </ol>
        {b.track && (
          <div className="beat-stats">
            <span title="导入的音乐">{b.track.source}</span>
            <span>{clock(duration)}</span>
            {grid && (
              <>
                <span>{bars.length} 小节</span>
                <span>约 {bpm.toFixed(1)} BPM</span>
                <span>每小节 {meter} 拍</span>
                {downbeats.length > 0 && downbeats[0] > 0.05 && (
                  <span title="第一个重拍之前的部分，并进第一个镜头">弱起 {downbeats[0].toFixed(2)} 秒</span>
                )}
                <span className="faint" title="分析模型">
                  {grid.source}
                </span>
              </>
            )}
          </div>
        )}
      </header>

      {next && (
        <section className="beat-next">
          <span className="label">接下来</span>
          <p>{next.text}</p>
          {next.action}
        </section>
      )}
      {b.grid_error && <p className="beat-note bad">{b.grid_error}</p>}
      {b.story && <Story story={b.story} open={stage <= 1} onQuick={props.onQuick} />}
      {musicError && <p className="beat-note bad">波形读不出来：{musicError}</p>}

      {grid && (
        <>
          <section className="beat-player">
            <div className="beat-transport">
              <button
                className="primary play"
                onClick={togglePlay}
                disabled={!buffer}
                aria-label={player.playing ? '暂停' : '播放'}
                title="空格"
              >
                {player.playing ? '❚❚' : '▶'}
              </button>
              <button className="link" onClick={() => player.seek(0)}>
                从头
              </button>
              <label className="beat-toggle">
                <input type="checkbox" checked={clicks} onChange={(e) => setClicks(e.target.checked)} />
                咔嗒声
              </label>
              <span className="beat-hint">
                {buffer ? '每拍一声，重拍更高。听「1」是不是落在音乐的重音上。' : '正在读取音乐…'}
              </span>
            </div>
            <Counter
              beats={beats}
              downbeats={downbeats}
              now={player.now}
              playing={player.playing}
              pausedAt={player.pausedAt}
              meter={meter}
            />
          </section>

          <Lane
            duration={duration}
            peaks={peaks}
            beats={beats}
            downbeats={downbeats}
            meter={meter}
            plan={plan}
            now={player.now}
            playing={player.playing}
            pausedAt={player.pausedAt}
            onSeek={player.seek}
            onScene={props.onScene}
          />

          {problems.length > 0 && (
            <ul className="beat-problems">
              {problems.map((p) => (
                <li key={p}>{forUser(p)}</li>
              ))}
            </ul>
          )}

          <FixPanel
            confirmed={confirmed}
            changed={changed}
            adjusting={adjusting}
            meter={meter}
            anchor={anchor}
            previewCount={preview.length}
            oddCount={odd.length}
            busy={busy}
            problemsCount={(b.problems ?? []).length}
            planError={b.plan_error}
            playing={player.playing}
            pausedAt={player.pausedAt}
            now={player.now}
            downbeats={downbeats}
            onMeter={(m) => {
              setMeter(m);
              setAnchor((a) => Math.min(a, m - 1));
              setTouched(true);
            }}
            onAnchor={(i) => {
              setAnchor(i);
              setTouched(true);
            }}
            onTapDownbeat={tapDownbeat}
            onRestore={() => {
              setMeter(detected.meter);
              setAnchor(detected.anchor);
              setTouched(false);
            }}
            onSetAdjusting={setAdjusting}
            run={props.run}
            onQuick={props.onQuick}
          />

          <BarsList bars={bars} plan={plan} meter={meter} confirmed={confirmed} onSeek={player.seek} />
        </>
      )}
    </div>
  );
}
