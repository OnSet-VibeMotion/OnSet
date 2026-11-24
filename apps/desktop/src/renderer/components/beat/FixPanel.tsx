import type { Attachment, BeatPlanSegment } from '../../types';
import type { RunAction } from '../Preview';
import { type Bar, clock, lowerBound, meterChoices } from './grid';

export function FixPanel(props: {
  confirmed: boolean;
  changed: boolean;
  adjusting: boolean;
  meter: number;
  anchor: number;
  previewCount: number;
  oddCount: number;
  busy: boolean;
  problemsCount: number;
  planError?: string;
  playing: boolean;
  pausedAt: number;
  now: () => number;
  downbeats: number[];
  onMeter: (m: number) => void;
  onAnchor: (a: number) => void;
  onTapDownbeat: () => void;
  onRestore: () => void;
  onSetAdjusting: (open: boolean) => void;
  run: RunAction;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
}) {
  if (props.confirmed && !props.changed && !props.adjusting) {
    return (
      <section className="beat-fix compact">
        {props.planError && <p className="beat-note bad">分镜计划和节拍对不上：{props.planError}</p>}
        <div className="beat-actions">
          <button className="link" onClick={() => props.onSetAdjusting(true)}>
            重新调整重拍
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="beat-fix">
      <div className="beat-fix-row">
        <span className="label">每小节</span>
        <div className="seg">
          {meterChoices.map((m) => (
            <button key={m} className={m === props.meter ? 'on' : ''} onClick={() => props.onMeter(m)}>
              {m} 拍
            </button>
          ))}
        </div>
      </div>
      <div className="beat-fix-row">
        <span className="label">重拍是</span>
        <div className="seg">
          {Array.from({ length: props.meter }, (_, i) => (
            <button key={i} className={i === props.anchor ? 'on' : ''} onClick={() => props.onAnchor(i)}>
              第 {i + 1} 拍
            </button>
          ))}
        </div>
        <button
          onClick={props.onTapDownbeat}
          disabled={!props.playing}
          title="播放中，在你听到的重拍上按一下（或按 T 键）"
        >
          在重拍上敲一下 · T
        </button>
      </div>
      <p className="beat-note">
        {props.changed
          ? `预览：${props.meter} 拍一小节，从第 ${props.anchor + 1} 拍起算重拍，共 ${props.previewCount} 小节。听对了再写回草稿。`
          : props.oddCount > 0
            ? `有 ${props.oddCount} 个小节不是 ${props.meter} 拍（波形上用黄色标出），多半是模型在那里漏了或多了重拍；整体错位时换「重拍是第几拍」，零星几处可以在对话里说是第几小节。`
            : props.confirmed
              ? '改网格会让已写好的镜头时长全部失效，要重跑 onset beat cues 并重渲染。'
              : '整体错位（「1」总落在第 2、3 拍上）就换「重拍是第几拍」；拍子数不对就换每小节几拍。'}
      </p>
      <div className="beat-actions">
        {props.changed ? (
          <>
            <button
              className="primary"
              disabled={props.busy}
              onClick={() => props.run('/api/commands/beat.regrid', { meter: props.meter, anchor: props.anchor })}
            >
              写回草稿
            </button>
            <button onClick={props.onRestore}>还原</button>
          </>
        ) : (
          !props.confirmed && (
            <button
              className="primary"
              disabled={props.busy || props.problemsCount > 0}
              onClick={() => props.run('/api/commands/beat.confirm')}
            >
              听过了，确认网格
            </button>
          )
        )}
        <button
          onClick={() =>
            props.onQuick(
              `节拍网格有问题：${props.pausedAt > 0 || props.playing ? `大约在 ${clock(props.playing ? props.now() : props.pausedAt)}（第 ${lowerBound(props.downbeats, (props.playing ? props.now() : props.pausedAt) + 0.001)} 小节）附近，` : ''}`,
              [],
              true,
            )
          }
        >
          在对话里说哪里不对
        </button>
        {props.confirmed && !props.changed && (
          <button className="link" onClick={() => props.onSetAdjusting(false)}>
            收起
          </button>
        )}
      </div>
    </section>
  );
}

export function BarsList({
  bars,
  plan,
  meter,
  confirmed,
  onSeek,
}: {
  bars: Bar[];
  plan: BeatPlanSegment[];
  meter: number;
  confirmed: boolean;
  onSeek: (t: number) => void;
}) {
  return (
    <section
      className="beat-bars"
      data-ctx-source={confirmed ? 'production/beat/grid.json' : 'production/beat/grid-draft.json'}
      data-ctx-label="节拍网格"
    >
      {bars.map((bar, i) => {
        const seg = plan.find((s) => bar.number >= s.first_bar && bar.number < s.first_bar + s.bars);
        const segStart = seg && seg.first_bar === bar.number;
        const irregular = i < bars.length - 1 && bar.beats !== meter;
        return (
          <button
            key={bar.number}
            className={'beat-bar' + (irregular ? ' odd' : '') + (segStart ? ' cut' : '')}
            onClick={() => onSeek(bar.start)}
            title={`第 ${bar.number} 小节 ${clock(bar.start, 2)} – ${clock(bar.end, 2)}，${bar.beats} 拍${seg ? `，镜头 ${seg.id}` : ''}`}
          >
            <span className="no">{bar.number}</span>
            <span className="t">{clock(bar.start)}</span>
            {irregular && <span className="n">{bar.beats}拍</span>}
            {segStart && <span className="scene">{seg!.id}</span>}
          </button>
        );
      })}
    </section>
  );
}
