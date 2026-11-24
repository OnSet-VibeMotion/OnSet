// 站点的声明式状态（nodes[].state）与「接下来」（nodes[].guide）
import * as studioview from '../studioview';
import { isObject, knownFields, projectPath, str } from './fields';
import type { Manifest } from './manifest';
import { pageMayRead, pageTab } from './pages';
import type { DeclaredGuide, DeclaredGuideAction, DeclaredOutcome, DeclaredState, DeclaredValue } from './types';

const keySegment = /^[A-Za-z0-9_-]+$/;

function isScalar(x: unknown): x is DeclaredValue {
  return typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x));
}

function parseOutcome(v: unknown, where: string): DeclaredOutcome {
  if (!isObject(v)) throw new Error(`${where} 要是对象`);
  knownFields(v, ['status', 'detail', 'waiting', 'guide'], where);
  const status = v.status === undefined ? 'todo' : v.status;
  if (status !== 'todo' && status !== 'doing' && status !== 'done') {
    throw new Error(`${where}.status 要是 todo / doing / done 之一`);
  }
  const out: DeclaredOutcome = { status };
  if (v.detail !== undefined) out.detail = str(v, 'detail', where);
  if (v.waiting !== undefined) {
    if (v.waiting !== 'user' && v.waiting !== 'ai') throw new Error(`${where}.waiting 要是 user 或 ai`);
    out.waiting = v.waiting;
  }
  if (v.guide !== undefined) out.guide = parseGuide(v.guide, `${where}.guide`);
  return out;
}

export function parseState(v: unknown, where: string): DeclaredState {
  if (!isObject(v)) throw new Error(`${where} 要是对象`);
  knownFields(v, ['file', 'json', 'frontmatter', 'cases', 'otherwise', 'missing', 'invalid', 'no_field'], where);
  const file = projectPath(str(v, 'file', where), `${where}.file`);
  if ((v.json === undefined) === (v.frontmatter === undefined)) {
    throw new Error(`${where} 要写 json 或 frontmatter 之一（读哪个字段）`);
  }
  const format = v.json !== undefined ? 'json' : 'frontmatter';
  const key = str(v, format, where).split('.');
  if (key.some((k) => !keySegment.test(k))) {
    throw new Error(`${where}.${format} 要是用 . 分隔的键（字母、数字、下划线与连字符）`);
  }
  if (!Array.isArray(v.cases) || v.cases.length === 0) throw new Error(`${where}.cases 要是非空数组`);
  const cases = v.cases.map((c, i) => {
    const cw = `${where}.cases[${i}]`;
    if (!isObject(c)) throw new Error(`${cw} 要是对象`);
    const { is, ...rest } = c;
    const raw = Array.isArray(is) ? is : [is];
    if (raw.length === 0 || !raw.every(isScalar)) throw new Error(`${cw}.is 要是字符串、数字、布尔，或它们的数组`);
    return { is: raw, ...parseOutcome(rest, cw) };
  });
  const state: DeclaredState = { file, format, key, cases };
  for (const k of ['otherwise', 'missing', 'invalid', 'no_field'] as const) {
    if (v[k] !== undefined) state[k] = parseOutcome(v[k], `${where}.${k}`);
  }
  return state;
}

export function parseGuide(v: unknown, where: string): DeclaredGuide {
  if (!isObject(v)) throw new Error(`${where} 要是对象`);
  knownFields(v, ['ai', 'user', 'actions'], where);
  const guide: DeclaredGuide = {};
  if (v.ai !== undefined) guide.ai = str(v, 'ai', where);
  if (v.user !== undefined) guide.user = str(v, 'user', where);
  if (v.actions !== undefined) {
    if (!Array.isArray(v.actions)) throw new Error(`${where}.actions 要是数组`);
    guide.actions = v.actions.map((a, i): DeclaredGuideAction => {
      const aw = `${where}.actions[${i}]`;
      if (!isObject(a)) throw new Error(`${aw} 要是对象`);
      knownFields(a, ['label', 'say', 'draft', 'page', 'op'], aw);
      const label = str(a, 'label', aw);
      const kinds = (['say', 'draft', 'page', 'op'] as const).filter((k) => a[k] !== undefined);
      if (kinds.length !== 1) throw new Error(`${aw} 要在 say、draft、page、op 里写且只写一个`);
      const kind = kinds[0];
      const value = str(a, kind, aw);
      if (kind === 'page') return { kind, label, page: value };
      if (kind === 'op') return { kind, label, station: '', op: value, summary: '' };
      return { kind, label, text: value };
    });
  }
  return guide;
}

/** 整份清单解析完再查：state 读的文件要在本站能读的范围里，按钮指向的操作与页面要存在。 */
export function checkDeclared(m: Manifest): void {
  const fixGuide = (g: DeclaredGuide | undefined, where: string) => {
    g?.actions?.forEach((a, i) => {
      const aw = `${where}.actions[${i}]`;
      if (a.kind === 'page') {
        if (m.pages.some((pg) => pg.id === a.page)) a.page = pageTab(m.id, a.page);
        else if (!studioview.viewPage(a.page)) throw new Error(`${aw}.page：没有页面 ${a.page}`);
      }
      if (a.kind === 'op') {
        const op = m.ops.find((o) => o.name === a.op);
        if (!op) throw new Error(`${aw}.op：没有操作 ${a.op}`);
        if (op.trigger !== 'user') throw new Error(`${aw}.op：${op.name} 不是 trigger: user 的操作`);
        if (Object.values(op.params).some((p) => p.required)) {
          throw new Error(`${aw}.op：${op.name} 有必填参数，按钮填不了，改用 page 指向能填参数的页面`);
        }
        a.station = m.id;
        a.summary = op.summary;
      }
    });
  };
  m.nodes.forEach((n, i) => {
    const where = `nodes[${i}]`;
    fixGuide(n.guide, `${where}.guide`);
    if (!n.state) return;
    if (!pageMayRead(m, n.state.file)) {
      throw new Error(`${where}.state.file：${n.state.file} 不在本站的 produces、outputs 或页面 reads 里`);
    }
    n.state.cases.forEach((c, j) => fixGuide(c.guide, `${where}.state.cases[${j}].guide`));
    for (const k of ['otherwise', 'missing', 'invalid', 'no_field'] as const) {
      fixGuide(n.state[k]?.guide, `${where}.state.${k}.guide`);
    }
  });
}
