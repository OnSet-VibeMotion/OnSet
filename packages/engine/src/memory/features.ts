import fs from 'node:fs';
import path from 'node:path';
import { ruleIDs as determinismRuleIDs } from '../determinism';
import { compareBytes } from '../gojson';
import { ruleIDs as readsRuleIDs } from '../reads';
import {
  sceneCanvas,
  CheckFramesBlank,
  CheckReviewHandoff,
  DeterminismCheckPrefix,
  handoffGuide,
  handoffIsZero,
  outputCheckIDs,
  ReadsCheckPrefix,
  type Scene,
} from '../scene';
import { goToLower, isDigit, isHan, isLetter } from './gostr';
import type { Memory } from './memory';

/**
 * 镜头特征词表：召回按它匹配，整理时交给整理者，
 * 格式校验要求经验的 applies_when.features 只能取这里的值。
 * 新增特征要同时改 features 的抽取逻辑。
 */
export const FeatureDescriptions: Readonly<Record<string, string>> = {
  cjk_text: '镜头文本含中文',
  numbers: '镜头文本含数字',
  dense_text: '文本密度高（每秒超过 6.5 个阅读单位）',
  short_scene: '镜头短于 2 秒',
  long_scene: '镜头长于 10 秒',
  portrait: '竖屏画布',
  landscape: '横屏画布',
  square: '方形画布',
  cast: '有角色（cast 块）',
  song: '歌曲模式',
  beat: '卡点模式',
  timing: '有口播时间合同（timing 块）',
  handoff: '与相邻镜头有交接约定',
  cross_chapter: '交接跨章节',
  lottie: '创意方向提到 Lottie',
  chart: '创意方向提到图表',
  three_d: '创意方向提到 3D / three.js / WebGL',
};

/** 接交接手法名，如 handoff:carry。 */
const handoffFeaturePrefix = 'handoff:';

/** 报告 name 是不是词表里的特征（含 handoff:<手法>）。 */
export function knownFeature(name: string): boolean {
  if (Object.hasOwn(FeatureDescriptions, name)) return true;
  if (name.startsWith(handoffFeaturePrefix)) return handoffGuide(name.slice(handoffFeaturePrefix.length)) !== '';
  return false;
}

/** 从镜头输入里抽取特征，结果有序、确定。 */
export function features(s: Scene): string[] {
  const set = new Set<string>();
  let readable = 0;
  let inWord = false;
  for (const ch of s.text) {
    if (isHan(ch)) {
      set.add('cjk_text');
      readable++;
      inWord = false;
    } else if (isDigit(ch)) {
      set.add('numbers');
      if (!inWord) readable++;
      inWord = true;
    } else if (isLetter(ch)) {
      if (!inWord) readable++;
      inWord = true;
    } else {
      inWord = false;
    }
  }
  if (s.duration_seconds > 0 && readable / s.duration_seconds > 6.5) set.add('dense_text');
  if (s.duration_seconds < 2) set.add('short_scene');
  if (s.duration_seconds > 10) set.add('long_scene');
  const canvas = sceneCanvas(s);
  if (canvas.heightPx > canvas.widthPx) set.add('portrait');
  else if (canvas.widthPx > canvas.heightPx) set.add('landscape');
  else set.add('square');
  if (s.cast !== null) set.add('cast');
  if (s.song !== null) set.add('song');
  if (s.beat !== null) set.add('beat');
  if (s.timing !== null) {
    set.add('timing');
    for (const side of [s.timing.enter, s.timing.exit]) {
      if (handoffIsZero(side)) continue;
      set.add('handoff');
      set.add(handoffFeaturePrefix + side.device);
      if (side.cross_chapter) set.add('cross_chapter');
    }
  }
  const prompt = goToLower(promptText(s));
  const words: Record<string, string[]> = {
    lottie: ['lottie'],
    chart: ['图表', '柱状', '折线', '饼图', 'chart'],
    three_d: ['three.js', 'threejs', 'webgl', '3d'],
  };
  for (const [feature, list] of Object.entries(words)) {
    if (list.some((word) => prompt.includes(word))) set.add(feature);
  }
  return [...set].sort(compareBytes);
}

/** 镜头的创意方向（prompt.md），没有时为空。 */
export function promptText(s: Scene): string {
  try {
    return fs.readFileSync(path.join(s.directory, 'prompt.md'), 'utf8');
  } catch {
    return '';
  }
}

/** 只能出现在偏好的 checked_by 里：偏好由人判定。 */
export const CheckerHuman = 'human';

/** 经验可以引用的全部校验器 ID。 */
export function knownCheckers(): string[] {
  const ids = outputCheckIDs();
  for (const rule of determinismRuleIDs()) ids.push(DeterminismCheckPrefix + rule);
  ids.push(CheckFramesBlank);
  for (const rule of readsRuleIDs()) ids.push(ReadsCheckPrefix + rule);
  ids.push(CheckReviewHandoff);
  return ids;
}

/**
 * 报告校验器能否在单镜头回放考试里判定。
 *
 * 产物校验、确定性扫描在渲染后自动跑；空白帧由考试在作答后补查首帧。
 * 阅读时间要读整片的可读元素清单与短语时间轴，交接要看相邻镜头，单镜头重放
 * 判不了——只靠它们判定的经验不进考试，由人确认后生效，标为未经考试。
 */
export function examinable(id: string): boolean {
  return !id.startsWith(ReadsCheckPrefix) && id !== CheckReviewHandoff;
}

/** 报告经验是否至少有一个校验器能在考试里判定。 */
export function examinableLesson(m: Memory): boolean {
  return (m.checked_by ?? []).some((id) => examinable(id));
}

export function knownChecker(id: string): boolean {
  return knownCheckers().includes(id);
}
