import type { ModeOption, StylesResponse } from '../../types';
import { Icon } from '../Icon';

export function SeriesPresetTab(props: {
  name: string;
  description: string;
  canvas: string;
  modeId: string;
  styleLabel: string;
  ttsVoice: string;
  voices: string[];
  parentDir: string;
  namingPattern: string;
  nextEpisode: string;
  styles: StylesResponse | null;
  modes: ModeOption[];
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onCanvasChange: (v: string) => void;
  onModeChange: (v: string) => void;
  onOpenStylePicker: () => void;
  onVoiceChange: (v: string) => void;
  onParentDirChange: (v: string) => void;
  onNamingPatternChange: (v: string) => void;
  onNextEpisodeChange: (v: string) => void;
}) {
  return (
    <div className="series-form">
      <label className="series-field">
        <span>专栏名称</span>
        <input
          value={props.name}
          placeholder="例如：AI 硬核拆解"
          onChange={(e) => props.onNameChange(e.currentTarget.value)}
        />
      </label>
      <label className="series-field">
        <span>一句话定位（可选）</span>
        <input
          value={props.description}
          placeholder="例如：每周一条 3 分钟原理动画科普"
          onChange={(e) => props.onDescriptionChange(e.currentTarget.value)}
        />
      </label>
      <div className="series-grid">
        <label className="series-field">
          <span>默认画幅</span>
          <select value={props.canvas} onChange={(e) => props.onCanvasChange(e.currentTarget.value)}>
            <option value="">跟随默认</option>
            {props.styles?.canvases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}（{c.width}×{c.height}）
              </option>
            ))}
          </select>
        </label>
        <label className="series-field">
          <span>默认做法</span>
          <select value={props.modeId} onChange={(e) => props.onModeChange(e.currentTarget.value)}>
            {props.modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="series-grid">
        <div className="series-field">
          <span>默认整片风格</span>
          <button type="button" className="series-picker-btn" onClick={props.onOpenStylePicker}>
            <span>{props.styleLabel}</span>
            <Icon name="chevron" size={10} />
          </button>
        </div>
        <label className="series-field">
          <span>默认音色（可选）</span>
          {props.voices.length > 0 ? (
            <select value={props.ttsVoice} onChange={(e) => props.onVoiceChange(e.currentTarget.value)}>
              <option value="">跟随全局默认音色</option>
              {props.voices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={props.ttsVoice}
              placeholder="音色库里的名字，留空跟随全局"
              onChange={(e) => props.onVoiceChange(e.currentTarget.value)}
            />
          )}
        </label>
      </div>
      <label className="series-field">
        <span>默认保存父目录</span>
        <input
          value={props.parentDir}
          placeholder="新建每期视频默认放到这里"
          onChange={(e) => props.onParentDirChange(e.currentTarget.value)}
        />
      </label>
      <div className="series-grid">
        <label className="series-field">
          <span>期号命名模板</span>
          <input
            value={props.namingPattern}
            placeholder="EP{nn}-{title}"
            onChange={(e) => props.onNamingPatternChange(e.currentTarget.value)}
          />
        </label>
        <label className="series-field">
          <span>下一期期号</span>
          <input
            type="number"
            min={1}
            value={props.nextEpisode}
            onChange={(e) => props.onNextEpisodeChange(e.currentTarget.value)}
          />
        </label>
      </div>
    </div>
  );
}
