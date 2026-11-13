// 移植自 internal/project/runprompt.go。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { files } from '../assets';
import * as flow from '../flow';
import * as preset from '../preset';
import { substituteCanvas } from '../preset/gen/gen';
import * as song from '../song';

/** songContract 是歌曲模式追加在提示词末尾的内置契约（相对 assets/）。 */
const songContract = 'shared/PROMPT-SONG.md';

/** ProductionPrompt 是从文章开始完整制作的提示词文件名。 */
export const ProductionPrompt = 'PROMPT-PRODUCTION.md';

export interface RunPromptResult {
  prompt: Buffer;
  /** 实际读取的路径，供打印给人看。按流程组合时是那份可选的制作说明文件（不一定存在）。 */
  path: string;
  /** 按流程在运行期组合的（有流程记录、制作说明没改过）。 */
  composed?: boolean;
}

/** 有流程记录的项目，它那份可选的制作说明文件（歌曲讲解是 PROMPT-SONG.md，其余 PROMPT-PRODUCTION.md）。 */
export function flowPromptFile(root: string, rec: flow.FlowRecord): string {
  return path.join(root, rec.id === 'song' ? 'PROMPT-SONG.md' : ProductionPrompt);
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 有流程记录的项目的制作说明从哪来：
 *
 * - composed：运行期按流程组合（项目里那份制作说明不存在，或与新建时的摘要相同）；
 * - custom：项目里那份文件改过，以文件为准（老路径），界面提示「这个项目用的是自己改过的制作说明」；
 * - legacy：没有流程记录（老项目）、组合版本不认识、或口播项目已有定稿 transcription.srt（照旧读 PROMPT.md）。
 */
export function promptSource(root: string): 'composed' | 'custom' | 'legacy' {
  const rec = flow.flowRecord(root);
  if (!rec || rec.compose !== flow.ComposeVersion || !preset.byID(rec.canvas)) return 'legacy';
  if (rec.id !== 'song' && exists(path.join(root, 'transcription.srt'))) return 'legacy';
  const file = flowPromptFile(root, rec);
  if (exists(file) && sha256(file) !== rec.prompt_sha256) return 'custom';
  return 'composed';
}

/** 按流程组合（promptSource 为 composed 时）。 */
function composedPrompt(root: string, rec: flow.FlowRecord): RunPromptResult {
  if (rec.id === 'song') song.loadConfig(root);
  const extras = flow.loadProjectStations(root);
  if (extras.problems.length > 0) throw new Error(extras.problems.join('\n'));
  const p = preset.byID(rec.canvas)!;
  const id = flow.detectFlow(root, flow.projectExtras(root));
  const text = flow.composeFlowPrompt({ flow: id, stations: extras.stations, disabled: new Set(flow.disabledPluginStations(root)), canvas: (t) => substituteCanvas(p, t) });
  return { prompt: Buffer.from(text), path: flowPromptFile(root, rec), composed: true };
}

/**
 * runPrompt 读出整片制作发给编排工具的提示词，am run 与 am studio 共用。
 *
 * 新建时记了流程的项目（锁文件的 production），没有 override、制作说明没改过时按流程在运行期组合
 * （promptSource、flow.composeFlowPrompt）。其余情况走下面的兼容路径（legacyRunPrompt），与记流程之前逐字节相同。
 */
export function runPrompt(root: string, override: string): RunPromptResult {
  if (override === '' && promptSource(root) === 'composed') return composedPrompt(root, flow.flowRecord(root)!);
  return legacyRunPrompt(root, override);
}

/**
 * 兼容路径：读项目里的提示词文件，再按插件标记、阶段标题与末尾追加修补。没有流程记录的老项目、用户改过的制作说明、
 * override 与已有定稿字幕的口播项目走这里。
 *
 * override 非空时直接读它；否则口播项目读项目根的 PROMPT.md，歌曲模式读
 * PROMPT-SONG.md，并在末尾追加随二进制下发的歌曲契约——项目里那份可能被
 * 用户改过，契约要以内置版本为准。返回实际读取的路径，供打印给人看。
 *
 * PROMPT.md 假定项目里已有定稿 transcription.srt。还没有它、而项目里有
 * PROMPT-PRODUCTION.md 时，读后者从文章或口播稿开始完整制作：新建的项目只有
 * 文章，Studio 的「开始制作」与不带参数的 am run 照 PROMPT.md 走会卡在第一步。
 *
 * 项目加了第三方站（flow.LockFile）时，各站的说明接在最后（flow.extraPrompt）。
 */
export function legacyRunPrompt(root: string, override: string): RunPromptResult {
  let file = path.join(root, 'PROMPT.md');
  const songMode = song.enabled(root);
  if (songMode) {
    song.loadConfig(root);
    file = path.join(root, 'PROMPT-SONG.md');
  } else if (!exists(path.join(root, 'transcription.srt')) && exists(path.join(root, ProductionPrompt))) {
    file = path.join(root, ProductionPrompt);
  }
  if (override !== '') file = path.resolve(override);
  let prompt: Buffer;
  try {
    prompt = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`找不到 prompt 文件：${file}`, { cause: err });
  }
  if (songMode) {
    const contract = files().readFile(songContract);
    prompt = Buffer.concat([prompt, Buffer.from('\n\n歌曲模式必要契约（优先于口播规程）：\n'), contract]);
  }
  // 项目加的第三方站各自带一节说明，接在最后。读不出来的站直接报错：用户加了它，悄悄少一步更糟。
  const extras = flow.loadProjectStations(root);
  if (extras.problems.length > 0) throw new Error(extras.problems.join('\n'));
  // 制作提示词里内置插件认领的段落带着标记：关掉的插件整段去掉，其余只去掉标记。
  let disabledBuiltins: Set<string>;
  try {
    disabledBuiltins = new Set(flow.readLock(root).disabled ?? []);
  } catch {
    disabledBuiltins = new Set();
  }
  prompt = Buffer.from(flow.applyPluginMarkers(prompt.toString('utf8'), disabledBuiltins));
  // 选用了第三方站的流程：am 的公共约定（第一个「## 第…阶段」之前的部分）照旧在前，各阶段换成那套流程的。
  const flowStation = flow.activeFlowStation(root, extras.stations);
  if (flowStation && override === '' && !songMode) {
    const text = prompt.toString('utf8');
    const cut = text.search(/^## 第[一二三四五六七八九十]+阶段/m);
    const preamble = cut < 0 ? '' : text.slice(0, cut);
    const body = fs.readFileSync(path.join(flowStation.dir, flowStation.manifest.flow!.prompt), 'utf8').trim();
    prompt = Buffer.from(
      preamble +
        `## 这部片子的流程：${flowStation.manifest.flow!.name}\n\n以下流程由用户选用的第三方插件「${flowStation.manifest.name}」（${flowStation.manifest.id} ${flowStation.manifest.version}）提供；与上面的约定冲突时以上面为准。\n\n${body}\n`,
    );
  }
  if (extras.stations.some((s) => s.manifest.inserts.length > 0)) prompt = Buffer.from(flow.insertStageSections(prompt.toString('utf8'), extras.stations));
  // 内置插件的说明本来是制作提示词（PROMPT-PRODUCTION.md）的一节，只接在它后面；第三方站的说明哪份提示词都接。
  const isProduction = override === '' && !songMode && path.basename(file) === ProductionPrompt;
  const extra = flow.extraPrompt(
    extras.stations.filter((st) => !st.builtin || isProduction),
    prompt.toString('utf8'),
  );
  // 末尾只留一个空行再接：提示词文件本身以换行结尾。
  if (extra !== '') prompt = Buffer.from(prompt.toString('utf8').replace(/\n*$/, '\n\n') + extra + '\n');
  return { prompt, path: file };
}

function exists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}
