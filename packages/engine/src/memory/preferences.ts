import crypto from 'node:crypto';
import { goTrimSpace } from '../gofmt';
import { CheckerHuman } from './features';
import { EventRemember, EventTrial } from './events';
import { compactStamp, rfc3339 } from './gostr';
import { lint, MaxDescriptionChars } from './lint';
import { KindPreference, newApplies, newMemory, StatusActive, StatusDormant, StatusTrial, type Memory } from './memory';
import { setStatus } from './exam';
import { snapshotMemories, type Snapshot } from './snapshot';
import type { Store } from './store';

/**
 * 交给编排工具的「用户偏好」段，以及它的摘要。
 *
 * 经验只注入渲染提示词，偏好还要给编排工具：用户随口一句「来个科普的」，
 * 是编排工具在理解、在决定分镜和风格，渲染器只拿到已经展开的镜头说明。
 * 段落里总带着「怎样记下新偏好」，记忆库是空的时候也一样——第一条偏好就是这样来的。
 */
export function preferenceBrief(s: Store, project: string, pinned: number): { text: string; digest: string } {
  const prefs: Memory[] = [];
  const snapshot = s.resolveSnapshot(pinned);
  if (snapshot !== null) {
    for (const m of snapshotMemories(snapshot)) {
      if (m.kind === KindPreference && (m.scope === '' || m.scope === project)) prefs.push(m);
    }
  }
  let b = '用户偏好（来自 onset 记忆库：用户以往亲口说过、或在反馈里表达过的长期取向）：\n';
  if (prefs.length === 0) b += '（还没有记下任何偏好）\n';
  for (const m of prefs) {
    const scope = m.scope !== '' ? '本项目' : '全局';
    b += `- 【${m.name}】（${scope}）${m.description}\n`;
    const body = goTrimSpace(m.body);
    if (body !== '' && body !== m.description) {
      for (const line of body.split('\n')) b += '  ' + line + '\n';
    }
  }
  const pending: Memory[] = [];
  let all: Memory[] = [];
  try {
    all = s.memories().memories;
  } catch {
    all = [];
  }
  for (const m of all) {
    if (m.kind === KindPreference && m.status === StatusTrial && (m.scope === '' || m.scope === project)) pending.push(m);
  }
  if (pending.length > 0) {
    b += '\n待确认的偏好（从用户以往的回退、反复提的要求和 👍 / 👎 里归纳的，或从对话里推测的，还没生效）：\n';
    for (const m of pending) b += `- 【${m.name}】${m.description}\n`;
    b += '找合适的时机用一句话问用户认不认可；认可就调用 `memory_promote({"name": "<名字>"})`，不认可调用 `memory_reject({"name": "<名字>"})`。不要一次问完，也不要打断正在做的事。\n\n';
  }
  b += `用户这次的话说得简短或含糊时，先按这些偏好补全意图再动手；这次明说的要求与偏好冲突时以这次为准，并问一句要不要更新偏好。

记住新偏好：用户表达了以后也适用的取向（如「以后都…」「我不喜欢…」「默认用…」「每次都要…」）时，当场调用
  memory_remember({"text": "<完整说明>", "name": "<小写英文短名>", "description": "<一句话概括>"})
只对这个项目成立时照此写；对用户所有项目都成立时加 "global": true；替换一条旧偏好时加 "revises": "<旧名>"。
用户没有明说、是你从他的话或反复修改里推测出来的取向，加 "inferred": true：它先进入试用，下次由你找时机问用户，认可后才生效。
用户收回一条偏好时调用 memory_retire({"name": "<名字>"})。只记长期取向，不记这一次的具体修改要求。
`;
  return { text: b, digest: crypto.createHash('sha256').update(b, 'utf8').digest('hex') };
}

/** 一条当场记下的偏好。 */
export interface RememberInput {
  name?: string;
  description?: string;
  body: string;
  /** 偏好所属的项目名；global 为 true 时忽略。 */
  project?: string;
  global?: boolean;
  revises?: string;
  /**
   * 这条偏好是编排工具从用户的话里推测的，用户没有明说。
   * 推测的偏好进入试用，等用户确认后才生效。
   */
  inferred?: boolean;
}

/**
 * 直接把用户亲口说的偏好记为生效并生成快照。
 *
 * 经人工 👎 整理出来的偏好要人确认才生效；这里不用——用户自己说出来的就是确认。
 * 编排工具推测出来的（inferred）不一样：没经确认就写进记忆的内容会被照着做、
 * 错了还会被放大（Xiong et al. 2025 的「经验跟随」），所以它进入试用，
 * 偏好段会让编排工具找时机问用户，确认了才生效。推测的偏好不生成快照，snapshot 为 null。
 */
export function remember(s: Store, input: RememberInput): { memory: Memory; snapshot: Snapshot | null } {
  const body = goTrimSpace(input.body);
  if (body === '') throw new Error('偏好内容为空');
  const project = input.project ?? '';
  const revises = input.revises ?? '';
  if (!input.global && project === '') throw new Error('当前目录不在项目里；对所有项目都成立的偏好请加 --global');
  const name = input.name || 'pref-' + compactStamp(s.clock());
  let description = goTrimSpace(input.description ?? '');
  if (description === '') description = firstSentence(body);
  const m = newMemory({
    kind: KindPreference,
    body,
    name,
    description,
    status: input.inferred ? StatusTrial : StatusActive,
    applies_when: newApplies(),
    checked_by: [CheckerHuman],
    revises,
  });
  if (!input.global) m.scope = project;
  const existing = s.memories().memories;
  for (const other of existing) {
    if (other.name === name) throw new Error(`记忆 ${name} 已存在；替换它请换个名字并加 --revises ${name}`);
  }
  const problems = lint(m, { existing });
  if (problems.length > 0) throw new Error(`偏好不合格：\n  - ${problems.join('\n  - ')}`);
  s.write(m);
  if (input.inferred) {
    // 试用偏好不进召回，不需要快照；被修订的旧偏好等它确认生效时才沉睡。
    const summary = `推测的偏好 ${name} 进入试用，待用户确认：${description}`;
    s.log({
      time: '',
      type: EventTrial,
      summary,
      detail: { memory: name, kind: m.kind, scope: m.scope, revises, inferred: true },
    });
    return { memory: m, snapshot: null };
  }
  if (revises !== '') {
    const old = s.find(revises);
    if (old !== null && old.status === StatusActive) setStatus(s, old, StatusDormant, '', '');
  }
  const summary = `记住偏好 ${name}：${description}`;
  const snapshot = s.takeSnapshot(EventRemember, summary, false);
  s.log({
    time: '',
    type: EventRemember,
    snapshot: snapshot.id,
    summary,
    detail: { memory: name, scope: m.scope, revises, at: rfc3339(new Date()) },
  });
  return { memory: m, snapshot };
}

function firstSentence(text: string): string {
  let line = goTrimSpace(text.split('\n')[0]);
  const i = line.search(/[。！？!?]/);
  if (i > 0) line = line.slice(0, i);
  const runes = [...line];
  if (runes.length > MaxDescriptionChars) line = runes.slice(0, MaxDescriptionChars - 1).join('') + '…';
  return line;
}
