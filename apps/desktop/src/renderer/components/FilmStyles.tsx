import '../film-styles.css';
import { FilmStyleDialog } from './film-styles/FilmStyleDialog';
import { styleKey, useFilmStyles } from './film-styles/shared';

export { FilmStyleDialog } from './film-styles/FilmStyleDialog';
export { FilmStylePicker } from './film-styles/FilmStylePicker';
export { Poster, styleKey, useFilmStyles } from './film-styles/shared';

/**
 * 整片风格的选择器：首页与「风格」页的「换风格」用弹窗（FilmStyleDialog），新建对话框与还没有风格的「风格」页内嵌网格（FilmStylePicker）。
 *
 * 风格来自多个风格来源，按「来源 → 分类」分组，每种风格的标识是「来源/目录名」。
 * 目录随 onset 下发，打开就有；海报在来源数据里。来源数据是前置资源，由用户在终端里
 * 运行 onset setup 准备，Studio 不下载：没准备好的来源显示占位块和提示。
 */

/**
 * 给一个镜头换风格：弹窗选好后不改文件（客户端不写项目文件），把要求写进输入框交给编排工具——
 * 它要改分镜计划里这个镜头的 film_style、没装的风格先装进项目，并给变成风格交界的地方挑过渡手法。
 * 镜头页与分镜页共用。
 */
export function SceneStyleDialog(props: {
  /** 对话里怎么称呼这个镜头，例如「镜头 03（scene-003）」。 */
  who: string;
  /** 镜头写的 film_style 原值：空是默认风格，none 是不用整片风格。 */
  current: string;
  /** 项目的默认风格。 */
  defaultStyle?: { key: string; cn: string };
  /** 已经装进项目的风格标识。 */
  installed: ReadonlySet<string>;
  /** 风格标识换成中文名（目录里没有时用）。 */
  nameOf?: (key: string) => string | undefined;
  onAsk: (text: string) => void;
  onClose: () => void;
}) {
  const films = useFilmStyles(true);
  const name = (key: string) => props.nameOf?.(key) ?? films.data?.styles.find((x) => styleKey(x) === key)?.cn ?? key;
  const pick = (value: string) => {
    let ask: string;
    if (value === '@default') {
      ask = props.defaultStyle
        ? `把${props.who}改回默认风格「${props.defaultStyle.cn}」。`
        : `把${props.who}改回不写风格、自主定视觉。`;
    } else if (value === 'none') {
      ask = `把${props.who}改成不用整片风格、自主定视觉。`;
    } else {
      ask =
        `把${props.who}换成「${name(value)}」风格（${value}）。` +
        (props.installed.has(value) ? '' : '这种风格还没装进项目，先用 film_style_add() 装上。');
    }
    props.onAsk(
      ask +
        '改分镜计划里这个镜头的 film_style 并重跑 scene_cues()（没有分镜计划的项目直接改镜头 scene.json 的 film_style），再按新风格的镜头语法改它的 prompt.md 里的景别、镜头运动与构图；它和相邻镜头的风格不同时，按「风格交界」挑一种过渡手法，让画法在画面里自然地换过去，不要硬切或叠化。',
    );
  };
  return (
    <FilmStyleDialog
      title={`${props.who} 换一种风格`}
      intro="选好后写进对话，由 AI 改分镜，并给前后的风格交界设计画面里的过渡。"
      confirm="写进对话"
      data={films.data}
      error={films.error}
      posterVersion={films.posterVersion}
      selected={props.current === '' ? '@default' : props.current}
      installed={props.installed}
      specials={[
        {
          value: '@default',
          title: props.defaultStyle ? `跟随默认风格：${props.defaultStyle.cn}` : '跟随默认风格',
          desc: props.defaultStyle ? '和全片大多数镜头一样。' : '项目还没有默认风格，镜头自主定视觉。',
          mark: '默',
        },
        { value: 'none', title: '不用整片风格', desc: '这个镜头按文案自己定配色、字体与动效。', mark: 'Aa' },
      ]}
      onPick={pick}
      onClose={props.onClose}
    />
  );
}
