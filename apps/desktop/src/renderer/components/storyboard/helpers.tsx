import type { FilmStyle, StoryboardResponse, StoryboardStyle } from '../../types';
import { Poster } from '../FilmStyles';

/** 视觉角色的一句话说明（制作提示词第五阶段「视觉负载与节奏预算」）。 */
export const roleHints: Record<string, string> = {
  语境: '交代场景、对象或问题从哪里来',
  证据: '截图、数据、原文、对比结果',
  机制: '流程、结构、因果',
  节奏: '过渡、呼吸、情绪停顿',
};

export const lookNames: [keyof NonNullable<StoryboardResponse['look']>, string][] = [
  ['background', '底色'],
  ['surface', '承载面'],
  ['ink', '正文'],
  ['accent', '强调'],
  ['accent_2', '第二强调'],
];

export function duration(seconds: number): string {
  const total = Math.round(Math.max(0, seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function sceneNo(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/** 镜头编号连成段：01–03、07。 */
export function ranges(indexes: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < indexes.length; i++) {
    let j = i;
    while (j + 1 < indexes.length && indexes[j + 1] === indexes[j] + 1) j++;
    out.push(j > i ? `${sceneNo(indexes[i])}–${sceneNo(indexes[j])}` : sceneNo(indexes[i]));
    i = j;
  }
  return out.join('、');
}

/** 风格的小海报：只有「来源/目录名」时也能画（Poster 只用来源、目录名与分类）。 */
export function StyleThumb({ style }: { style: StoryboardStyle | { key: string; cn: string; category_cn?: string } }) {
  if (!style.key) return <span className="sb-style-thumb free">Aa</span>;
  const [source, ...rest] = style.key.split('/');
  const film = { source, slug: rest.join('/'), cn: style.cn, category_cn: style.category_cn ?? '' } as FilmStyle;
  return (
    <span className="sb-style-thumb">
      <Poster style={film} />
    </span>
  );
}

/** 镜头之间换没换画风只看实际用的风格（与 scene_cues 的风格交界判定相同）。 */
export function sameStyle(a: StoryboardStyle, b: StoryboardStyle): boolean {
  return a.key === b.key;
}
