// 移植自 internal/memory/lint.go。
import { goQuote, goTrimSpace } from '../gofmt';
import { compareBytes } from '../gojson';
import { ValidRenderers } from '../tools';
import { CheckerHuman, knownChecker, knownFeature } from './features';
import { goLowerRune, isDigit, isLetter, runeCount } from './gostr';
import { KindLesson, KindPreference, StatusActive, StatusTrial, validName, validStatus, type Memory } from './memory';
import { contains, equalStrings } from './util';

// 记忆的长度上限（按字符计）。召回有总字数预算，单条太长会挤掉别的记忆。
export const MaxDescriptionChars = 80;
export const MaxBodyChars = 600;

/**
 * RE2 的 (?i) 按 Unicode 简单大小写折叠：s 还匹配 ſ（U+017F），k 还匹配 K（U+212A），
 * 字符类与 \w 也一样折叠。JS 不带 u 的 i 标志不做这两个折叠，所以把字面量里的字母展开成字符类。
 */
function ci(literal: string): string {
  let out = '';
  for (const c of literal) {
    if (c >= 'a' && c <= 'z') {
      let cls = c + c.toUpperCase();
      if (c === 's') cls += '\\u017F';
      if (c === 'k') cls += '\\u212A';
      out += '[' + cls + ']';
    } else {
      out += c;
    }
  }
  return out;
}

/** (?i) 下 [a-z0-9] 的等价类内容（含 ſ 与 K）。 */
const ALNUM = 'a-zA-Z0-9\\u017F\\u212A';
/** (?i) 下 \w 的等价类内容。 */
const WORD = '0-9A-Za-z_\\u017F\\u212A';

const toolWords = ['claude', 'codex', 'qoder', 'codebuddy', 'opencode', 'chatgpt'].map(ci);
const modelWords = ['gemini', 'sonnet', 'opus', 'haiku', 'anthropic', 'openai', 'deepseek', 'qwen', 'kimi', 'glm'].map(ci);

/**
 * 匹配渲染工具名与模型名。经验必须与模型无关：写着「Claude 要这样」
 * 的记忆换一个渲染工具就不成立，而记忆是所有渲染工具共用的。
 */
const forbiddenTool = new RegExp(
  `(^|[^${ALNUM}])(${[...toolWords, ci('gpt') + '-?[0-9]*', ...modelWords].join('|')})([^${ALNUM}]|$)`,
);

// 具体镜头的痕迹：镜头编号与素材文件名。写进经验等于背题，换一篇文章就没用。
const sceneIDPattern = new RegExp(`\\b${ci('scene')}-[0-9]+\\b`);
const mediaNamePattern = new RegExp(
  `[${WORD}.-]+\\.(${['mp4', 'mov', 'webm', 'png', 'jpe?g', 'webp', 'gif', 'wav', 'mp3', 'm4a', 'aac', 'srt'].map(ci).join('|')})\\b`,
);

/** 判定「抄了镜头文案」的最短连续字数。 */
const copiedRunLength = 8;

/** 格式校验需要的上下文。 */
export interface LintContext {
  /** 记忆库里已有的记忆，用来查重名、修订目标与并列冲突。 */
  existing?: readonly Memory[] | null;
  /** 经历里的镜头文本，经验不得照抄其中的连续片段。 */
  sceneTexts?: readonly string[] | null;
}

/** 检查一条记忆能否进入试用，返回全部不合格项。 */
export function lint(m: Memory, ctx: LintContext = {}): string[] {
  const problems: string[] = [];
  const add = (text: string) => problems.push(text);
  if (!validName(m.name)) add(`name 不合法：${goQuote(m.name)}（小写字母、数字与连字符，3–64 字符）`);
  if (goTrimSpace(m.description) === '') {
    add('description 为空');
  } else {
    const n = runeCount(m.description);
    if (n > MaxDescriptionChars) add(`description 有 ${n} 字，上限 ${MaxDescriptionChars}`);
  }
  if (!validStatus(m.status)) add(`status 不合法：${goQuote(m.status)}`);
  if (goTrimSpace(m.body) === '') {
    add('正文为空');
  } else {
    const n = runeCount(m.body);
    if (n > MaxBodyChars) add(`正文有 ${n} 字，上限 ${MaxBodyChars}`);
  }
  const checkedBy = m.checked_by ?? [];
  switch (m.kind) {
    case KindLesson:
      if (checkedBy.length === 0) add('checked_by 为空：说不清由哪个校验器判定的经验不能进入试用');
      for (const id of checkedBy) {
        if (id === CheckerHuman) add('经验的 checked_by 不能是 human；只能由人判定的取向请写成偏好');
        else if (!knownChecker(id)) add(`checked_by 引用了不存在的校验器：${id}`);
      }
      if (!m.body.includes('反例') || !m.body.includes('正例')) add('经验正文必须同时给出「反例」与「正例」');
      if (m.scope !== '') add('scope 只对偏好有意义');
      break;
    case KindPreference:
      if (checkedBy.length !== 1 || checkedBy[0] !== CheckerHuman) add('偏好的 checked_by 必须是 [human]');
      break;
    default:
      add(`未知的记忆层：${goQuote(m.kind)}`);
  }
  for (const feature of m.applies_when.features) {
    if (!knownFeature(feature)) add(`applies_when.features 含未知特征：${feature}`);
  }
  for (const renderer of m.applies_when.renderers) {
    if (!ValidRenderers.has(renderer)) add(`applies_when.renderers 含未知渲染工具：${renderer}`);
  }
  for (const model of m.applies_when.models) {
    if (goTrimSpace(model) === '' || /[ \t\n]/.test(model)) add(`applies_when.models 含不合法的模型名：${goQuote(model)}`);
  }
  const all = [m.name, m.description, m.body, ...m.applies_when.keywords].join('\n');
  const tool = forbiddenTool.exec(all);
  if (tool !== null) {
    add(`正文里出现了渲染工具名或模型名「${tool[2]}」：只对某个渲染工具或模型成立时，写进 applies_when.renderers / models，正文保持中性`);
  }
  const sceneID = sceneIDPattern.exec(all);
  if (sceneID !== null) add(`出现了具体镜头编号「${sceneID[0]}」`);
  const media = mediaNamePattern.exec(all);
  if (media !== null) add(`出现了具体素材文件名「${media[0]}」`);
  const copied = copiedFragment(m.body + '\n' + m.description, ctx.sceneTexts ?? []);
  if (copied !== '') add(`照抄了镜头文案「${copied}」：经验要写成可迁移的约束，不能背题`);
  problems.push(...lintAgainstExisting(m, ctx.existing ?? []));
  return problems;
}

function lintAgainstExisting(m: Memory, existing: readonly Memory[]): string[] {
  const problems: string[] = [];
  if (m.revises !== '') {
    if (m.revises === m.name) {
      problems.push('revises 不能指向自己');
    } else {
      const old = existing.find((e) => e.name === m.revises);
      if (!old) problems.push(`revises 指向不存在的记忆：${m.revises}`);
      else problems.push(...lintRevision(m, old));
    }
  }
  for (const other of existing) {
    if (other.name === m.name || other.name === m.revises || other.kind !== m.kind) continue;
    if (other.status !== StatusActive && other.status !== StatusTrial) continue;
    if (
      m.kind === KindLesson &&
      sameSet(other.checked_by, m.checked_by) &&
      sameSet(other.applies_when.features, m.applies_when.features) &&
      sameSet(other.applies_when.renderers, m.applies_when.renderers) &&
      sameSet(other.applies_when.models, m.applies_when.models)
    ) {
      problems.push(
        `与已有记忆 ${other.name} 由同一组校验器判定、适用特征与渲染工具/模型范围相同：请写成对它的修订（revises: ${other.name}），不要并列新增`,
      );
    }
  }
  return problems;
}

function sameSet(a: readonly string[] | null, b: readonly string[] | null): boolean {
  return equalStrings([...(a ?? [])].sort(compareBytes), [...(b ?? [])].sort(compareBytes));
}

/**
 * text 中第一段与某条镜头文本相同、长度至少 copiedRunLength
 * 的连续片段（忽略空白与标点）。
 */
function copiedFragment(text: string, sceneTexts: readonly string[]): string {
  const body = normalizeRunes(text);
  if (body.length < copiedRunLength) return '';
  const windows = new Set<string>();
  for (const sceneText of sceneTexts) {
    const runes = normalizeRunes(sceneText);
    for (let i = 0; i + copiedRunLength <= runes.length; i++) windows.add(runes.slice(i, i + copiedRunLength).join(''));
  }
  for (let i = 0; i + copiedRunLength <= body.length; i++) {
    const window = body.slice(i, i + copiedRunLength).join('');
    if (windows.has(window)) return window;
  }
  return '';
}

function normalizeRunes(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    if (isLetter(ch) || isDigit(ch)) out.push(goLowerRune(ch));
  }
  return out;
}

/** 经验修订后正文至少要保留的篇幅（相对旧版）。 */
export const MinRevisionRatio = 0.5;

/**
 * 防止修订把经验越改越短、越改越空。
 *
 * ACE（ICLR 2026）记录过整体重写的「上下文坍缩」：一次重写把 18,282 token 的上下文
 * 压成 122 token，准确率跌到比不做自适应还低；LLM 改写还有为求简洁丢掉领域细节的
 * 倾向（brevity bias）。修订是整理者重写一条经验的全文，同样会发生：旧版里由哪个
 * 校验器判定、具体的数值和写法，改写后悄悄没了，而格式校验看不出来。
 * 偏好不查：用户换一种说法替换旧偏好，短一点是正常的。
 */
function lintRevision(m: Memory, old: Memory): string[] {
  if (m.kind !== KindLesson || old.kind !== KindLesson) return [];
  const problems: string[] = [];
  for (const id of old.checked_by ?? []) {
    if (!contains(m.checked_by, id)) {
      problems.push(`修订丢掉了旧版 ${old.name} 的校验器 ${id}：修订要覆盖旧版判定的问题；确实不再适用的，请另写一条经验并让旧版沉睡`);
    }
  }
  const before = runeCount(goTrimSpace(old.body));
  const after = runeCount(goTrimSpace(m.body));
  if (before > 0 && after < before * MinRevisionRatio) {
    problems.push(`修订把正文从 ${before} 字缩到 ${after} 字（不到旧版的一半）：修订要写完整的新版本，保留旧版里仍然成立的细节、数值与反例正例`);
  }
  return problems;
}
