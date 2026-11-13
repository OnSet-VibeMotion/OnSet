// 移植自 internal/project/runprompt.go。
import fs from 'node:fs';
import path from 'node:path';
import { files } from '../assets';
import * as flow from '../flow';
import * as song from '../song';

/** songContract 是歌曲模式追加在提示词末尾的内置契约（相对 assets/）。 */
const songContract = 'shared/PROMPT-SONG.md';

/** ProductionPrompt 是从文章开始完整制作的提示词文件名。 */
export const ProductionPrompt = 'PROMPT-PRODUCTION.md';

export interface RunPromptResult {
  prompt: Buffer;
  /** 实际读取的路径，供打印给人看。 */
  path: string;
}

/**
 * runPrompt 读出整片制作发给编排工具的提示词，am run 与 am studio 共用。
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
export function runPrompt(root: string, override: string): RunPromptResult {
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
