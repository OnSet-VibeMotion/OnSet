import { goQuote, isGoSpace } from '../gofmt';
import type { OrchestratorAccess } from '../tools';
import type { Config } from './config';
import { Aligners } from './providers';

/**
 * 任何配置下编排工具都要用到的命令（安全模式下按前缀放行）。
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
