// 风格表。
import {
  type Font,
  FontBebasNeue400,
  FontBungee400,
  FontCaveat600,
  FontChakraPetch700,
  FontCinzel700,
  FontFredoka600,
  FontFredoka700,
  FontFusionPixel400,
  FontLXGWWenKai400,
  FontNotoSerifSC400,
  FontNotoSerifSC700,
  FontOrbitron,
  FontOxanium600,
  FontPressStart2P400,
  FontSilkscreen400,
  FontSmileySans400,
  FontSpaceGrotesk500,
  FontSpaceGrotesk700,
  FontXiaolai400,
  FontZCOOLKuaiLe400,
  FontZCOOLQingKe400,
} from './fonts';

/** 旧版初始化资产的兼容元数据。新镜头不把它当作视觉约束；画幅、安全区和确定性渲染仍由工具单独保证。 */
export interface Style {
  /** 同时是 frame.md 的 style_id，也是 assets/styles/ 与模板目录的目录名。 */
  id: string;
  /** 同时是 frame.md 的 style_name 与风格说明书的文件名前缀。 */
  name: string;
  /** am init 选择框里的一行说明。 */
  label: string;
  /** 示例 contact sheet 的底色，取该风格的结构线或底色。 */
  sheetBackground: string;
  /** 该风格从字体池额外带进项目的字体；共用的 Noto Sans SC 不在此列。 */
  fonts: Font[];
}

/**
 * 每套风格都必须按此顺序声明的四种镜头骨架。四者是叙事职责而不是视觉样式：钩子与强结论、对照、流程、系统总览。
 * 各风格用自己的界面隐喻给它们起名、画示例，但 id 固定，编排提示词与校验才不必随风格改动。
 */
export const ArchetypeIDs = ['proposition', 'comparison', 'process', 'capability_deck'];

/** 风格说明书在项目根下的相对路径。 */
export function guideDoc(s: Pick<Style, 'name'>): string {
  return 'docs/' + s.name + '-视频风格说明书.md';
}

const style = (id: string, name: string, label: string, sheetBackground: string, fonts: Font[] = []): Style => ({ id, name, label, sheetBackground, fonts });

/** 内置风格包的稳定展示顺序。am init 的选择框会把自定义风格放在这些风格包之前。 */
const builtinStyles: Style[] = [
  style('clear-system-blueprint-v1', '清晰系统蓝图', '清晰系统蓝图：知识、技术与产品机制讲解', '#D5DEEB'),
  style('pixel-arcade-v1', '像素街机', '像素街机：8/16-bit 复古游戏、怀旧、入门科普', '#1B1B2F', [FontFusionPixel400, FontPressStart2P400, FontSilkscreen400]),
  style('scifi-hud-v1', '科幻HUD', '科幻 HUD：航天、硬件、系统架构、任务式讲解', '#0A1622', [FontOrbitron]),
  style('cyberpunk-glitch-v1', '赛博故障', '赛博故障：安全攻防、黑客叙事、反差观点', '#120B1E', [FontSmileySans400, FontChakraPetch700]),
  style('candy-casual-v1', '糖果休闲', '糖果休闲手游：轻松科普、生活技巧、成长激励', '#FFE3EE', [FontZCOOLKuaiLe400, FontFredoka600, FontFredoka700]),
  style('rebel-graphic-v1', '二次元锐利拼贴', '二次元锐利拼贴：强观点、排行、角色化表达', '#111111', [FontZCOOLQingKe400, FontBungee400]),
  style('fantasy-quest-v1', '奇幻羊皮卷', '奇幻羊皮卷：历史、故事、学习路线、世界观', '#3B2A1A', [FontNotoSerifSC400, FontNotoSerifSC700, FontCinzel700]),
  style('esports-broadcast-v1', '电竞赛事转播', '电竞赛事转播：对比评测、排行榜、数据战报', '#0B0F1A', [FontBebasNeue400, FontOxanium600]),
  style('visual-novel-v1', '视觉小说对话', '视觉小说对话：故事、对话体、情感与人物', '#2A2238', [FontLXGWWenKai400]),
  style('neon-data-dark-v1', '暗夜数据霓虹', '暗夜数据霓虹：AI、前沿技术、数据与指标', '#070A12', [FontSpaceGrotesk500, FontSpaceGrotesk700]),
  style('editorial-magazine-v1', '杂志编辑排版', '杂志编辑排版：观点、人文、商业评论', '#E8E2D6', [FontNotoSerifSC400, FontNotoSerifSC700]),
  style('whiteboard-doodle-v1', '白板手绘', '白板手绘：教程、概念拆解、课堂讲解', '#E9ECEF', [FontXiaolai400, FontCaveat600]),
  style('anime-cel-v1', '日系动漫', '日系动漫：番剧感科普、成长与挑战、轻快故事', '#8FD3FF', [FontSmileySans400, FontBebasNeue400]),
];

const clone = (s: Style): Style => ({ ...s, fonts: s.fonts.map((f) => ({ ...f })) });

export function allStyles(): Style[] {
  return builtinStyles.map(clone);
}

export function defaultStyle(): Style {
  return clone(builtinStyles[0]);
}

export function styleIDs(): string[] {
  return builtinStyles.map((s) => s.id);
}

export function styleByID(id: string): Style | undefined {
  const s = builtinStyles.find((item) => item.id === id);
  return s && clone(s);
}

/** 供 validate 从 frame.md 的 style_id 反查风格。可选项按 Go 的 %v 写成 [a b c]。 */
export function styleByIDOrError(id: string): Style {
  const s = styleByID(id);
  if (s) return s;
  throw new Error(`未知风格 ${JSON.stringify(id)}，可选：[${styleIDs().join(' ')}]`);
}

/** am init --style 的保留取值：不选内置风格，改由用户描述或模型自主判断生成。 */
export const CustomStyleFlag = 'custom';

/** 旧版自定义风格描述的兼容路径。 */
export const CustomStyleBriefPath = 'docs/style-brief.md';

/** 旧版初始化流程写入项目的兼容说明。新镜头不会把它当作视觉约束。 */
export const AutomaticStyleBrief =
  '不套用预设风格。请根据本片主题、受众和素材自主设计一套清晰、统一、可执行的视觉风格；先确定配色、字体、版式骨架、动效语法与禁用项，再按项目规范完成风格说明书和示例图。';

/** 旧版自定义风格草稿骨架的 style_id。validate style 仍识别它以兼容存量项目，但 scene.load 不再把它视为渲染门禁。 */
export const DraftStyleID = 'custom-draft';

/**
 * 自定义风格草稿骨架在源树与生成器里的身份。它刻意不进内置风格表：生成器、init 选择框与一串枚举内置风格的
 * 测试都遍历那张表，混进去会把草稿当成一套带示例图的正式风格。说明书路径固定为 guideDoc(CustomStyle)。
 */
export const CustomStyle: Style = Object.freeze({
  id: DraftStyleID,
  name: '自定义',
  label: '自定义：旧版参数（不限制新镜头视觉）',
  sheetBackground: '#F5F7FB',
  fonts: [],
}) as Style;

/** 自定义风格 id 的命名空间：小写字母数字，连字符分段。内置风格一律不以 custom- 开头。 */
const customStyleID = /^custom(-[a-z0-9]+)+$/;

/** 判断 style_id 是否属于自定义风格（含草稿）。 */
export function isCustomStyleID(id: string): boolean {
  return customStyleID.test(id);
}
