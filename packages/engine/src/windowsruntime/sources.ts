import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir, windowsPython } from '../envutil';
import { atomicWrite } from '../fsutil';
import { marshal, marshalIndent } from '../gojson';
import { start } from '../procgroup';
import downloadScript from './download.py.tmpl';

export type SourceKind = 'zip' | 'audio' | 'html' | 'json';
export interface DownloadOptions {
  root: string;
  url: string;
  workURL?: string;
  output: string;
  kind: SourceKind;
  env: Record<string, string>;
  maxBytes?: number;
  timeoutSeconds?: number;
  sha256?: string;
  recordField?: string;
  recordValue?: string;
  recordTitle?: string;
  signal?: AbortSignal;
}
interface ResponseInfo {
  ok: boolean;
  url: string;
  status: number;
  content_type: string;
  bytes: number;
  zip_valid?: boolean;
  error_type?: string;
  error?: string;
  cause?: string;
}

const sha = (body: Buffer): string => crypto.createHash('sha256').update(body).digest('hex');
const textOf = (body: Buffer): string => body.toString('utf8').replace(/^\uFEFF/, '');
const isHTML = (body: Buffer): boolean => /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(textOf(body));

/** 公共素材 URL 不接受内嵌登录信息或凭据，诊断也不写出它们。 */
function publicURL(value: string, signedDownload = false): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('素材来源必须是无登录信息的 HTTP(S) 地址');
  for (const key of url.searchParams.keys()) if (/(?:token|secret|password|api.?key|signature|authorization|credential)/i.test(key) && !(signedDownload && /signature|token|credential/i.test(key))) throw new Error('素材地址含凭据参数，请使用公开作品页或公开下载地址');
  return url;
}

function recordedURL(value: string): string {
  const url = publicURL(value, true);
  for (const key of url.searchParams.keys()) if (/signature|token|credential/i.test(key)) url.searchParams.set(key, '[redacted]');
  return url.href;
}

/** 从已取回的作品页发现实际下载端点、动态页面的公开 JSON；不执行页面脚本。 */
export function sourceLinks(body: string, source: string): { downloads: string[]; json: string[] } {
  const base = publicURL(source);
  const resolve = (values: string[]) => [...new Set(values.flatMap((value) => {
    try { return [publicURL(new URL(value.replaceAll('&amp;', '&'), base).href).href]; } catch { return []; }
  }))].slice(0, 12);
  const hrefs = [...body.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  const fetches = [...body.matchAll(/fetch\s*\(\s*["']([^"']+\.json(?:\?[^"']*)?)["']/gi)].map((match) => match[1]);
  const endpoints = [...body.matchAll(/["'](\/download-link\/[A-Za-z0-9_-]+)["']/g)].map((match) => match[1]);
  const prefixes = [...body.matchAll(/fetch\s*\(\s*["']([^"']*\/download-link\/)["']\s*\+/g)].map((match) => match[1]);
  const ids = [...body.matchAll(/data-download-id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)].map((match) => match[1]);
  const generated = prefixes.flatMap((prefix) => ids.map((id) => prefix + id));
  return { downloads: resolve([...hrefs.filter((href) => /\.zip(?:[?#]|$)|\/download-link\//i.test(href)), ...endpoints, ...generated]), json: resolve([...fetches, ...hrefs.filter((href) => /\.json(?:[?#]|$)/i.test(href))]) };
}

/** 目标只限来源收件目录；不覆盖配音、镜头、分镜、许可批准或任意已有文件。 */
export function sourceOutput(root: string, output: string): string {
  const realRoot = fs.realpathSync(root);
  const relative = output.replaceAll('\\', '/');
  const parts = relative.split('/');
  if (!/^(?:production\/(?:audio\/source|sources)|assets\/sources)\/.+/.test(relative) || path.isAbsolute(output) || parts.some((part) => part === '..' || part === '' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('output 只能使用项目来源收件目录内的普通文件路径');
  const target = path.resolve(realRoot, relative);
  let existing = path.dirname(target);
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const resolvedParent = fs.realpathSync(existing);
  const escaped = path.relative(realRoot, resolvedParent);
  if (escaped.startsWith('..') || path.isAbsolute(escaped)) throw new Error('素材收件目录的真实路径越出了项目');
  return target;
}

function verifyKind(body: Buffer, kind: SourceKind, info: ResponseInfo): unknown {
  if (body.length === 0) throw new Error('素材响应为空');
  if (kind === 'zip') {
    if (!info.zip_valid) throw new Error('响应不是通过 CRC 检查的 ZIP，不能按 ZIP 保存');
  } else if (kind === 'json') {
    return JSON.parse(textOf(body));
  } else if (kind === 'html') {
    if (!isHTML(body)) throw new Error('响应不是 HTML 作品页');
  } else {
    const head = body.subarray(0, 16);
    const wave = head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WAVE';
    const mp3 = head.subarray(0, 3).toString() === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    const known = ['OggS', 'fLaC'].includes(head.subarray(0, 4).toString()) || head.subarray(4, 8).toString() === 'ftyp';
    if (!wave && !mp3 && !known) throw new Error('响应没有受支持的音频文件签名，不能按音频保存；尚未执行媒体解码');
  }
  return undefined;
}

function matchedRecord(data: unknown, opts: DownloadOptions): unknown {
  if (!opts.recordField && !opts.recordValue && !opts.recordTitle) return undefined;
  if (!opts.recordField || !opts.recordValue) throw new Error('记录核验须同时给出 record_field 和 record_value');
  const values = Array.isArray(data) ? data : data && typeof data === 'object' ? [data, ...Object.values(data)] : [];
  const rows = values.flatMap((value) => Array.isArray(value) ? value : [value]).filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  const found = rows.filter((row) => Object.hasOwn(row, opts.recordField!) && String(row[opts.recordField!] ?? '') === opts.recordValue);
  if (found.length !== 1 || (opts.recordTitle && found[0].title !== opts.recordTitle)) throw new Error('公开 JSON 中的条目 ID/标题不唯一或不匹配，未形成曲目身份凭据');
  return found[0];
}

async function transfer(opts: DownloadOptions, url: string, target: string, referer?: string): Promise<ResponseInfo> {
  const python = windowsPython(opts.env);
  if (!python) throw new Error('没有已准备好的 Windows Python，请在工具准备页完成配音或对齐环境安装');
  const data = dataDir(opts.env);
  if (!data) throw new Error('无法确定 Windows 工具数据目录');
  const script = path.join(data, 'windows-runtime', `source-${sha(Buffer.from(downloadScript)).slice(0, 12)}.py`);
  if (!fs.existsSync(script)) atomicWrite(script, downloadScript);
  const started = await start(python, [script], { env: { ...opts.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, signal: opts.signal, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  started.child.stdout!.on('data', (chunk) => { stdout = (stdout + chunk).slice(-65536); });
  started.child.stderr!.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  started.child.stdin!.on('error', () => { /* 启动后提前退出的错误由 wait 与 stderr 一并报告。 */ });
  started.child.stdin!.end(marshal({ url, target, referer, kind: opts.kind, timeout: opts.timeoutSeconds ?? 20, max_bytes: opts.maxBytes ?? 64 * 1024 * 1024 }));
  let failed: unknown;
  try { await started.wait(); } catch (error) { failed = error; }
  if (opts.signal?.aborted) throw new Error('素材下载已取消');
  let result: ResponseInfo;
  try { result = JSON.parse(stdout.trim()); } catch { throw new Error(`Windows 下载进程没有返回有效结果：${stderr || String(failed ?? '')}`); }
  if (!result.ok || failed) throw new Error(`Windows 素材下载失败：${result.error_type ?? ''}: ${result.error ?? stderr}${result.cause ? `；原因：${result.cause}` : ''}`);
  publicURL(result.url, true);
  return result;
}

/** 经 Python 的经验证 TLS 与系统代理获取公开来源，验证后才写入收件目录，重试可复用同一来源。 */
export async function downloadSource(opts: DownloadOptions): Promise<Record<string, unknown>> {
  if (process.platform !== 'win32') throw new Error('source_download 仅用于 Windows');
  publicURL(opts.url);
  if (opts.workURL) publicURL(opts.workURL);
  if (!['zip', 'audio', 'html', 'json'].includes(opts.kind)) throw new Error('kind 必须为 zip、audio、html 或 json');
  if (!(opts.maxBytes === undefined || Number.isSafeInteger(opts.maxBytes) && opts.maxBytes > 0 && opts.maxBytes <= 256 * 1024 * 1024)) throw new Error('下载体积上限必须在 1..256 MiB 内');
  if (!(opts.timeoutSeconds === undefined || Number.isFinite(opts.timeoutSeconds) && opts.timeoutSeconds > 0 && opts.timeoutSeconds <= 60)) throw new Error('下载超时必须在 0..60 秒内');
  if (opts.sha256 && !/^[a-fA-F0-9]{64}$/.test(opts.sha256)) throw new Error('sha256 必须是 64 位十六进制摘要');
  const target = sourceOutput(opts.root, opts.output);
  const sidecar = target + '.source.json';
  if (fs.existsSync(target) || fs.existsSync(sidecar)) {
    if (fs.existsSync(target) && fs.existsSync(sidecar)) {
      const previous = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      const body = fs.readFileSync(target);
      if (previous.requested_url === opts.url && previous.kind === opts.kind && previous.sha256 === sha(body) && (!opts.sha256 || sha(body) === opts.sha256.toLowerCase())) {
        const data = opts.kind === 'json' ? JSON.parse(textOf(body)) : undefined;
        return { ...previous, reused: true, record: matchedRecord(data, opts) };
      }
    }
    throw new Error('素材目标或来源记录已存在且无法核对为同一来源，已保留原文件；请先核验或选择新的收件文件名');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-source-'));
  const bodyFile = path.join(temp, 'response');
  let published = false;
  try {
    let url = opts.url;
    let referer = opts.workURL;
    let info!: ResponseInfo;
    let body!: Buffer;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (fs.existsSync(bodyFile)) fs.unlinkSync(bodyFile);
      info = await transfer(opts, url, bodyFile, referer);
      body = fs.readFileSync(bodyFile);
      if (opts.kind !== 'zip' || info.zip_valid) break;
      let next = '';
      try {
        const data = JSON.parse(textOf(body));
        const link = data.url ?? data.download ?? data.link;
        next = typeof link === 'string' ? link : '';
      } catch {
        if (isHTML(body)) {
          referer ||= info.url;
          const links = sourceLinks(textOf(body), info.url).downloads.filter((value) => new URL(value).origin === new URL(info.url).origin);
          if (links.length === 1) next = links[0];
        }
      }
      if (!next || next === url || attempt === 3) throw new Error(`期望 ZIP，实际返回 ${info.content_type || '未知类型'}；未保存成假 ZIP，请用作品页提供的实际下载端点`);
      url = publicURL(new URL(next, info.url).href, true).href;
    }
    const data = verifyKind(body, opts.kind, info);
    const record = matchedRecord(data, opts);
    const digest = sha(body);
    if (opts.sha256 && digest !== opts.sha256.toLowerCase()) throw new Error('素材 SHA-256 与期望值不符，未写入目标');
    const links = opts.kind === 'html' ? sourceLinks(textOf(body), info.url) : undefined;
    const result = { schema: 1, requested_url: opts.url, work_url: opts.workURL, final_url: recordedURL(info.url), kind: opts.kind, content_type: info.content_type, path: opts.output, bytes: body.length, sha256: digest, record, links, retrieved_at: new Date().toISOString(), media_decode_verified: false };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // COPYFILE_EXCL 保证不会覆盖其他写入者刚生成的来源文件。
    fs.copyFileSync(bodyFile, target, fs.constants.COPYFILE_EXCL);
    published = true;
    atomicWrite(sidecar, marshalIndent(result) + '\n');
    return result;
  } catch (error) {
    // 只撤销本次刚发布且未被其他写入者更改的来源文件。
    if (published && fs.existsSync(target) && sha(fs.readFileSync(target)) === sha(fs.readFileSync(bodyFile))) fs.unlinkSync(target);
    throw error;
  } finally {
    if (fs.existsSync(bodyFile)) fs.unlinkSync(bodyFile);
    fs.rmdirSync(temp);
  }
}
