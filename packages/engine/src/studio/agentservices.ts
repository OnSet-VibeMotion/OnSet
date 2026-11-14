/**
 * 制作人的模型服务：/api/agent-services。
 *
 *   GET    /api/agent-services                 预设、存下的服务（不回传 key）、在用的是哪套、key 在磁盘上加没加密
 *   POST   /api/agent-services                 {id?, name, preset?, protocol, base_url, model, vision, key?}：新建（没有 id）或修改；
 *                                              修改时 key 留空表示不换
 *   DELETE /api/agent-services/{id}            删掉一套
 *   POST   /api/agent-services/{id}/activate   选这套在用
 *   POST   /api/agent-services/models          {protocol, base_url, key?, id?}：问服务有哪些模型（key 留空时用 id 那套存下的 key）
 *   GET    /api/agent-services/vision?model=   制作人这一轮会用的模型（model 为空时是服务自己的）、能不能看图（false / true，没有服务时 null）
 *
 * 与音色库、安装页一样写的是用户级目录（director.defaultDir），在进程里直接写，不占项目写锁、
 * 不进轮次快照。key 只落在那个 0600 的文件里，客户端里经 safeStorage 加密（director.useKeyCodec，
 * 用不了时退回明文，storage.note 告诉设置页）：不进 settings.conf、项目文件与任何子进程的环境。
 */
import * as director from '../director';
import { envMap } from '../envutil';
import { DecodeError, decodeJSON, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';

function dir(): string {
  return director.defaultDir(envMap());
}

function listing(): Response {
  const { active, services } = director.listServices(dir());
  const storage = director.keyStorage();
  return writeJSON(
    200,
    goMap({
      presets: director.Presets.map((p) => goMap({ id: p.id, label: p.label, protocol: p.protocol, base_url: p.baseURL, model: p.model, vision: p.vision, key_url: p.keyURL })),
      services: services.map((s) => goMap({ ...s })),
      active,
      storage: goMap({ encrypted: storage.encrypted, ...(storage.note ? { note: storage.note } : {}) }),
    }),
  );
}

async function body(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    return await decodeJSON(request);
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    throw err;
  }
}

export async function agentServicesAPI(request: Request): Promise<Response> {
  if (request.method === 'GET') return listing();
  if (request.method !== 'POST') return methodNotAllowed('GET, POST');
  const b = await body(request);
  if (b instanceof Response) return b;
  if (dir() === '') return writeError(500, 'no_data_dir', '找不到用户数据目录（没有 HOME）');
  try {
    director.saveService(dir(), {
      id: fieldString(b, 'id') || undefined,
      name: fieldString(b, 'name'),
      preset: fieldString(b, 'preset') || undefined,
      protocol: fieldString(b, 'protocol') || 'openai',
      base_url: fieldString(b, 'base_url'),
      model: fieldString(b, 'model'),
      vision: b.vision === true,
      key: fieldString(b, 'key'),
    });
  } catch (err) {
    return writeError(400, 'invalid_service', (err as Error).message);
  }
  return listing();
}

/** /api/agent-services/{id}、/api/agent-services/{id}/activate。 */
export async function agentServiceAPI(request: Request, rest: string): Promise<Response> {
  const match = /^([A-Za-z0-9-]+)(\/activate)?$/.exec(rest);
  if (!match) return writeError(404, 'not_found', '没有这个接口');
  const id = match[1]!;
  const activate = match[2] !== undefined;
  if (activate ? request.method !== 'POST' : request.method !== 'DELETE') return methodNotAllowed(activate ? 'POST' : 'DELETE');
  try {
    if (activate) director.setActiveService(dir(), id);
    else director.deleteService(dir(), id);
  } catch (err) {
    return writeError(404, 'unknown_service', (err as Error).message);
  }
  return listing();
}

/** 表单里「读取模型列表」：还没保存的服务也能问（key 留空时用 id 那套存下的）。 */
export async function agentServiceModelsAPI(request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const b = await body(request);
  if (b instanceof Response) return b;
  let key = fieldString(b, 'key').trim();
  const id = fieldString(b, 'id');
  if (key === '' && id !== '') key = director.resolveService(dir(), id)?.key ?? '';
  try {
    const models = await director.listServiceModels({ protocol: fieldString(b, 'protocol') === 'anthropic' ? 'anthropic' : 'openai', base_url: fieldString(b, 'base_url'), key });
    return writeJSON(200, goMap({ models }));
  } catch (err) {
    return writeJSON(200, goMap({ models: [], error: '没能读出模型列表：' + (err as Error).message + '。可以直接填模型名' }));
  }
}

/** 制作人这一轮会用的模型与它能不能看图：设置页编排模型一栏与开工前的提示用。 */
export function agentVisionAPI(request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const service = director.activeServiceInfo(dir());
  const model = director.effectiveModel((new URL(request.url).searchParams.get('model') ?? '').trim(), service);
  return writeJSON(200, goMap({ model, service: service?.name ?? '', vision: service ? service.vision : null }));
}
