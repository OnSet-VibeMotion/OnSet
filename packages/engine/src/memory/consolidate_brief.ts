import { compareBytes } from '../gojson';
import { type Cluster, ClusterKeyHuman, type Contrast } from './consolidate_cluster';
import { featureDescriptions, knownCheckers } from './features';
import { appliesScoped, type Kind, KindPreference, type Memory, StatusActive, StatusTrial } from './memory';
import { lessonWritingGuide } from './writing';

export function kindLabel(kind: Kind): string {
  return kind === KindPreference ? '偏好' : '经验';
}

/**
 * 改稿说明：列出每份被拒草稿与原因，要求整理者原地改这几份。
 */
export function revisionBrief(rejected: Record<string, string[]>): string {
  let b = '# 改稿：下面的草稿没有通过格式校验\n\n';
  b += '只改 drafts/ 下列出的这几份文件，原地改、文件名不变；其他文件不要动，不要新增草稿。\n';
  b += '格式与硬性要求见当前目录的 brief.md。超长的删掉次要的话、保留约束本身与反例正例；改完即结束。\n\n';
  for (const label of Object.keys(rejected).sort(compareBytes)) {
    b += `## drafts/${label}\n\n`;
    for (const problem of rejected[label]) b += `- ${problem}\n`;
    b += '\n';
  }
  return b;
}

/** 交给整理者的说明。 */
export function consolidationBrief(clusters: readonly Cluster[], existing: readonly Memory[] | null): string {
  let b = `# 整理渲染经验

你要把下面几组反复出现的渲染失败，提炼成可检验的经验，或修订已经被召回却仍然失败的旧经验。
这些经验会在以后每个镜头开工前按镜头特征召回，注入给负责渲染的 AI。记忆库由多种渲染工具与模型共用，
不同模型犯的错并不一样：通病写成通用经验，某个模型特有的毛病限定范围。

只在当前目录的 drafts/ 下写文件：经验写进 drafts/lessons/<name>.md，人工反馈里的审美取向写进 drafts/preferences/<name>.md。
不要改动其他任何文件，不要渲染，不要运行其他命令。写完即结束。

## 文件格式

\`\`\`markdown
---
name: font-local-block
description: 中文字体用镜头目录内的本地文件，font-display 写 block，否则会静默回退
status: trial
applies_when:
  features: [cjk_text]
  keywords: [字体, font]
  # 只对某些渲染工具或模型成立时才写，下面两项都可省略：
  # renderers: [codex]
  # models: [gpt-6]
checked_by: [determinism.font-display, determinism.remote-font]
from_episodes: [ep-20261102-101500-a1b2c3]
---

中文字体必须用镜头目录内的本地文件，通过 @font-face 引入，font-display 写 block。

反例：
    @import url('https://fonts.googleapis.com/...');

正例：
    @font-face { font-family: 'X'; src: url('./fonts/x.woff2'); font-display: block; }
\`\`\`

## 硬性要求（不满足的草稿会被直接拒收）

- name 用小写字母、数字与连字符，与文件名一致，不得与已有记忆重名。
- 经验必须写成一条可检验的约束，正文同时给出「反例」与「正例」代码片段，正文不超过 600 字，description 不超过 80 字。
- checked_by 优先用能在单镜头里判定的校验器（output.*、determinism.*、frames.blank、reads.*）：只由
  review.handoff 判定的经验要看相邻镜头，考试考不了，只能等人确认。
- checked_by 只能取下面「校验器」里的 ID，写明这条经验由哪个校验器判定；偏好的 checked_by 写 [human]。
- applies_when.features 只能取下面「镜头特征」里的值；适用于所有镜头时省略 applies_when。
- from_episodes 列出这条经验来自哪些经历编号，只能取下面各组里出现的编号。
- 正文、description 与 keywords 里不得出现渲染工具名、模型名或厂商名。
- 先看每组的「渲染工具/模型分布」判断范围：几种渲染工具或模型都出现的是通病，不写范围；
  集中在某个渲染工具或模型上的，用 applies_when.renderers（渲染工具 ID）或 applies_when.models
  （模型名，按前缀匹配，如 gpt-6 匹配 gpt-6-astra）限定，只对它们召回。只有一个样本时不要凭它下结论说是通病。
- 不得包含具体镜头的文案、镜头编号或素材文件名：经验要能迁移到别的文章。
- 已有记忆说的是同一件事时，写成修订：换一个新名字，加 revises: <旧名>，正文写完整的新版本。不要并列新增。
  修订必须保留旧版的全部 checked_by，正文不得短于旧版的一半：只改错的地方、补漏掉的情况，
  不要为了简洁删掉旧版里仍然成立的细节、数值和反例正例。
- 每个镜头最多注入 3 条经验：宁可一条写准，不要拆成几条泛泛的。
- 只为确有共性的失败写经验；拿不准的组宁可不写。
- 有「成败对照」的组，先读 contrasts/ 下通过那一版的合成代码，找与本组问题相关的可执行做法。
  经验写成「通过的那一边是怎么做的」，正例尽量取自通过的写法，不要只是把报错改写成禁令。
  对照可能没运行本组的事后检查，不能把「未发现失败」当成「已验证修复」。
- 「用户的反应」一组写成偏好：从回退、反复提的要求与 👍 / 👎 里归纳用户长期的取向（节奏、配色、
  信息密度、语气……），不是复述某一次的修改要求。只在一个项目里出现的写 scope: <项目名>，
  仅属于某一专栏的写 scope: series:<专栏ID>，多个无关项目都出现的才省略 scope（全局）。
  修订已有偏好时，默认沿用已有记忆里列出的原 scope；只有用户明确要求扩大到全局时才省略 scope。
  偏好要用户确认后才生效，宁可少写。

`;
  b += lessonWritingGuide();
  b += '## 镜头特征\n\n';
  const features = featureDescriptions();
  for (const name of Object.keys(features).sort(compareBytes)) b += `- \`${name}\`：${features[name]}\n`;
  b += '- `handoff:<手法>`：交接用了某种手法（carry、match、push_in、flood、pan、settle）\n\n## 校验器\n\n';
  for (const id of knownCheckers()) b += `- \`${id}\`\n`;
  b += '\n## 已有记忆\n\n';
  let count = 0;
  for (const m of existing ?? []) {
    if (m.status !== StatusActive && m.status !== StatusTrial) continue;
    count++;
    const scope = appliesScoped(m.applies_when)
      ? [...m.applies_when.renderers, ...m.applies_when.models].join(', ')
      : '不限';
    const prefScope = m.kind === KindPreference ? `；scope: ${m.scope || '全局'}` : '';
    b +=
      `### ${m.name}（${kindLabel(m.kind)}，${m.status}）\n\n${m.description}\n\n` +
      `checked_by: ${(m.checked_by ?? []).join(', ')}；features: ${m.applies_when.features.join(', ')}；渲染工具/模型：${scope}${prefScope}\n\n${m.body}\n\n`;
  }
  if (count === 0) b += '（暂无）\n\n';
  b += '## 高频失败\n\n';
  for (const c of clusters) {
    const title = c.key === ClusterKeyHuman ? '用户的反应（回退、反复提的要求、👍 / 👎）' : '校验器 `' + c.key + '`';
    b += `### ${title}：${c.count} 次\n\n`;
    b += `- 经历：${(c.episodes ?? []).join(', ')}\n`;
    if (Object.keys(c.models).length > 0) b += `- 渲染工具/模型分布：${distribution(c.models)}\n`;
    if ((c.features?.length ?? 0) > 0) b += `- 共同特征：${c.features!.join(', ')}\n`;
    if ((c.recalled?.length ?? 0) > 0) b += `- 失败时已召回的记忆（没帮上忙，考虑修订）：${c.recalled!.join(', ')}\n`;
    for (const example of c.examples ?? []) b += `- 报错示例：${example}\n`;
    for (const note of c.notes ?? []) b += `- ${note}\n`;
    for (const pair of c.contrasts ?? []) b += contrastLine(pair);
    b += '\n';
  }
  return b;
}

export function contrastLine(pair: Contrast): string {
  const kind = pair.same_scene ? '同一个镜头后来通过了' : '特征相近的另一个镜头通过了';
  let line = `- 成败对照（${kind}）：失败 ${pair.failed}，通过 ${pair.passed}`;
  if (pair.passed_code !== '') line += '；通过那一版的合成代码拷在当前目录的 ' + pair.passed_code + '/';
  else line += '；通过那一版的代码已被后来的渲染覆盖，只能对照报错与特征';
  if ((pair.shared_features?.length ?? 0) > 0) line += '；共同特征 ' + pair.shared_features!.join(', ');
  line += '；通过指渲染及已有检查未报错，不代表本组事后校验器已运行，也不证明画面更好';
  return line + '\n';
}

/** 把计数写成「a × 3、b × 1」，按次数降序。 */
export function distribution(counts: Record<string, number>): string {
  const keys = Object.keys(counts).sort((a, b) =>
    counts[a] !== counts[b] ? counts[b] - counts[a] : compareBytes(a, b),
  );
  return keys.map((key) => `${key} × ${counts[key]}`).join('、');
}
