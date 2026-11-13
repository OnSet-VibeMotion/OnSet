/**
 * 按流程组合制作提示词：段落按流程的顺序拼起来，`{{STAGE:…}}` 按这个流程自己的阶段先后编号。
 * 这是制作提示词唯一的来源（project.runPrompt 经 composeFlowPrompt），项目里不放提示词文件。组合时：
 *
 * - 内置插件的站按流程声明的段落顺序参与（流程里没有它的段落就不出现），阶段编号按出现先后连续；
 * - 第三方站的 inserts 作为段落插在那个阶段的末尾（找不到这个阶段时接在最后并注明），prompt 接在最后；
 * - 第三方站带来的流程（x:<站>）：公共约定（口播流程第一个阶段之前的那几段）在前，stations 里写的内置站复用内置站的段落，
 *   本站自己那一节是它清单里的 flow.prompt。内置站的段落引用了这个流程没有的阶段时写成「<标题>」那一步
 *   （内置流程不许这样：引用了没有的阶段直接报错）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LoadedStation } from './lock';
import { extraPrompt, insertBlock, orphanBlock } from './promptparts';
import { allFlows, allStageTitles, allStations, appendedSections, flowPrompt, pluginSectionFile, sectionsDir } from './registered';
import type { FlowID } from './types';

const numerals = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 1–99 的中文数字：十、十一、二十三。 */
export function chineseNumber(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error(`阶段编号超出范围：${n}`);
  if (n < 10) return numerals[n];
  const tens = Math.floor(n / 10);
  return (tens === 1 ? '' : numerals[tens]) + '十' + numerals[n % 10];
}

/** 组合时的一段。 */
export interface PromptPart {
  /** 「站/段」；第三方站的文字为空。 */
  ref: string;
  text: string;
  /** 这一段开启的阶段。 */
  stage?: string;
  /** 第三方站的文字：不换阶段占位符。 */
  raw?: boolean;
  /** 接在最后的一段：与前文空一行，正文去掉首尾空白，以换行结尾。 */
  append?: boolean;
  /** 插进某个阶段末尾的一段：与前文空一行；后面接着别的段落时再空一行。 */
  insert?: boolean;
}

export interface ComposeOptions {
  /** 引用了这个流程没有的阶段时改指的阶段。 */
  aliases?: Readonly<Record<string, string>>;
  /** 仍然找不到时的写法；不给或返回 undefined 就报错。 */
  missing?: (stage: string) => string | undefined;
}

const stageRef = /\{\{STAGE(_N)?:([a-z][a-z0-9-]*)\}\}/g;

/** 把几段拼起来并给阶段编号。阶段名重复、引用了没有的阶段，一律报错。 */
export function composeParts(parts: readonly PromptPart[], opts: ComposeOptions = {}): string {
  const stages = new Map<string, number>();
  for (const p of parts) {
    if (!p.stage || p.raw) continue;
    if (stages.has(p.stage)) throw new Error(`阶段 ${p.stage} 出现了两次`);
    stages.set(p.stage, stages.size + 1);
  }
  const missing: string[] = [];
  const substitute = (text: string) =>
    text.replace(stageRef, (match: string, numberOnly: string | undefined, name: string) => {
      let n = stages.get(name);
      if (n === undefined && opts.aliases?.[name] !== undefined) n = stages.get(opts.aliases[name]);
      if (n === undefined) {
        const alt = opts.missing?.(name);
        if (alt !== undefined) return alt;
        missing.push(match);
        return match;
      }
      return numberOnly ? chineseNumber(n) : `第${chineseNumber(n)}阶段`;
    });
  let out = '';
  let afterInsert = false;
  for (const p of parts) {
    const text = p.raw ? p.text : substitute(p.text);
    if (p.append) out = out.replace(/\n*$/, '\n\n') + text.trim() + '\n';
    else if (p.insert) out = out.replace(/\n*$/, '\n\n') + text.trimEnd() + '\n';
    else out += (afterInsert ? '\n' : '') + text;
    afterInsert = !!p.insert;
  }
  if (missing.length > 0) throw new Error(`提示词引用了没有的阶段：${missing.join(' ')}`);
  return out;
}

/** 读一段提示词正文：`站/段` → 文本。 */
export type SectionReader = (station: string, section: string) => string;

/** 段落声明：「站/段」→ 开启的阶段。没有这一段直接报错。 */
function declared(ref: string): { station: string; section: string; stage?: string } {
  const slash = ref.indexOf('/');
  const station = ref.slice(0, slash);
  const sec = slash < 0 ? undefined : allStations().find((s) => s.id === station)?.prompt.find((x) => x.id === ref.slice(slash + 1));
  if (!sec) throw new Error(`没有这段提示词：${ref}`);
  return { station, section: sec.id, stage: sec.stage };
}

/** 宿主段落读 assets/prompts，内置插件的读它目录里的文件。 */
export function readSection(station: string, section: string): string {
  return fs.readFileSync(pluginSectionFile(station, section) ?? path.join(sectionsDir(), station, section + '.md'), 'utf8');
}

/**
 * 按段落顺序拼出制作提示词，并把 `{{STAGE:…}}` / `{{STAGE_N:…}}` 换成阶段编号。
 * 段落不存在、阶段名重复、引用了没有的阶段，一律报错。
 */
export function composePrompt(order: readonly string[], read: SectionReader, opts: ComposeOptions = {}): string {
  return composeParts(
    order.map((ref) => {
      const d = declared(ref);
      return { ref, text: read(d.station, d.section), stage: d.stage };
    }),
    opts,
  );
}

export interface FlowComposeInput {
  flow: FlowID;
  /** 项目加的站（loadProjectStations：内置插件与第三方站）。 */
  stations: readonly LoadedStation[];
  /** 宿主与内置插件段落的画幅占位符替换（第三方站的文字不经过它）。 */
  canvas: (text: string) => string;
  read?: SectionReader;
}

/** 第三方流程里一个内置站的段落：取路线里有这个站的第一个内置流程，按那个流程的提示词顺序。 */
function stationSections(sid: string): string[] {
  const flows = allFlows().filter((f) => f.prompt);
  const home = flows.find((f) => f.stations.includes(sid)) ?? flows.find((f) => flowPrompt(f.id).some((r) => r.startsWith(sid + '/')));
  return home ? flowPrompt(home.id).filter((r) => r.startsWith(sid + '/')) : [];
}

/** 公共约定：口播流程里第一个开阶段的段落之前的那几段（工作边界、工具写法、渲染器配置）。第三方流程照样带上。 */
function preambleSections(): string[] {
  const refs = flowPrompt('speech');
  const first = refs.findIndex((ref) => declared(ref).stage !== undefined);
  return first < 0 ? [] : refs.slice(0, first);
}

/** 运行期按流程组合项目的制作提示词（不含画幅以外的任何项目文件）。 */
export function composeFlowPrompt(input: FlowComposeInput): string {
  const read = input.read ?? readSection;
  const parts: PromptPart[] = [];
  const opts: ComposeOptions = {};
  const builtinPart = (ref: string): PromptPart => {
    const d = declared(ref);
    return { ref, text: input.canvas(read(d.station, d.section)), stage: d.stage };
  };
  let appended: string[];
  if (input.flow.startsWith('x:')) {
    const id = input.flow.slice(2);
    const own = input.stations.find((s) => s.manifest.id === id && s.manifest.flow);
    if (!own) throw new Error(`这个项目选用的流程 ${input.flow} 读不到`);
    const def = own.manifest.flow!;
    const preamble = preambleSections();
    for (const ref of preamble) parts.push(builtinPart(ref));
    for (const sid of def.stations) {
      if (sid === id) {
        const body = fs.readFileSync(path.join(own.dir, def.prompt), 'utf8').trim();
        parts.push({
          ref: '',
          raw: true,
          text: `## 这部片子的流程：${def.name}\n\n以下流程由用户选用的第三方插件「${own.manifest.name}」（${own.manifest.id} ${own.manifest.version}）提供；与上面的约定冲突时以上面为准。\n\n${body}\n`,
        });
        continue;
      }
      for (const ref of stationSections(sid)) if (!preamble.includes(ref)) parts.push(builtinPart(ref));
    }
    const titles = allStageTitles();
    opts.missing = (stage) => `「${titles[stage] ?? stage}」那一步`;
    appended = [];
  } else {
    const def = allFlows().find((f) => f.id === input.flow);
    if (!def?.prompt) throw new Error(`没有这个流程：${input.flow}`);
    if (def.stage_aliases) opts.aliases = def.stage_aliases;
    appended = appendedSections(input.flow);
    for (const ref of flowPrompt(input.flow)) {
      if (appended.includes(ref)) continue;
      parts.push(builtinPart(ref));
    }
  }
  // 第三方站的阶段补充：插在那个阶段的末尾（下一个「## 」开头的段落之前）。
  const orphans: string[] = [];
  const titles = allStageTitles();
  for (const s of input.stations) {
    if (s.builtin) continue;
    for (const ins of s.manifest.inserts) {
      const body = fs.readFileSync(path.join(s.dir, ins.file), 'utf8').trim();
      const start = parts.findIndex((p) => !p.raw && p.stage === ins.stage);
      if (start < 0) {
        orphans.push(orphanBlock(s, titles[ins.stage], body));
        continue;
      }
      let end = start + 1;
      while (end < parts.length && !parts[end].text.startsWith('## ')) end++;
      parts.splice(end, 0, { ref: '', raw: true, insert: true, text: insertBlock(s, body) });
    }
  }
  if (orphans.length > 0) parts.push({ ref: '', raw: true, append: true, text: orphans.join('\n\n') });
  for (const ref of appended) parts.push({ ...builtinPart(ref), append: true });
  // 第三方站各自的说明接在最后。
  const extra = extraPrompt(input.stations.filter((s) => !s.builtin));
  if (extra !== '') parts.push({ ref: '', raw: true, append: true, text: extra });
  return composeParts(parts, opts);
}
