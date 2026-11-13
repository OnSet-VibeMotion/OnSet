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
 */
import { envMap } from '../envutil';
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
    return writeJSON(200, goMap({ dir, default: voice.defaultName(dir), voices: voices.map(voiceJSON) }));
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
