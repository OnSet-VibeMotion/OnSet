// 移植自 internal/align/match.go。
import { runes } from './token';

// 匹配标签。一个分组把 0–4 个终稿朗读单元与 0–4 个对齐单元配在一起，标签说明它们是什么关系。
export const LabelExact = 'exact'; // 一对一，文本相同
export const LabelSplit = 'split'; // 一个朗读单元对应多个对齐单元，拼起来文本相同
export const LabelMerge = 'merge'; // 多个朗读单元对应一个（或多个）对齐单元，拼起来文本相同
export const LabelReplace = 'replacement'; // 文本不同：读错、改写、对齐工具认错
export const LabelOmission = 'source-omission'; // 终稿有、对齐结果里没有：TTS 漏读或对齐丢了
export const LabelInsertion = 'evidence-insertion'; // 对齐结果有、终稿没有：多读了

// 代价取自 hypit speech-alignment：漏读比多读贵，分段方式不同但文本相同只收很小的代价。
const omissionCost = 0.5;
const insertionCost = 0.35;
const regroupCost = 0.055;
const maxGroup = 4;
const costEpsilon = 1e-9;
const evidenceTrust = 0.8; // hypit 在对齐工具不给置信分时用的可靠度
const boundaryCost = 0.06;
const minBandHalfWidth = 128;
const beamWidth = 15.0;

/** group 是匹配路径上的一段：朗读单元 [s0,s1) 与对齐单元 [e0,e1)。 */
export interface Group {
  s0: number;
  s1: number;
  e0: number;
  e1: number;
  label: string;
}

/**
 * band 是动态规划只计算的对角带：第 i 行只算 j ∈ [lo[i], hi[i]]。
 *
 * 整张表是 N×M，几千字的稿子要上亿个格子。朗读文本与对齐结果大体同序，偏离
 * 对角线的幅度不会超过两边长度差太多，所以只算对角带。带宽 = 长度差 + 128，
 * 足够容纳上百个单元的局部漏读或多读。
 *
 * Go 版每格是一个 cell 结构体；这里把各字段拆成平铺的类型化数组（下标 = 行偏移 + 列），
 * 几千字的稿子有上百万个格子，对象数组在 JS 里又慢又占内存。int32 字段在 Go 里也是 int32，
 * 溢出行为一致（实际不会溢出）。
 */
class Band {
  lo: Int32Array;
  hi: Int32Array;
  offset: Int32Array;
  cost: Float64Array;
  exact: Int32Array;
  omissions: Int32Array;
  insertions: Int32Array;
  complexity: Int32Array;
  prevS: Int32Array;
  prevE: Int32Array;
  ok: Uint8Array;

  constructor(n: number, m: number) {
    const half = minBandHalfWidth + Math.abs(n - m);
    this.lo = new Int32Array(n + 1);
    this.hi = new Int32Array(n + 1);
    this.offset = new Int32Array(n + 1);
    let total = 0;
    for (let i = 0; i <= n; i++) {
      // int(int64(i) * int64(m) / int64(n))：整数除法向零截断，i、m、n 都非负。
      const center = n > 0 ? Math.floor((i * m) / n) : m;
      this.lo[i] = Math.max(0, center - half);
      this.hi[i] = Math.min(m, center + half);
      this.offset[i] = total - this.lo[i];
      total += this.hi[i] - this.lo[i] + 1;
    }
    this.cost = new Float64Array(total);
    this.exact = new Int32Array(total);
    this.omissions = new Int32Array(total);
    this.insertions = new Int32Array(total);
    this.complexity = new Int32Array(total);
    this.prevS = new Int32Array(total);
    this.prevE = new Int32Array(total);
    this.ok = new Uint8Array(total);
  }

  /** 格子的下标，不在带内时返回 -1（Go 的 at 返回 nil）。 */
  at(i: number, j: number): number {
    if (j < this.lo[i] || j > this.hi[i]) return -1;
    return this.offset[i] + j;
  }
}

/**
 * better 的候选值；平局时按精确数、漏读数、多读数、分组复杂度依次决出。
 * 与 Go 的 cell 字段一一对应。
 */
interface Candidate {
  cost: number;
  exact: number;
  omissions: number;
  insertions: number;
  complexity: number;
}

function better(candidate: Candidate, b: Band, current: number): boolean {
  if (!b.ok[current]) return true;
  const cost = b.cost[current];
  if (candidate.cost < cost - costEpsilon) return true;
  if (candidate.cost > cost + costEpsilon) return false;
  if (candidate.exact !== b.exact[current]) return candidate.exact > b.exact[current];
  if (candidate.omissions !== b.omissions[current]) return candidate.omissions < b.omissions[current];
  if (candidate.insertions !== b.insertions[current]) return candidate.insertions < b.insertions[current];
  return candidate.complexity < b.complexity[current];
}

/** Go 的 len(string)：UTF-8 字节数。 */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * matchTokens 用动态规划把终稿朗读单元与对齐单元分组配对，返回整条路径。确定性：
 * 遍历顺序固定，只有严格更优才替换，平局按精确数、漏读数、多读数、分组复杂度依次决出。
 */
export function matchTokens(source: string[], evidence: string[]): Group[] {
  const n = source.length;
  const m = evidence.length;
  const b = new Band(n, m);
  const origin = b.at(0, 0);
  b.ok[origin] = 1;
  b.prevS[origin] = -1;
  b.prevE[origin] = -1;
  const [sourceBytes, sourceRunes] = prefixLengths(source);
  const [evidenceBytes, evidenceRunes] = prefixLengths(evidence);
  const sourceLen = source.map(byteLength);
  const evidenceLen = evidence.map(byteLength);

  const update = (i: number, j: number, ni: number, nj: number, cost: number, exact: number): void => {
    const target = b.at(ni, nj);
    if (target < 0) return;
    const prev = b.at(i, j);
    const sc = ni - i;
    const ec = nj - j;
    const candidate: Candidate = {
      cost: b.cost[prev] + cost,
      exact: b.exact[prev] + exact,
      omissions: b.omissions[prev],
      insertions: b.insertions[prev],
      complexity: b.complexity[prev] + Math.max(0, sc + ec - 2),
    };
    if (ec === 0) candidate.omissions += sc;
    if (sc === 0) candidate.insertions += ec;
    if (better(candidate, b, target)) {
      b.cost[target] = candidate.cost;
      b.exact[target] = candidate.exact;
      b.omissions[target] = candidate.omissions;
      b.insertions[target] = candidate.insertions;
      b.complexity[target] = candidate.complexity;
      b.prevS[target] = i;
      b.prevE[target] = j;
      b.ok[target] = 1;
    }
  };
  const pair = (i: number, j: number, sc: number, ec: number): void => {
    let exact = 0;
    if (sc === 1 && ec === 1) {
      if (source[i] === evidence[j]) exact = 1;
    } else if (source[i] === evidence[j] || source[i + sc - 1] === evidence[j + ec - 1]) {
      // 多对多分组的首或尾已经逐字相同时，它必然可以拆成「精确 + 更小的分组」。
      // 不拒绝的话，分组惩罚按单元计、编辑距离按长度归一，逐字（汉字）粒度下
      // 把精确的邻居吞进分组反而更便宜，漏读会藏进一个模糊分组里、被标成替换。
      return;
    } else if (sourceBytes[i + sc] - sourceBytes[i] !== evidenceBytes[j + ec] - evidenceBytes[j] || sourceLen[i] === evidenceLen[j]) {
      // 文本长度不同、或首单元等长却不相同（已知），就不可能是拆分或合并。
      // 先用下界剪枝，省掉大部分编辑距离计算。
      const target = b.at(i + sc, j + ec);
      if (target < 0) return;
      if (
        b.ok[target] &&
        b.cost[b.at(i, j)] + fuzzyLowerBound(sc, ec, sourceRunes[i + sc] - sourceRunes[i], evidenceRunes[j + ec] - evidenceRunes[j]) >
          b.cost[target] + costEpsilon
      ) {
        return;
      }
    }
    update(i, j, i + sc, j + ec, pairedCost(source.slice(i, i + sc), evidence.slice(j, j + ec)), exact);
  };

  // 按「拉」的方式逐格求值：先算一对一、漏读、多读这几种便宜的前驱，得到一个
  // 好的上界，模糊分组再用下界剪枝。精确的长拆分 / 长合并仍按「推」处理，
  // 它们只会推向后面的行，读取时那些格子已经收到。
  const reachable = (i: number, j: number): boolean => {
    if (i < 0 || j < 0) return false;
    const c = b.at(i, j);
    return c >= 0 && b.ok[c] === 1;
  };
  const rowBest = new Float64Array(n + 1);
  const rowSeen = new Uint8Array(n + 1);
  for (let ni = 0; ni <= n; ni++) {
    for (let nj = b.lo[ni]; nj <= b.hi[ni]; nj++) {
      if (ni > 0 || nj > 0) {
        if (reachable(ni - 1, nj - 1)) pair(ni - 1, nj - 1, 1, 1);
        if (reachable(ni - 1, nj)) update(ni - 1, nj, ni, nj, omissionCost, 0);
        if (reachable(ni, nj - 1)) update(ni, nj - 1, ni, nj, insertionCost, 0);
        // 远比上一行最优前缀差的格子不在任何合理路径上，只保留便宜前驱给出的值，
        // 不再算模糊分组。束宽 15 相当于连续四十多个多读，远超正常配音。
        const here = b.at(ni, nj);
        const far = ni > 0 && rowSeen[ni - 1] === 1 && b.ok[here] === 1 && b.cost[here] > rowBest[ni - 1] + beamWidth;
        for (let sc = 1; !far && sc <= maxGroup && sc <= ni; sc++) {
          for (let ec = 1; ec <= maxGroup && ec <= nj; ec++) {
            if ((sc > 1 || ec > 1) && reachable(ni - sc, nj - ec)) pair(ni - sc, nj - ec, sc, ec);
          }
        }
      }
      const c = b.at(ni, nj);
      if (!b.ok[c]) continue;
      if (!rowSeen[ni] || b.cost[c] < rowBest[ni]) {
        rowBest[ni] = b.cost[c];
        rowSeen[ni] = 1;
      }
      // 精确的拆分或合并不受分组上限约束：一个英文词被对齐工具拆成逐个字母时也要能整体配上。
      if (ni < n) {
        const run = exactRunLength(source[ni], evidence, nj);
        if (run > maxGroup) pair(ni, nj, 1, run);
      }
      if (nj < m) {
        const run = exactRunLength(evidence[nj], source, ni);
        if (run > maxGroup) pair(ni, nj, run, 1);
      }
    }
  }

  const groups: Group[] = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const c = b.at(i, j);
    const pi = b.prevS[c];
    const pj = b.prevE[c];
    groups.push({ s0: pi, s1: i, e0: pj, e1: j, label: labelOf(source.slice(pi, i), evidence.slice(pj, j)) });
    i = pi;
    j = pj;
  }
  groups.reverse();
  return groups;
}

/**
 * labelOf 给分组定标签。与 hypit 不同，拆分与合并要求拼起来文本相同；文本不同的
 * 多对一一律算替换，免得模糊配对拿到与精确拆分一样的置信度。
 */
function labelOf(source: string[], evidence: string[]): string {
  if (source.length === 0) return LabelInsertion;
  if (evidence.length === 0) return LabelOmission;
  if (source.join('') !== evidence.join('')) return LabelReplace;
  if (source.length === 1 && evidence.length === 1) return LabelExact;
  if (source.length === 1) return LabelSplit;
  return LabelMerge;
}

/** prefixLengths 返回字节数与字符数的前缀和，用来 O(1) 得到任一分组的文本长度。 */
function prefixLengths(values: string[]): [number[], number[]] {
  const bytes = new Array<number>(values.length + 1).fill(0);
  const counts = new Array<number>(values.length + 1).fill(0);
  values.forEach((v, i) => {
    bytes[i + 1] = bytes[i] + byteLength(v);
    counts[i + 1] = counts[i] + runes(v).length;
  });
  return [bytes, counts];
}

/**
 * fuzzyLowerBound 是文本不同的多单元分组代价的下界：编辑距离至少是长度差，
 * 未精确配上的单元至少是两侧单元数之差。
 */
function fuzzyLowerBound(sc: number, ec: number, sourceLen: number, evidenceLen: number): number {
  const width = Math.max(sourceLen, evidenceLen, 1);
  const distance = Math.abs(sourceLen - evidenceLen) / width;
  return distance * evidenceTrust * Math.max(sc, ec) + regroupCost * (sc + ec - 2) + boundaryCost * Math.abs(sc - ec);
}

/** pairedCost 是非空分组的代价：字符编辑距离按长度归一，加上分组与词边界不一致的惩罚。 */
function pairedCost(source: string[], evidence: string[]): number {
  const sourceText = source.join('');
  const evidenceText = evidence.join('');
  // 文本相同只是分段不同，代价不能随对齐工具吐出的字母个数增长。
  if (sourceText === evidenceText) {
    if (source.length === 1 && evidence.length === 1) return 0;
    return regroupCost;
  }
  const sr = runes(sourceText);
  const er = runes(evidenceText);
  const width = Math.max(sr.length, er.length, 1);
  const distance = editDistance(sr, er) / width;
  // 一对一的替换不加词边界惩罚：汉字逐字成单元，一个字读错（多音字、同音字）
  // 若代价高于「漏读 + 多读」(0.85)，就会被拆成漏读，在受保护短语里误报成问题。
  if (source.length === 1 && evidence.length === 1) return distance * evidenceTrust;
  const grouping = regroupCost * Math.max(0, source.length + evidence.length - 2);
  const exactWords = exactWordLCS(source, evidence);
  const unmatched = source.length + evidence.length - 2 * exactWords;
  // 与 hypit 不同，归一化的编辑距离再乘以较长一侧的单元数。hypit 以词为单元，
  // 归一化后的距离封顶 0.8；这里汉字逐字成单元，封顶的话「早上八点」对「天」
  // 这种四字全错的分组只要 1.3，比如实报告四个漏读（2.0）还便宜，漏读就藏进了替换。
  return distance * evidenceTrust * Math.max(source.length, evidence.length) + grouping + boundaryCost * unmatched;
}

/** exactWordLCS 只用于模糊分组，两侧都不超过 maxGroup 个单元。 */
function exactWordLCS(source: string[], evidence: string[]): number {
  const rows: number[][] = Array.from({ length: maxGroup + 1 }, () => new Array<number>(maxGroup + 1).fill(0));
  for (let i = source.length - 1; i >= 0; i--) {
    for (let j = evidence.length - 1; j >= 0; j--) {
      rows[i][j] = source[i] === evidence[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  return rows[0][0];
}

/** exactRunLength 返回从 parts[start] 起恰好拼成 target 需要几个单元，拼不成返回 0。 */
function exactRunLength(target: string, parts: string[], start: number): number {
  if (target === '') return 0;
  let joined = '';
  for (let i = start; i < parts.length; i++) {
    joined += parts[i];
    if (joined === target) return i - start + 1;
    // Go 按字节比较前缀；joined 由完整的字符串拼成，按字节是前缀与按 UTF-16 是前缀等价。
    if (joined.length >= target.length || !target.startsWith(joined)) return 0;
  }
  return 0;
}

function editDistance(left: number[], right: number[]): number {
  let previous = new Array<number>(right.length + 1);
  let current = new Array<number>(right.length + 1).fill(0);
  for (let j = 0; j <= right.length; j++) previous[j] = j;
  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      let substitute = previous[j - 1];
      if (left[i - 1] !== right[j - 1]) substitute++;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitute);
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

/** charPair 是字符级对齐里配上的一对下标。 */
export interface CharPair {
  source: number;
  evidence: number;
}

/** alignCharacters 是确定性的 Levenshtein 回溯，平局时对角线优先。 */
export function alignCharacters(source: number[], evidence: number[]): CharPair[] {
  const rows: number[][] = [];
  for (let i = 0; i <= source.length; i++) {
    rows.push(new Array<number>(evidence.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= evidence.length; j++) rows[0][j] = j;
  for (let i = 1; i <= source.length; i++) {
    for (let j = 1; j <= evidence.length; j++) {
      let substitute = rows[i - 1][j - 1];
      if (source[i - 1] !== evidence[j - 1]) substitute++;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, substitute);
    }
  }
  const pairs: CharPair[] = [];
  for (let i = source.length, j = evidence.length; i > 0 || j > 0; ) {
    if (i > 0 && j > 0) {
      let substitute = rows[i - 1][j - 1];
      if (source[i - 1] !== evidence[j - 1]) substitute++;
      if (rows[i][j] === substitute) {
        pairs.push({ source: i - 1, evidence: j - 1 });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && rows[i][j] === rows[i - 1][j] + 1) {
      i--;
      continue;
    }
    j--;
  }
  pairs.reverse();
  return pairs;
}
