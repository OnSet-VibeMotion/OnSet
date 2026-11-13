/**
 * 口播稿页。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as align from '../align';
import * as srt from '../srt';
import { writeError, writeJSON } from './http';
import type { Server } from './studio';

// 口播稿页读的文件。终稿由制作提示词第二阶段写出；没有终稿时退回用户放进项目的原稿。
const scriptFinalPath = 'production/script-final.md';
const scriptChangeLogPath = 'production/script-change-log.md';
const scriptVoicePath = 'production/audio/voice.srt';
/** scriptUnitsPerSecond 是估算朗读时长用的语速：中文播音约每分钟 250–280 字。 */
const scriptUnitsPerSecond = 4.5;

const scriptFallbacks = ['SCRIPT.md', 'script.md', 'transcription.srt'];

export interface ScriptResponse {
  path: string;
  content: string;
  /** 这是口播终稿（带显示/朗读与短语标记）；否则是原稿，原样显示。 */
  final: boolean;
  updated_at?: string;
  blocks?: align.ViewBlock[];
  stats?: align.ViewStats;
  parse_error?: string;
  /** 按 scriptUnitsPerSecond 估算的朗读时长。 */
  estimate_seconds?: number;
  voice?: { path: string; seconds: number };
  change_log?: { path: string; content: string };
}

/** Go 的 time.Time.Format(time.RFC3339)：本地时区，带偏移（UTC 时写 Z）。 */
export function localRFC3339(date: Date): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = offset === 0 ? 'Z' : `${offset > 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`
  );
}

export function scriptResponseJSON(out: ScriptResponse): Record<string, unknown> {
  return {
    path: out.path,
    content: out.content,
    final: out.final,
    updated_at: out.updated_at || undefined,
    blocks: out.blocks && out.blocks.length > 0 ? out.blocks : undefined,
    stats: out.stats ? { units: out.stats.units, paragraphs: out.stats.paragraphs, phrases: out.stats.phrases } : undefined,
    parse_error: out.parse_error || undefined,
    estimate_seconds: out.estimate_seconds || undefined,
    voice: out.voice ? { path: out.voice.path, seconds: out.voice.seconds } : undefined,
    change_log: out.change_log ? { path: out.change_log.path, content: out.change_log.content } : undefined,
  };
}

/** scriptAPI 给口播稿页：终稿解析成段落、标题与标记，附估算时长、实际配音时长与修改记录。 */
export function scriptAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return writeError(405, 'method_not_allowed', '只支持 GET');
  let root: string;
  try {
    root = s.currentProject().path;
  } catch (err) {
    return writeError(404, 'no_project', (err as Error).message);
  }
  return writeJSON(200, scriptResponseJSON(readScript(root)));
}

export function readScript(root: string): ScriptResponse {
  const out: ScriptResponse = { path: '', content: '', final: false };
  for (const name of [scriptFinalPath, ...scriptFallbacks]) {
    const full = path.join(root, name);
    let body: string;
    try {
      body = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    out.path = name;
    out.content = body;
    out.final = name === scriptFinalPath;
    try {
      out.updated_at = localRFC3339(fs.statSync(full).mtime);
    } catch {
      // 读得到却 stat 不了：不给时间。
    }
    break;
  }
  if (out.final) {
    try {
      const script = align.parseScript(out.content);
      const { blocks, stats } = align.view(script);
      out.blocks = blocks;
      out.stats = stats;
      out.estimate_seconds = stats.units / scriptUnitsPerSecond;
    } catch (err) {
      out.parse_error = (err as Error).message;
    }
    try {
      out.change_log = { path: scriptChangeLogPath, content: fs.readFileSync(path.join(root, scriptChangeLogPath), 'utf8') };
    } catch {
      // 没有修改记录。
    }
  }
  try {
    out.voice = { path: scriptVoicePath, seconds: srt.readSpan(path.join(root, scriptVoicePath)).endSeconds };
  } catch {
    // 还没有配音。
  }
  return out;
}
