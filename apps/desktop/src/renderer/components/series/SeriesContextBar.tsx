import type { SeriesItem } from '../../types';
import { Icon } from '../Icon';

/** 首页输入框上方的当前专栏上下文条：展示所属专栏、本期期号，并支持管理专栏或切回独立视频。 */
export function SeriesContextBar(props: {
  series: SeriesItem;
  episode: string;
  onEpisode: (value: string) => void;
  onManage: () => void;
  onClear: () => void;
}) {
  return (
    <div className="series-context-bar" role="region" aria-label="当前专栏">
      <div className="series-context-left">
        <Icon name="layers" size={13} />
        <strong className="ellipsis">专栏：{props.series.name}</strong>
        <label className="series-context-ep">
          <span>第</span>
          <input
            type="number"
            min={1}
            aria-label="本期期号"
            value={props.episode}
            onChange={(e) => props.onEpisode(e.currentTarget.value)}
          />
          <span>期</span>
        </label>
      </div>
      <div className="series-context-right">
        <button type="button" className="series-link-btn" onClick={props.onManage}>
          管理专栏
        </button>
        <button type="button" className="series-link-btn" onClick={props.onClear}>
          改为独立视频
        </button>
      </div>
    </div>
  );
}
