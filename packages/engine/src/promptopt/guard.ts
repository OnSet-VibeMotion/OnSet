/**
 * 改写前后的硬性核对：模型被要求原样保留的东西，代码再查一遍。
 *
 * 提示词里「必须保留」只是请求，模型压缩、润色时常常顺手丢掉一个路径或一句「不要」；
 * 丢了不报的话，用户点「用这版」「采用」时就静默少了一条要求。所以少一项就不采用这份改写。
 */

/** 反引号、「」、“”、"" 里的内容（去掉首尾空白，空的不算）。 */
function quoted(text: string): string[] {
  const out: string[] = [];
  for (const re of [/`([^`\n]+)`/g, /「([^」\n]+)」/g, /“([^”\n]+)”/g, /"([^"\n]+)"/g]) {
    for (const m of text.matchAll(re)) {
      const inner = m[1]!.trim();
      if (inner !== '') out.push(inner);
    }
  }
  return out;
}

/** 文件路径：带常见素材或文档扩展名的一串。 */
const pathPattern = /(?:[A-Za-z0-9_\-.]+\/)*[A-Za-z0-9_\-.一-鿿]+\.(?:png|jpe?g|webp|gif|svg|mp4|mov|webm|mp3|wav|m4a|json|ya?ml|md|txt|srt|glb|gltf|obj|fbx|ttf|otf|woff2?|lottie|csv)\b/gi;

export function filePaths(text: string): string[] {
  return [...new Set([...text.matchAll(pathPattern)].map((m) => m[0]))];
}

/** 输入框里的话要原样留下的：@ 引用、开头的 / 命令、镜头编号、引号与反引号里的内容、文件路径。 */
export function polishKeeps(text: string): string[] {
  const keeps: string[] = [];
  for (const m of text.matchAll(/(^|[\s（(，。！？、；：,.!?;:])(@[^\s@，。！？、；：,!?;:（）()]+)/g)) keeps.push(m[2]!.replace(/[.]+$/, ''));
  const command = /^\s*(\/[^\s]+)/.exec(text);
  if (command) keeps.push(command[1]!);
  for (const m of text.matchAll(/scene-\d+/g)) keeps.push(m[0]);
  keeps.push(...quoted(text), ...filePaths(text));
  return [...new Set(keeps)];
}

/** 限制要求的标记词：含这些词的句子是用户或编排写下的硬约束。 */
const restrictionWords = ['不要', '禁止', '不得', '不能', '必须', '避免', '只能', '不许', '切勿'];

/** 按中文与英文句读切句。 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** 一句话里的汉字二元组与英文词，用来粗略核对改写后还在不在。 */
function grams(text: string): Set<string> {
  const out = new Set<string>();
  const han = text.replace(/[^一-鿿]/g, '');
  for (let i = 0; i + 1 < han.length; i++) out.add(han.slice(i, i + 2));
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) out.add(m[0].toLowerCase());
  return out;
}

/** 限制句：含限制词的句子。 */
export function restrictions(text: string): string[] {
  return sentences(text).filter((s) => restrictionWords.some((w) => s.includes(w)));
}

/** 限制词之后的那部分：被限制的对象，核对时只看它。 */
function restrictionTarget(sentence: string): string {
  let first = sentence.length;
  for (const w of restrictionWords) {
    const i = sentence.indexOf(w);
    if (i >= 0 && i < first) first = i;
  }
  return sentence.slice(first);
}

/** 限制句的对象在改写里还剩多少：被限制对象的二元组至少一半要在新稿里出现。 */
function restrictionKept(sentence: string, result: string): boolean {
  const target = grams(restrictionTarget(sentence));
  if (target.size === 0) return true;
  const have = grams(result);
  let hit = 0;
  for (const g of target) if (have.has(g)) hit++;
  return hit * 2 >= target.size;
}

/** 镜头画面描述要原样留下的：引号与反引号里的内容、文件路径。限制句另由 missingRestrictions 核对。 */
export function sceneKeeps(text: string): string[] {
  return [...new Set([...quoted(text), ...filePaths(text)])];
}

/** keeps 里在 result 里找不到的。 */
export function missing(keeps: readonly string[], result: string): string[] {
  return keeps.filter((k) => !result.includes(k));
}

/** 原稿的限制句里，对象在新稿里大半找不到的那几句。 */
export function missingRestrictions(original: string, result: string): string[] {
  return restrictions(original).filter((s) => !restrictionKept(s, result));
}

/** 新稿里出现、原稿里没有的文件路径：模型编造的素材。 */
export function inventedPaths(original: string, result: string): string[] {
  const before = new Set(filePaths(original));
  return filePaths(result).filter((p) => !before.has(p));
}
