/**
 * 导演的模型服务密钥：/api/agent-keys。
 *
 *   GET  /api/agent-keys   每家服务商：名字、申请 key 的页面、推荐模型、填没填（不回传 key 本身）
 *   POST /api/agent-keys   {provider, key}：填写或替换；key 为空即删除
 *   GET  /api/agent-keys/vision?model=<服务商/模型>   导演实际会用哪个模型（model 为空时按填了 key 的服务商挑）、
 *                                                    它能不能读图（false 是看不了，null 是不知道）
 *
 * 与音色库、安装页一样写的是用户级目录（director.defaultDir），在进程里直接写，不占项目写锁、
 * 不进轮次快照。key 只落在那个 0600 的文件里，客户端里经 safeStorage 加密（director.useKeyCodec，
 * 用不了时退回明文，storage.note 告诉设置页）：不进 settings.conf、项目文件与任何子进程的环境。
 */
import * as director from '../director';
import { envMap } from '../envutil';
import { DecodeError, decodeJSON, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { directorModel } from './vision';

function dir(): string {
  return director.defaultDir(envMap());
}

function listing(): Response {
  const d = dir();
  const configured = director.configuredProviders(d);
  const storage = director.keyStorage();
  return writeJSON(
    200,
    goMap({
      providers: director.Providers.map((p) => goMap({ id: p.id, label: p.label, key_url: p.keyURL, default_model: p.defaultModel, vision: p.vision, configured: configured.includes(p.id) })),
      // 不在上表里、但用户手动填过的服务商（模型名照样能用）。
      others: configured.filter((id) => !director.Providers.some((p) => p.id === id)),
      // key 在磁盘上是否加密；没加密时附一句说明（safeStorage 用不了、或不在客户端里）。
      storage: goMap({ encrypted: storage.encrypted, ...(storage.note ? { note: storage.note } : {}) }),
    }),
  );
}

export async function agentKeysAPI(request: Request): Promise<Response> {
  if (request.method === 'GET') return listing();
  if (request.method !== 'POST') return methodNotAllowed('GET, POST');
  let body: Record<string, unknown>;
  try {
    body = await decodeJSON(request);
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    throw err;
  }
  const d = dir();
  if (d === '') return writeError(500, 'no_data_dir', '找不到用户数据目录（没有 HOME）');
  try {
    director.setProviderKey(d, fieldString(body, 'provider'), fieldString(body, 'key'));
  } catch (err) {
    return writeError(400, 'invalid_key', (err as Error).message);
  }
  return listing();
}

/** 导演实际会用的模型与它能不能读图：设置页编排模型一栏与开工前的提示用。 */
export function agentVisionAPI(request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const model = directorModel((new URL(request.url).searchParams.get('model') ?? '').trim());
  return writeJSON(200, goMap({ model, vision: model === '' ? null : (director.modelVision(model) ?? null) }));
}
