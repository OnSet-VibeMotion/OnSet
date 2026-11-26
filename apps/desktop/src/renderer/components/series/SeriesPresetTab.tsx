import type { ModeOption, StylesResponse } from '../../types';
import { Icon } from '../Icon';

export function SeriesPresetTab(props: {
  name: string;
  description: string;
  canvas: string;
  modeId: string;
  styleLabel: string;
  motionEffects: string[];
  motionOptions: { ref: string; name: string }[];
  motionPickerOpen: boolean;
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
  onToggleMotionPicker: () => void;
  onMotionEffectsChange: (v: string[]) => void;
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
      <div className="series-field">
        <div className="series-motion-head">
          <span>常用动效（写分镜时优先复用，可选）</span>
          <button type="button" className="series-link-btn" onClick={props.onToggleMotionPicker}>
            {props.motionPickerOpen ? '收起选择' : '+ 添加常用动效'}
          </button>
        </div>
        {props.motionEffects.length > 0 && (
          <div className="series-motion-chips">
            {props.motionEffects.map((ref) => {
              const hit = props.motionOptions.find((m) => m.ref === ref);
              const shortId = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref;
              return (
                <span key={ref} className="series-motion-chip" title={ref}>
                  <span>{hit ? `${shortId} ${hit.name}` : ref}</span>
                  <button
                    type="button"
                    aria-label={`移除常用动效 ${ref}`}
                    onClick={() => props.onMotionEffectsChange(props.motionEffects.filter((x) => x !== ref))}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {props.motionPickerOpen && (
          <select
            aria-label="选择常用动效"
            value=""
            onChange={(e) => {
              const picked = e.currentTarget.value;
              if (picked && !props.motionEffects.includes(picked)) {
                props.onMotionEffectsChange([...props.motionEffects, picked]);
              }
            }}
          >
            <option value="">选择一条动效加入专栏常用…</option>
            {props.motionOptions
              .filter((m) => !props.motionEffects.includes(m.ref))
              .map((m) => (
                <option key={m.ref} value={m.ref}>
                  {m.ref} · {m.name}
                </option>
              ))}
          </select>
        )}
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
