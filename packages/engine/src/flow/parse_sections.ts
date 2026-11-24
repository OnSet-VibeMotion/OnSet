import { stepIDs } from '../studioview';
import { idPattern, isObject, knownFields, opPattern, projectPath, relativeInside, str, strings } from './fields';
import {
  type ManifestNode,
  type ManifestOp,
  type ManifestPage,
  type ManifestParam,
  type ManifestPermissions,
  type ManifestSetting,
  nodeFieldNames,
  opFieldNames,
  type ParamType,
} from './manifest';
import { pageCallableOp } from './pages';
import { parseGuide, parseState } from './parse_declared';
import type { PathRule } from './types';

const paramTypes: readonly ParamType[] = ['string', 'boolean', 'integer', 'number', 'strings'];

export function parseNodes(nodesRaw: unknown): ManifestNode[] {
  if (!Array.isArray(nodesRaw)) throw new Error('station.nodes 要是数组');
  return nodesRaw.map((n, i): ManifestNode => {
    const where = `nodes[${i}]`;
    if (!isObject(n)) throw new Error(`${where} 要是对象`);
    knownFields(n, nodeFieldNames(), where);
    const step = str(n, 'step', where);
    if (!stepIDs().includes(step)) throw new Error(`${where}.step 要是 ${stepIDs().join(' / ')} 之一`);
    const gate = n.gate === true;
    const node: ManifestNode = {
      id: str(n, 'id', where),
      label: str(n, 'label', where),
      step,
      outputs: strings(n, 'outputs', where).map((p) => projectPath(p, `${where}.outputs`)),
      stale_after: strings(n, 'stale_after', where),
      gate_files: strings(n, 'gate_files', where).map((p) => projectPath(p, `${where}.gate_files`)),
    };
    if (!idPattern.test(node.id)) throw new Error(`${where}.id ${node.id} 要是小写字母、数字与连字符`);
    if (gate) node.gate = true;
    if (n.page !== undefined) node.page = str(n, 'page', where);
    if (n.state !== undefined) {
      if (gate) throw new Error(`${where} 是关卡，不能写 state（关卡看用户的确认）`);
      node.state = parseState(n.state, `${where}.state`);
    }
    if (n.guide !== undefined) node.guide = parseGuide(n.guide, `${where}.guide`);
    if (!gate && node.outputs.length === 0 && !node.state) {
      throw new Error(`${where} 不是关卡，要写 outputs 或 state（据此判断做没做）`);
    }
    if (gate && node.gate_files.length === 0) throw new Error(`${where} 是关卡，要写 gate_files（确认的是哪些文件）`);
    return node;
  });
}

export function parseProduces(producesRaw: unknown): PathRule[] {
  if (!Array.isArray(producesRaw)) throw new Error('station.produces 要是数组');
  return producesRaw.map((r, i): PathRule => {
    const where = `produces[${i}]`;
    if (!isObject(r)) throw new Error(`${where} 要是对象`);
    knownFields(r, ['path', 'prefix', 'base'], where);
    if (typeof r.path === 'string') {
      if (r.prefix !== undefined || r.base !== undefined)
        throw new Error(`${where} 写了 path 就不能再写 prefix / base`);
      return { path: projectPath(r.path, where) };
    }
    const prefix = projectPath(str(r, 'prefix', where), where);
    if (r.base === undefined) return { prefix };
    try {
      return { prefix, base: new RegExp(str(r, 'base', where)) };
    } catch (err) {
      throw new Error(`${where}.base 不是合法的正则：${(err as Error).message}`);
    }
  });
}

export function parseOps(opsRaw: unknown): ManifestOp[] {
  if (!Array.isArray(opsRaw)) throw new Error('station.ops 要是数组');
  return opsRaw.map((o, i): ManifestOp => {
    const where = `ops[${i}]`;
    if (!isObject(o)) throw new Error(`${where} 要是对象`);
    knownFields(o, opFieldNames(), where);
    const name = str(o, 'name', where);
    if (!opPattern.test(name)) throw new Error(`${where}.name ${name} 要是小写加下划线`);
    const command = strings(o, 'command', where);
    if (command.length === 0) throw new Error(`${where}.command 不能为空`);
    if (command[0].includes('/') || command[0].includes('\\')) relativeInside(command[0], `${where}.command[0]`);
    const trigger = o.trigger === undefined ? 'agent' : o.trigger;
    if (trigger !== 'agent' && trigger !== 'user') throw new Error(`${where}.trigger 要是 agent 或 user`);
    const paramsRaw = o.params ?? {};
    if (!isObject(paramsRaw)) throw new Error(`${where}.params 要是对象`);
    const params: Record<string, ManifestParam> = {};
    for (const [key, spec] of Object.entries(paramsRaw)) {
      const pw = `${where}.params.${key}`;
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`${pw}：参数名要是小写加下划线`);
      if (!isObject(spec)) throw new Error(`${pw} 要是对象`);
      knownFields(spec, ['type', 'description', 'required', 'default'], pw);
      if (!paramTypes.includes(spec.type as ParamType)) {
        throw new Error(`${pw}.type 要是 ${paramTypes.join(' / ')} 之一`);
      }
      params[key] = { type: spec.type as ParamType, description: str(spec, 'description', pw) };
      if (spec.required === true) params[key].required = true;
      if (spec.default !== undefined) params[key].default = spec.default;
    }
    const op: ManifestOp = { name, summary: str(o, 'summary', where), command, params, trigger };
    if (o.description !== undefined) op.description = str(o, 'description', where);
    if (o.project !== undefined) {
      if (typeof o.project !== 'boolean') throw new Error(`${where}.project 要是 true 或 false`);
      if (o.project === false && trigger !== 'user') {
        throw new Error(`${where}.project：只有 trigger: user 的操作能不需要项目`);
      }
      if (o.project === false) op.project = false;
    }
    if (o.list !== undefined) {
      if (typeof o.list !== 'boolean') throw new Error(`${where}.list 要是 true 或 false`);
      if (o.list) {
        if (trigger !== 'user' || o.project !== false) {
          throw new Error(`${where}.list：只有 trigger: user、project: false 的操作能返回列表`);
        }
        if (Object.values(params).some((p) => p.required)) {
          throw new Error(`${where}.list：返回列表的操作不能有必填参数（宿主会自动执行它）`);
        }
        op.list = true;
      }
    }
    if (o.form !== undefined) {
      if (typeof o.form !== 'boolean') throw new Error(`${where}.form 要是 true 或 false`);
      if (o.form === false && trigger !== 'user')
        throw new Error(`${where}.form：只有 trigger: user 的操作才有按钮表单`);
      if (o.form === false) op.form = false;
    }
    const examples = strings(o, 'examples', where);
    if (examples.length > 0) op.examples = examples;
    return op;
  });
}

export function parsePages(pagesRaw: unknown): ManifestPage[] {
  if (!Array.isArray(pagesRaw)) throw new Error('station.pages 要是数组');
  return pagesRaw.map((pg, i): ManifestPage => {
    const where = `pages[${i}]`;
    if (!isObject(pg)) throw new Error(`${where} 要是对象`);
    knownFields(pg, ['id', 'label', 'entry', 'reads'], where);
    const page: ManifestPage = {
      id: str(pg, 'id', where),
      label: str(pg, 'label', where),
      entry: str(pg, 'entry', where),
      reads: strings(pg, 'reads', where).map((p) => projectPath(p, `${where}.reads`)),
    };
    if (!idPattern.test(page.id)) throw new Error(`${where}.id ${page.id} 要是小写字母、数字与连字符`);
    relativeInside(page.entry, `${where}.entry`);
    if (!/\.html?$/.test(page.entry)) throw new Error(`${where}.entry 要是 .html 文件`);
    return page;
  });
}

export function parseSettings(v: unknown): ManifestSetting[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('station.settings 要是数组');
  const out = v.map((x, i): ManifestSetting => {
    const where = `settings[${i}]`;
    if (!isObject(x)) throw new Error(`${where} 要是对象`);
    knownFields(x, ['key', 'label', 'type', 'description', 'options', 'default'], where);
    const key = str(x, 'key', where);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`${where}.key 要是小写加下划线`);
    const type = str(x, 'type', where) as ManifestSetting['type'];
    if (!['string', 'number', 'boolean', 'select', 'secret'].includes(type)) {
      throw new Error(`${where}.type 要是 string / number / boolean / select / secret 之一`);
    }
    const options = strings(x, 'options', where);
    if (type === 'select' && options.length === 0) throw new Error(`${where} 是 select，要写 options`);
    const setting: ManifestSetting = {
      key,
      label: str(x, 'label', where),
      type,
      description: str(x, 'description', where, false),
      options,
    };
    if (x.default !== undefined) {
      if (type === 'secret') throw new Error(`${where}：密钥不能有缺省值`);
      const d = x.default;
      const ok =
        type === 'boolean'
          ? typeof d === 'boolean'
          : type === 'number'
            ? typeof d === 'number'
            : typeof d === 'string' && (type !== 'select' || options.includes(d));
      if (!ok) throw new Error(`${where}.default 与 type 不符`);
      setting.default = d as string | number | boolean;
    }
    return setting;
  });
  const keys = out.map((x) => x.key);
  if (new Set(keys).size !== keys.length) throw new Error('station.settings 里有重名的设置');
  return out;
}

export function parsePermissions(v: unknown): ManifestPermissions {
  if (v === undefined) return { project: false, network: [], uses: [] };
  if (!isObject(v)) throw new Error('station.permissions 要是对象');
  knownFields(v, ['project', 'network', 'uses'], 'permissions');
  const network = strings(v, 'network', 'permissions').map((origin) => {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      throw new Error(`permissions.network：${origin} 不是合法的地址`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'wss:') {
      throw new Error(`permissions.network：${origin} 要是 https:// 或 wss://`);
    }
    if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.host.includes('*')) {
      throw new Error(`permissions.network：${origin} 只写到域名（与端口）`);
    }
    return u.origin;
  });
  const uses = strings(v, 'uses', 'permissions');
  for (const name of uses) if (!pageCallableOp(name)) throw new Error(`permissions.uses：插件页面不能调 ${name}`);
  return { project: v.project === true, network, uses };
}

export function parseBrowser(value: unknown): { origins: string[] } {
  if (!isObject(value)) throw new Error('browser 要是对象');
  knownFields(value, ['origins'], 'browser');
  const origins = strings(value, 'origins', 'browser');
  if (origins.length === 0 || origins.length > 20) throw new Error('browser.origins 要有 1–20 个 HTTPS 来源');
  return {
    origins: [
      ...new Set(
        origins.map((origin) => {
          let url: URL;
          try {
            url = new URL(origin);
          } catch {
            throw new Error('browser.origins 地址无效');
          }
          if (
            url.protocol !== 'https:' ||
            url.origin !== origin ||
            url.username ||
            url.password ||
            url.hostname.includes('*')
          ) {
            throw new Error('browser.origins 只写 HTTPS 来源（域名与可选端口）');
          }
          return url.origin;
        }),
      ),
    ],
  };
}
