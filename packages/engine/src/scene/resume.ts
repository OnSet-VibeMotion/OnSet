/**
 * 渲染中途异常退出后接着做，不从头重来（scene.run 用）。
 *
 * 以前重试一律开新会话、给一样的「从头制作」提示词，只多一句「上次失败了，日志在 attempts/」：上次写好的合成代码明明还在
 * 镜头目录里，渲染器通常重写一遍；整轮被打断的（例如模型服务的证书错误，2026-11 实测）下次只能整镜重渲染。现在按代价从低到高分三层：
 *
 * 0. verify：输入指纹没变且已有视频，先验收并写记录；不启动模型、不覆盖旧日志。
 * 1. render：上一次已经到「代码已完成，开始渲染」，onset 自己跑一次 hyperframes render 再照常校验，不用模型；
 * 2. session：同一个渲染工具、记着会话号的，续接那个会话，只说一句「接着做完」——读过的技能、写到哪都还在它的上下文里；
 * 3. files：续不上的（会话过期、换了渲染工具），开新会话，提示词里加一段「接着上一次做」，列出上次留下的文件与最后几步。
 *
 * 只接「异常退出」（failed、interrupted），不接产物校验不合格（那是写错了，按原来的重试说明改）；
 * 输入变了（指纹对不上）就不接，那是真的要重做。
 */
import fs from 'node:fs';
import path from 'node:path';
import { KindText, KindToolCall, newParser } from '../agentrun';
import { attemptFileName, OutcomeFailed, OutcomeInterrupted, parseAttempt, type Attempt } from './attempt';
import type { Scene } from './scene';

/** 渲染器在写完代码、开始渲染时报的那句话（提示词「阶段性汇报规则」里的原文）。 */
export const CodeDoneMessage = '代码已完成，开始渲染';

export type ResumeLayer = 'render' | 'session' | 'files';

export interface ResumeState {
  previous: Attempt;
  /** 上一次的日志在哪个目录（镜头目录本身，或 attempts/ 下最新的那一份）。 */
  logDir: string;
  /** 上一次已经写完代码、开始渲染了。 */
  codeDone: boolean;
  /** 上一次最后几步（工具调用与说的话），给第三层的提示词用。 */
  lastSteps: string[];
}

/** 上一次的接续材料：写进第三层提示词的那一段（Scene.continuation，不进 scene.json，指纹清掉）。 */
export interface Continuation {
  reason: string;
  files: string[];
  lastSteps: string[];
  codeDone: boolean;
}

/** 镜头目录里不算「上次留下的工作」的东西：日志、归档、修接缝材料、工具状态、onset 自己写的。 */
const notWork = /^(render-.*\.(stream\.jsonl|stderr\.log|user\.log|attempt\.json|live\.json)|attempts|renders|seam|\.qoder|\.hyperframes|\.onset-render\.json|onset-scene\.js|scene\.json|prompt\.md|transcript\.srt|phrase-timeline\.json|AGENTS\.md|CLAUDE\.md)$/;

function readAttempt(file: string): Attempt | null {
  try {
    return parseAttempt(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** 最近一次尝试在哪：还在镜头目录里的那份，否则是 attempts/ 下编号最大、带尝试记录的那一份。 */
function latestAttemptDir(s: Pick<Scene, 'directory' | 'id'>): string {
  const name = attemptFileName(s.id);
  if (fs.existsSync(path.join(s.directory, name))) return s.directory;
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(s.directory, 'attempts')).filter((n) => /^attempt-\d+$/.test(n));
  } catch {
    return '';
  }
  names.sort((a, b) => Number(b.slice(8)) - Number(a.slice(8)));
  for (const n of names) {
    const dir = path.join(s.directory, 'attempts', n);
    if (fs.existsSync(path.join(dir, name))) return dir;
  }
  return '';
}

/** 从输出流里取最后几步：工具调用写成「工具 对象」，说的话取第一行。 */
function lastSteps(renderer: string, streamFile: string, count = 8): string[] {
  let body = '';
  try {
    body = fs.readFileSync(streamFile, 'utf8');
  } catch {
    return [];
  }
  let parser;
  try {
    parser = newParser(renderer);
  } catch {
    return [];
  }
  const steps: string[] = [];
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    for (const e of parser.parse(line)) {
      if (e.kind === KindToolCall) {
        const input = (e.input && typeof e.input === 'object' ? e.input : {}) as Record<string, unknown>;
        const target = ['command', 'file_path', 'path', 'subcommand', 'pattern'].map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined;
        steps.push(`${(e.tool ?? '').replace(/^mcp__onset__/, '')}${target ? ' ' + target.split('\n')[0].slice(0, 120) : ''}`);
      } else if (e.kind === KindText && (e.text ?? '').trim() !== '') {
        steps.push('说：' + (e.text ?? '').trim().split('\n')[0].slice(0, 120));
      }
    }
  }
  return steps.slice(-count);
}

/**
 * 上一次是不是中途异常退出、能不能接着做。要在 scene.run 归档上一次之前调用。
 * 同样的输入（fingerprint 一致）、结局是 failed / interrupted 才接；否则为 null。
 */
export function resumeState(s: Pick<Scene, 'directory' | 'id'>, fingerprint: string): ResumeState | null {
  const dir = latestAttemptDir(s);
  if (dir === '') return null;
  const previous = readAttempt(path.join(dir, attemptFileName(s.id)));
  if (!previous || (previous.outcome !== OutcomeFailed && previous.outcome !== OutcomeInterrupted)) return null;
  if (previous.fingerprint === '' || previous.fingerprint !== fingerprint) return null;
  let user = '';
  try {
    user = fs.readFileSync(path.join(dir, `render-${s.id}.user.log`), 'utf8');
  } catch {
    // 没有用户日志：当作没写完。
  }
  return { previous, logDir: dir, codeDone: user.includes(CodeDoneMessage), lastSteps: lastSteps(previous.renderer, path.join(dir, `render-${s.id}.stream.jsonl`)) };
}

/** 镜头目录里上一次留下的工作文件（合成代码、素材），给第三层的提示词列出来。 */
export function leftoverFiles(s: Pick<Scene, 'directory'>): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(s.directory);
  } catch {
    return [];
  }
  return names.filter((n) => !notWork.test(n)).sort();
}

/** 第二层：续接会话时只说这一句。 */
export function resumePrompt(reason: string, output: string, frames: number): string {
  return (
    `上一次渲染在中途中断了（${reason || '原因不明'}）。镜头目录里的文件就是你上次留下的，接着做完：先看已经写好的合成和你上一次最后在做的事，` +
    `补完没做完的部分，检查后渲染出 ${output}（必须正好 ${frames} 帧）。不要从头重写已经写好的部分。\n` +
    `完成后照常输出：[[USER_MESSAGE]]视频已渲染完成：${output}\n`
  );
}

/** 第三层：开新会话时接在提示词最后的一段。 */
export function continuationSection(c: Continuation): string {
  const lines = [
    '',
    '## 接着上一次做（优先于上面「从头制作」的要求）',
    '',
    `上一次渲染在中途中断了（${c.reason || '原因不明'}），没有出片。镜头目录里留着上一次写的文件：${c.files.length > 0 ? c.files.join('、') : '（没有）'}。`,
  ];
  if (c.codeDone) lines.push('上一次已经写完代码、开始渲染了，多半只差渲染这一步。');
  if (c.lastSteps.length > 0) lines.push('', '上一次最后几步：', ...c.lastSteps.map((step) => `- ${step}`));
  lines.push('', '先检查这些文件：能用就在上面接着做完，不要从头重写；确实有问题的地方再改。', '');
  return lines.join('\n');
}
