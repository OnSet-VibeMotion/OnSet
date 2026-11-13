import { goTrimSpace } from '../gofmt';
import { newScene } from '../scene';
import { newEpisode, OutcomeFeedback, saveEpisode, SourceConversation, SourceFeedback, type Episode } from './episode';
import { goToLower, isDigit, isLetter } from './gostr';
import type { Store } from './store';

/** 对话里的一句话。 */
export interface Utterance {
  projectDir: string;
  session: string;
  turn: string;
  message: string;
  /** true 表示用户回退了这一轮的改动。 */
  reverted?: boolean;
}

/**
 * 把对话里用户的一句话（或一次回退）写成经历。
 * 同一轮只记一次说话、一次回退。
 */
export function recordUtterance(s: Store, u: Utterance): Episode {
  const message = goTrimSpace(u.message);
  if (message === '' || u.turn === '') throw new Error('对话内容或轮次为空');
  const verdict = u.reverted ? 'down' : 'said';
  for (const e of s.episodes()) {
    if (e.source === SourceConversation && e.turn === u.turn && e.feedback !== null && e.feedback.verdict === verdict) return e;
  }
  const episode = newEpisode({
    source: SourceConversation,
    text: message,
    outcome: OutcomeFeedback,
    session: u.session,
    turn: u.turn,
    feedback: { verdict, note: message, seconds: -1, region: null, element: '' },
  });
  return saveEpisode(s, newScene({ directory: u.projectDir }), episode);
}

/** 一条偏好信号：值得交给整理者看的用户反应。 */
export interface Signal {
  /** reverted | repeated | liked | disliked */
  kind: string;
  text: string;
  count: number;
  project: string;
  episodes: string[] | null;
}

export function signalToJSON(s: Signal): Record<string, unknown> {
  return { kind: s.kind, text: s.text, count: s.count, project: s.project || undefined, episodes: s.episodes };
}

// 两句话按字二元组的 Jaccard 相似度不低于它，算同一个要求换了说法。
// 或者重合的二元组占较短一句的比例不低于 repeatOverlap。
const repeatSimilarity = 0.5;
const repeatOverlap = 0.6;

/**
 * 从经历里找出偏好信号：
 *
 *   - 被回退的一轮：用户不要这样改；
 *   - 在不同轮次里反复提的同一个要求（「再慢一点」说了三次）：说明默认做法不合用户心意；
 *   - 带说明的 👍 / 👎。
 *
 * 单独一句话不算信号：用户随口的要求大多只对这一次成立。
 */
export function preferenceSignals(episodes: readonly Episode[]): Signal[] {
  const out: Signal[] = [];
  const said: Episode[] = [];
  for (const e of episodes) {
    if (e.source === SourceConversation && e.feedback !== null && e.feedback.verdict === 'down') {
      out.push({ kind: 'reverted', text: e.text, count: 1, project: e.project, episodes: [e.id] });
    } else if (e.source === SourceConversation) {
      said.push(e);
    } else if (e.source === SourceFeedback && e.feedback !== null && goTrimSpace(e.feedback.note) !== '') {
      const kind = e.feedback.verdict === 'down' ? 'disliked' : 'liked';
      out.push({ kind, text: e.feedback.note, count: 1, project: e.project, episodes: [e.id] });
    }
  }
  const used = new Array<boolean>(said.length).fill(false);
  for (let i = 0; i < said.length; i++) {
    if (used[i]) continue;
    const group = [said[i]];
    const turns = new Set([said[i].turn]);
    for (let j = i + 1; j < said.length; j++) {
      if (!used[j] && !turns.has(said[j].turn) && similar(said[i].text, said[j].text)) {
        used[j] = true;
        turns.add(said[j].turn);
        group.push(said[j]);
      }
    }
    if (group.length < 2) continue;
    out.push({ kind: 'repeated', text: said[i].text, count: group.length, project: said[i].project, episodes: group.map((e) => e.id) });
  }
  // sort.SliceStable：次数降序。
  return out
    .map((signal, index) => ({ signal, index }))
    .sort((a, b) => (a.signal.count !== b.signal.count ? b.signal.count - a.signal.count : a.index - b.index))
    .map(({ signal }) => signal);
}

function bigrams(text: string): Set<string> {
  const runes: string[] = [];
  for (const ch of goToLower(text)) {
    if (isLetter(ch) || isDigit(ch)) runes.push(ch);
  }
  const out = new Set<string>();
  if (runes.length === 1) out.add(runes[0]);
  for (let i = 0; i + 1 < runes.length; i++) out.add(runes[i] + runes[i + 1]);
  return out;
}

export function similar(a: string, b: string): boolean {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const k of x) if (y.has(k)) shared++;
  // 短要求常被换个说法再说一遍（「再慢一点」「慢一点，节奏慢一点」），只看 Jaccard
  // 会被多出来的字拉低；再看重合部分占较短一句的比例。
  const shorter = Math.min(x.size, y.size);
  return shared / (x.size + y.size - shared) >= repeatSimilarity || shared / shorter >= repeatOverlap;
}
