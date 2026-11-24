export function SeriesPublishTemplateTab(props: {
  loaded: boolean;
  busy: boolean;
  dirty: boolean;
  titlePattern: string;
  hashtags: string;
  coverGuide: string;
  footer: string;
  credits: string;
  onChange: (field: 'titlePattern' | 'hashtags' | 'coverGuide' | 'footer' | 'credits', value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="series-form">
      <label className="series-field">
        <span>标题模板</span>
        <input
          disabled={!props.loaded || props.busy}
          value={props.titlePattern}
          placeholder="例如：【EP{nn}】{title}"
          onChange={(e) => props.onChange('titlePattern', e.currentTarget.value)}
        />
      </label>
      <label className="series-field">
        <span>固定话题标签（空格分隔）</span>
        <input
          disabled={!props.loaded || props.busy}
          value={props.hashtags}
          placeholder="例如：#AI硬核拆解 #科普动画"
          onChange={(e) => props.onChange('hashtags', e.currentTarget.value)}
        />
      </label>
      <label className="series-field">
        <span>系列封面视觉规范</span>
        <textarea
          disabled={!props.loaded || props.busy}
          rows={3}
          value={props.coverGuide}
          placeholder="例如：左上角固定 EP 编号黄铜徽章，右下角留主题主视觉"
          onChange={(e) => props.onChange('coverGuide', e.currentTarget.value)}
        />
      </label>
      <label className="series-field">
        <span>简介固定脚标</span>
        <textarea
          disabled={!props.loaded || props.busy}
          rows={3}
          value={props.footer}
          placeholder="例如：订阅本专栏，每周更新底层技术拆解。"
          onChange={(e) => props.onChange('footer', e.currentTarget.value)}
        />
      </label>
      <label className="series-field">
        <span>固定素材署名（每行一条）</span>
        <textarea
          disabled={!props.loaded || props.busy}
          rows={2}
          value={props.credits}
          placeholder="例如：片头音乐：XXX（CC BY 4.0）"
          onChange={(e) => props.onChange('credits', e.currentTarget.value)}
        />
      </label>
      <div className="series-foot-right">
        <button className="pill primary-pill" disabled={props.busy || !props.loaded} onClick={props.onSave}>
          {props.dirty ? '保存发布模板 *' : '保存发布模板'}
        </button>
      </div>
    </div>
  );
}
