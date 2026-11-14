/**
 * 项目里的几样交付物有固定位置：客户端的成片页、制作路线（studio/progress.ts）与拼接按钮都按这些路径找。
 * 制作提示词写了这些路径，但提示词可以被忽略——2026-11 实测 qoder 编排把母版写成 master-silent.mp4、
 * 候选成片写成 master-mixed.mp4，复查、校验都过了，客户端却显示「没有成片」。所以在项目里（有流程记录），
 * concat 与 review 只认这些位置，写错当场报错并说该写到哪。脱离项目使用（没有流程记录）不限制。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as flow from '@onset/engine/flow';

export const SilentMaster = 'production/silent-master.mp4';
export const CandidateFilm = 'production/audio/candidate.mp4';
export const FinalFilms = ['final.mp4', 'production/final.mp4'];

/** 有流程记录的目录才算项目（新建项目时写下，见 flow.LockFile）。 */
export function inProject(root: string): boolean {
  return fs.existsSync(path.join(root, flow.LockFile));
}

/** given（相对于当前目录）是不是 allowed 里的某一个（相对于项目根）。 */
function sameAs(root: string, given: string, allowed: readonly string[]): boolean {
  const target = path.resolve(given);
  return allowed.some((rel) => path.resolve(root, rel) === target);
}

/** 拼接的母版：项目里只能写到 production/silent-master.mp4。 */
export function requireSilentMaster(root: string, out: string): void {
  if (!inProject(root) || sameAs(root, out, [SilentMaster])) return;
  throw new Error(
    `静音母版要写到 ${SilentMaster}（客户端的制作路线与成片页按这个位置找），不能写成 ${out}。请改成 concat({"scenes": "scenes/", "out": "${SilentMaster}"})`,
  );
}

/** 复查的成片：项目里有声的只认候选成片与 final.mp4，静音的只认母版。 */
export function requireReviewTarget(root: string, video: string, silent: boolean): void {
  if (!inProject(root)) return;
  if (silent) {
    if (sameAs(root, video, [SilentMaster])) return;
    throw new Error(`静音复查只查母版 ${SilentMaster}，不能查 ${video}`);
  }
  if (sameAs(root, video, [CandidateFilm, ...FinalFilms])) return;
  throw new Error(
    `混好的成片要放在 ${CandidateFilm}（试听确认后再出根目录的 final.mp4）：客户端的成片页与制作路线只认这些位置，不认 ${video}。` +
      `请把混音输出到 ${CandidateFilm}（已经混好的直接改名过去），再运行 review({"video": "${CandidateFilm}", "scenes": "scenes/", "out": "production/review"})`,
  );
}
