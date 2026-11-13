// 移植自 internal/project/runprompt.go。
import fs from 'node:fs';
import path from 'node:path';
import { files } from '../assets';
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
