import fs from 'node:fs';
import { compareBytes } from '../gojson';
import { goQuote, pathError } from './gofmt';
import { formatFloats, own, type Rig } from './pack';
import { XmlDecoder, type StartElement } from './xml';

/**
 * 这些元素在 rig 里一律禁止。
 *
 * 前四个是 SMIL 自走动画，最后两个能引入不受 timeline 管的执行与外部内容。
 * HyperFrames 是单条 paused timeline + 逐帧 seek 出帧：任何不挂在那条
 * timeline 上的动画，本地播放正常、成片是错的，而且不报错。
 */
const forbiddenElements = ['animate', 'animateTransform', 'animateMotion', 'set', 'script', 'foreignObject'];

/** style 里出现这些片段同样意味着自走动画。 */
const forbiddenStyleTokens = ['@keyframes', 'animation', 'transition'];

/** 可动件分组 id 的前缀。 */
export const JointPrefix = 'j-';

/**
 * cast.js 用来标记"需要二次翻转"的属性名。facing: left 用
 * scaleX(-1) 整体镜像角色，带 NoMirrorAttr 的元素会被自动二次翻转抵消，
 * 否则举牌、字幕板这类带文字的元素在朝左时会镜像成反字。
 */
export const NoMirrorAttr = 'data-no-mirror';

/**
 * 带方向/文字语义、必须显式标注 NoMirrorAttr（自身
 * 或任一祖先）的元素。这是 character-rig SKILL.md 那条规则本身的机械化：
 * "牌子、字幕板、任何带文字或方向语义的元素都该在 rig.svg 里打上
 * data-no-mirror"。cast.js 的二次翻转只在 rig 子树内按 [data-no-mirror]
 * 选择器查找，失效域正好就是 rig.svg 本身，所以按这条规则逐元素检查相对
 * cast.js 的实现没有误报余地。
 */
const mirrorSensitiveElements = new Set(['text', 'tspan']);

/**
 * 检查内容中是否包含禁止的样式词汇（@keyframes/animation/transition）。
 * location 用于错误消息，例如 "rig 的 <style>" 或 "rig 的 style 属性"。
 */
function checkForbiddenStyleTokens(content: string, location: string): string[] {
  const lower = content.toLowerCase();
  return forbiddenStyleTokens
    .filter((needle) => lower.includes(needle))
    .map((needle) => `${location} 内不得出现 ${needle}：动画必须由 timeline 驱动`);
}

/**
 * 校验 rig.svg 的全部硬约束，返回中文问题列表。
 * 返回空数组表示通过。一次返回所有问题，避免修一条报一条。
 */
export function validateRig(svgPath: string, rig: Rig): string[] {
  let src: string;
  try {
    src = fs.readFileSync(svgPath, 'utf8');
  } catch (err) {
    return [`读取 rig 失败：${pathError('open', svgPath, err)}`];
  }

  const problems: string[] = [];
  const seenJoints = new Set<string>();
  let rootChecked = false;

  // mirrorStack 与当前还未闭合的元素栈一一对应：mirrorStack[i] 表示深度 i
  // 的这个元素、或它的任一祖先，是否已经出现过 NoMirrorAttr。<style> 走
  // decodeElementText 整体消费、不出现在这条栈里，因为它的子树不可能含真正
  // 需要镜像语义的 SVG 文本元素，见下方 "style" 分支的说明。
  const mirrorStack: boolean[] = [];

  const decoder = new XmlDecoder(src);
  for (;;) {
    let token;
    try {
      token = decoder.token();
    } catch (err) {
      problems.push(`解析 rig SVG 失败：${err instanceof Error ? err.message : String(err)}`);
      return problems;
    }
    if (token === null) break;
    if (token.kind === 'end') {
      mirrorStack.pop();
      continue;
    }
    if (token.kind !== 'start') continue;
    const start = token;
    const local = start.name.local;

    for (const name of forbiddenElements) {
      if (local === name) problems.push(`rig 内不得出现 <${name}>：它不受 timeline 控制，seek 出帧会错且不报错`);
    }
    if (local === 'style') {
      // decodeElementText 会读到这个元素自己的结束标签为止，因此
      // 不会有落单的结束标签回到上面的分支——不需要，也
      // 不应该为它 push/pop mirrorStack。
      try {
        const body = decoder.decodeElementText();
        problems.push(...checkForbiddenStyleTokens(body, 'rig 的 <style>'));
      } catch {
        // Go 里 DecodeElement 失败时什么也不做；错误是粘滞的，下一次读 token 时报出。
      }
      continue;
    }

    const parentCovered = mirrorStack.length > 0 && mirrorStack[mirrorStack.length - 1];
    const covered = parentCovered || hasAttr(start, NoMirrorAttr);
    mirrorStack.push(covered);
    if (mirrorSensitiveElements.has(local) && !covered) {
      problems.push(
        `rig 内 <${local}> 缺少 ${NoMirrorAttr}：facing=left 时角色整体镜像，带文字/方向语义的元素` +
          '必须显式标注（自身或祖先均可）做二次翻转抵消，否则举牌类内容会镜像成反字且不报错',
      );
    }

    if (local === 'svg' && !rootChecked) {
      rootChecked = true;
      problems.push(...checkViewBox(start, rig));
    }
    problems.push(...checkAttributes(start));
    if (local === 'g') {
      const id = attr(start, 'id');
      if (id.startsWith(JointPrefix)) {
        seenJoints.add(id.slice(JointPrefix.length));
        problems.push(...checkJointGroupNativeTransform(start, id));
      }
    }
  }
  if (!rootChecked) problems.push('rig 文件里找不到根 <svg>');
  problems.push(...checkJointPairing(seenJoints, rig));
  return problems;
}

/** Go 的 fmt.Sscanf(..., "%g %g %g %g") 读到的浮点数前缀。 */
const floatPrefix = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?|[nN][aA][nN])/;

function sscanFloats(text: string, count: number): number[] | null {
  // 调用方已把空白规整成单个空格。Sscanf 不要求把输入读完，最后一个数后面多出的内容不报错。
  const out: number[] = [];
  let rest = text;
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      if (!rest.startsWith(' ')) return null;
      rest = rest.slice(1);
    }
    const match = floatPrefix.exec(rest);
    if (!match) return null;
    const token = match[0];
    const lower = token.toLowerCase().replace(/^[+-]/, '');
    const value = lower.startsWith('inf') ? (token.startsWith('-') ? -Infinity : Infinity) : lower === 'nan' ? NaN : Number(token);
    out.push(value);
    rest = rest.slice(token.length);
  }
  return out;
}

function checkViewBox(start: StartElement, rig: Rig): string[] {
  const raw = attr(start, 'viewBox');
  const normalized = raw.replaceAll(',', ' ').split(/[\t\n\v\f\r \u0085 ]+/).filter(Boolean).join(' ');
  const box = sscanFloats(normalized, 4);
  if (!box) return [`根 <svg> 的 viewBox 无法解析：${goQuote(raw)}`];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(box[i] - rig.viewBox[i]) > 1e-9) {
      return [`rig.svg 的 viewBox ${formatFloats(box)} 与 character.yaml 声明的 ${formatFloats(rig.viewBox)} 不一致`];
    }
  }
  return [];
}

/**
 * 禁止 j- 分组自带原生 transform 属性。
 *
 * 预览（cast.poseSVG）与运行时（cast.js 的 pose()）都用
 * setAttribute('transform', 'rotate(...)') 独占这个属性：手写的 transform
 * 要么被追加成第二个同名属性（无效 XML，rsvg-convert 行为不可预期），要么
 * 被静默覆盖——本地看着正常，成片是错的，退出码为 0，与本文件里已有的
 * 自走动画禁令是同一类危害。位移/缩放请放在该分组的父级或子级元素上。
 */
function checkJointGroupNativeTransform(start: StartElement, id: string): string[] {
  if (attr(start, 'transform') === '') return [];
  return [`rig 内 <g id=${goQuote(id)}> 不得写 transform：驱动库（预览与运行时）独占这个属性，位移/缩放请放在该分组的父级或子级元素上`];
}

function checkAttributes(start: StartElement): string[] {
  const problems: string[] = [];
  for (const a of start.attrs) {
    const name = a.name.local;
    if (name === 'href') {
      const value = a.value.trim();
      if (value !== '' && !value.startsWith('#')) {
        problems.push(`rig 内不得引用外链资源：${name}=${goQuote(a.value)}（渲染机是干净的无头 Chrome，外链静默失败）`);
      }
    } else if (name === 'vector-effect' && a.value.includes('non-scaling-stroke')) {
      problems.push('rig 内不得使用 vector-effect="non-scaling-stroke"：角色只占画面高度 22–32%，描边不等比缩放会细成发丝');
    } else if (name === 'transform-origin') {
      problems.push('rig 内不得写 transform-origin：pivot 的唯一真相在 character.yaml');
    } else if (name === 'style') {
      if (a.value.includes('transform-origin')) {
        problems.push('rig 的 style 属性内不得写 transform-origin：pivot 的唯一真相在 character.yaml');
      }
      problems.push(...checkForbiddenStyleTokens(a.value, 'rig 的 style 属性'));
    }
  }
  return problems;
}

function checkJointPairing(seen: Set<string>, rig: Rig): string[] {
  const problems: string[] = [];
  const declared = Object.keys(rig.joints ?? {});
  const missing = declared.filter((name) => !seen.has(name)).sort(compareBytes);
  const extra = [...seen].filter((name) => own(rig.joints, name) === undefined).sort(compareBytes);
  if (missing.length > 0) {
    problems.push(`character.yaml 声明的关节在 rig.svg 里找不到对应的 <g id="j-…">：${missing.join('、')}`);
  }
  if (extra.length > 0) problems.push(`rig.svg 里的 j- 分组未在 character.yaml 声明：${extra.join('、')}`);
  return problems;
}

export function attr(start: StartElement, name: string): string {
  return start.attrs.find((a) => a.name.local === name)?.value ?? '';
}

function hasAttr(start: StartElement, name: string): boolean {
  return start.attrs.some((a) => a.name.local === name);
}
