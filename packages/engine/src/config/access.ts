import { goQuote, isGoSpace } from '../gofmt';
import type { OrchestratorAccess } from '../tools';
import type { Config } from './config';
import { Aligners } from './providers';

/**
 * 任何配置下编排工具都要用到的命令（安全模式下按前缀放行）。
 *
 * 早先只放行 onset、ffmpeg、ffprobe、ls、mkdir，编排工具连 cat、head、echo、shasum 都被拦，
 * 一轮对话里大半工具调用是「需要批准」，而 -p 模式下没人批准（实测）。这里补上只读查看、
 * 校验哈希、只读 git 与下载（制作提示词要求从 Google Fonts 下载字体）。之后又放了
 * python3 / python / node：编排工具常要写小脚本处理数据，拦掉只会逼用户改用 --unsafe
 * （用户反馈）。代价是脚本能做任何事，包括读 .env——这里防的是误操作与越界命令，
 * 不是对抗性的编排工具。仍然不放：shell 本身（sh、bash，等于任意命令行）、删除与改权限
 * （rm、chmod、chown）、安装（brew、pip、npm）、提权（sudo）。用户要补别的命令写进
 * ORCHESTRATOR_ALLOW_COMMANDS。
 * claude 的 acceptEdits 自己会放行工作区内的 touch、mkdir、rm、mv、cp 这类文件命令；
 * .env 的读取由 Read 禁令拦着，cat .env 照样会被拒（实测）。
 *
 * 2026-11 再放宽一轮（用户反馈「安全方向的限制还可以放宽」）：文本处理（sed、awk、tr……）、
 * 压缩解压、macOS 自带的看图与放音命令，都是编排工具整理素材时顺手要用、又碰不到项目外的。
 * 仍然不放 xargs、env、sh 这类「能代为执行任意命令」的。白名单外的命令，编排工具是 claude 且在
 * 客户端里时会弹卡片问用户（studio/permissions.ts），其余工具照旧直接拒绝。
 */
export const orchestratorBaseCommands: readonly string[] = [
  'ffmpeg',
  'ffprobe',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'sort',
  'uniq',
  'cut',
  'diff',
  'cmp',
  'stat',
  'file',
  'du',
  'pwd',
  'basename',
  'dirname',
  'realpath',
  'jq',
  'tree',
  'which',
  'date',
  'echo',
  'printf',
  'cd',
  'mkdir',
  'cp',
  'mv',
  'touch',
  'shasum',
  'sha256sum',
  'md5',
  'git status',
  'git diff',
  'git log',
  'git show',
  'curl',
  'python3',
  'python',
  'node',
  'sed',
  'awk',
  'tr',
  'tee',
  'column',
  'paste',
  'nl',
  'fold',
  'iconv',
  'base64',
  'xxd',
  'od',
  'comm',
  'join',
  'rev',
  'tar',
  'unzip',
  'zip',
  'gzip',
  'gunzip',
  'ln',
  'sleep',
  'test',
  'true',
  'false',
  'sips',
  'mdls',
  'afplay',
  'open',
];

function goFields(value: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of value) {
    if (isGoSpace(ch.codePointAt(0)!)) {
      if (current !== '') out.push(current);
      current = '';
    } else current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

const shellControl = new Set([';', '&', '|', '`', '$', '<', '>', '(', ')', '\\', '"', "'", '*', '\n']);

/**
 * 解析 ORCHESTRATOR_ALLOW_COMMANDS：逗号分隔的命令前缀，不能带 shell 控制符。
 */
export function parseAllowCommands(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const item = goFields(raw).join(' ');
    if (item === '') continue;
    if ([...item].some((c) => shellControl.has(c))) {
      throw new Error(
        `ORCHESTRATOR_ALLOW_COMMANDS 里的 ${goQuote(item)} 带了 shell 控制符；只写命令前缀，例如 "uv run"、"pnpm"，多个用逗号分隔`,
      );
    }
    out.push(item);
  }
  return out;
}

/**
 * 安全模式下编排工具要放行的命令与用户级可写目录。
 */
export function orchestratorAccess(config: Config, ...extra: string[]): OrchestratorAccess {
  const commands = [...orchestratorBaseCommands];
  for (const aligner of Aligners) {
    if (aligner.id === config.alignProvider && aligner.command !== '') commands.push(aligner.command);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const command of [...commands, ...config.extraCommands, ...extra]) {
    if (command !== '' && !seen.has(command)) {
      seen.add(command);
      out.push(command);
    }
  }
  const access: OrchestratorAccess = { commands: out };
  const writable: string[] = [];
  if (config.memory.enabled && config.memory.dir !== '') writable.push(config.memory.dir);
  if (config.voicesDir !== '') writable.push(config.voicesDir);
  if (config.seriesDir !== '') writable.push(config.seriesDir);
  if (writable.length > 0) access.writableDirs = writable;
  return access;
}
