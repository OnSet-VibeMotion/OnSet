/**
 * 音色页的后端：/api/voices。
 *
 * 音色库在用户级目录（voice 包），不是项目文件，所以与安装页、记忆面板一样在进程里直接读写，
 * 不占项目写锁、不进轮次快照。上传录音先走 /api/uploads 落进项目的 production/studio/uploads，
 * 再由这里转存进音色库。
 *
 *   GET    /api/voices                       全部音色与默认音色
 *   POST   /api/voices                       {name, text, upload, source?, make_default?} 存一段录音
 *   GET    /api/voices/{名字}/reference.wav  试听
 *   POST   /api/voices/{名字}/default        设为默认
 *   DELETE /api/voices/{名字}                删除（只有界面能删，编排工具没有这个操作）
 *
 * 在这一页直接做一个新声音（不用开项目对话、也不管项目配音选的是谁）：
 *
 *   POST   /api/voice-record                 multipart：file（麦克风录音）、name、text、make_default
 *   POST   /api/voice-design                 {instruction, text?} 用本机 Breeze 按描述念一段试听
 *   GET    /api/voice-drafts/{id}.wav        听试听
 *   POST   /api/voice-drafts/{id}/save       {name, make_default} 把挑中的试听存进音色库
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envMap } from '../envutil';
import * as prereqs from '../prereqs';
import * as voice from '../voice';
import { DecodeError, decodeJSON, fieldBool, fieldString, goMap, methodNotAllowed, serveFile, writeError, writeJSON } from './http';
import { containedPath } from './sessions';
import type { Server } from './studio';

function libraryDir(): string {
  return voice.defaultDir(envMap());
}

function voiceJSON(v: voice.VoiceEntry): Record<string, unknown> {
  return goMap({
    name: v.name,
    text: v.text,
    source: v.source,
    instruction: v.instruction ?? '',
    duration_seconds: v.duration_seconds,
    created: v.created,
    is_default: v.is_default,
  });
}

export async function voicesAPI(s: Server, request: Request): Promise<Response> {
  const dir = libraryDir();
  if (dir === '') return writeError(500, 'no_voice_library', '无法确定音色库目录：环境里没有 HOME');
  if (request.method === 'GET') {
    const voices = voice.list(dir);
    const env = envMap();
    const status = voice.designStatus(env);
    // 安装页里 Breeze 是哪一项：项目配音就是 Breeze 时是配音那一项，否则是单独的「音色设计」。
    const installID = prereqs.selection(env, s.projectRoot()).tts === 'breeze' ? 'tts:breeze' : 'voice:breeze';
    return writeJSON(
      200,
      goMap({
        dir,
        default: voice.defaultName(dir),
        voices: voices.map(voiceJSON),
        sample_text: voice.SampleText,
        design: goMap({ ready: status.ready, supported: status.supported, problem: status.problem, install_id: installID }),
      }),
    );
  }
  if (request.method !== 'POST') return methodNotAllowed('GET, POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  let body: Record<string, unknown>;
  try {
    body = await decodeJSON(request);
  } catch (err) {
    return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
  }
  const source = (fieldString(body, 'source') || 'recorded') as voice.Source;
  if (!voice.Sources.includes(source)) return writeError(400, 'invalid_source', `来源只能是 ${voice.Sources.join(' / ')}`);
  let audio: string;
  try {
    audio = containedPath(p.path, fieldString(body, 'upload'));
  } catch (err) {
    return writeError(400, 'invalid_path', (err as Error).message);
  }
  try {
    const saved = await voice.save(dir, {
      name: fieldString(body, 'name').trim(),
      audio,
      text: fieldString(body, 'text'),
      source,
      makeDefault: fieldBool(body, 'make_default'),
      env: envMap(),
    });
    return writeJSON(201, voiceJSON(saved));
  } catch (err) {
    return writeError(400, 'voice_not_saved', (err as Error).message);
  }
}

export async function voiceAPI(request: Request, rest: string): Promise<Response> {
  const dir = libraryDir();
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/');
  const name = parts[0] ?? '';
  if (!voice.validName(name)) return writeError(404, 'unknown_voice', '没有这个音色');
  try {
    voice.get(dir, name);
  } catch (err) {
    return writeError(404, 'unknown_voice', (err as Error).message);
  }
  if (parts.length === 2 && parts[1] === voice.ReferenceFile) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    // 替换音色后同名文件内容会变：不缓存，试听听到的永远是现在这一份。
    return serveFile(request, voice.get(dir, name).audio, { 'Cache-Control': 'no-cache', 'Content-Type': 'audio/wav' });
  }
  if (parts.length === 2 && parts[1] === 'default') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    voice.setDefault(dir, name);
    return writeJSON(200, voiceJSON(voice.get(dir, name)));
  }
  if (parts.length === 1) {
    if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
    voice.remove(dir, name);
    return writeJSON(200, goMap({ default: voice.defaultName(dir) }));
  }
  return writeError(404, 'not_found', '没有这个资源');
}

/** 麦克风录音：浏览器给的是 webm/opus（或 mp4），ffmpeg 转成参考音频。不经项目，录音不进任何项目。 */
export async function voiceRecordAPI(request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const dir = libraryDir();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return writeError(400, 'invalid_upload', '需要 multipart/form-data');
  }
  const file = form.get('file');
  if (!(file instanceof Blob) || file.size === 0) return writeError(400, 'no_file', '没有收到录音');
  if (file.size > 50 << 20) return writeError(400, 'too_large', '录音太大：只要十几秒就够了');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-voice-record-'));
  try {
    const take = path.join(tmp, 'take' + (file.type.includes('mp4') ? '.m4a' : '.webm'));
    fs.writeFileSync(take, Buffer.from(await file.arrayBuffer()));
    const saved = await voice.save(dir, {
      name: String(form.get('name') ?? '').trim(),
      audio: take,
      text: String(form.get('text') ?? ''),
      source: 'recorded',
      makeDefault: form.get('make_default') === 'true',
      env: envMap(),
    });
    return writeJSON(201, voiceJSON(saved));
  } catch (err) {
    return writeError(400, 'voice_not_saved', (err as Error).message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 同一时间只生成一段：Breeze 要占几 GB 内存，并排跑两段只会更慢。 */
let designing = false;

export async function voiceDesignAPI(request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  if (designing) return writeError(409, 'design_running', '上一段试听还在生成，等它好了再来');
  let body: Record<string, unknown>;
  try {
    body = await decodeJSON(request);
  } catch (err) {
    return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
  }
  designing = true;
  try {
    const draft = await voice.design(libraryDir(), { instruction: fieldString(body, 'instruction'), text: fieldString(body, 'text'), env: envMap(), signal: request.signal });
    return writeJSON(201, goMap({ id: draft.id, instruction: draft.instruction, text: draft.text }));
  } catch (err) {
    return writeError(400, 'design_failed', (err as Error).message);
  } finally {
    designing = false;
  }
}

export async function voiceDraftAPI(request: Request, rest: string): Promise<Response> {
  const dir = libraryDir();
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/');
  const id = (parts[0] ?? '').replace(/\.wav$/, '');
  let draft: voice.Draft;
  try {
    draft = voice.getDraft(dir, id);
  } catch (err) {
    return writeError(404, 'unknown_draft', (err as Error).message);
  }
  if (parts.length === 1 && parts[0].endsWith('.wav')) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return serveFile(request, draft.audio, { 'Cache-Control': 'no-cache', 'Content-Type': 'audio/wav' });
  }
  if (parts.length === 2 && parts[1] === 'save') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let body: Record<string, unknown>;
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
    }
    try {
      const saved = await voice.save(dir, {
        name: fieldString(body, 'name').trim(),
        audio: draft.audio,
        text: draft.text,
        source: 'designed',
        instruction: draft.instruction,
        makeDefault: fieldBool(body, 'make_default'),
        env: envMap(),
      });
      return writeJSON(201, voiceJSON(saved));
    } catch (err) {
      return writeError(400, 'voice_not_saved', (err as Error).message);
    }
  }
  return writeError(404, 'not_found', '没有这个资源');
}
