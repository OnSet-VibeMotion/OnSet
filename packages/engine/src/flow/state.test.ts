import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { experimentalFields, MaxStateFileBytes, parseManifest, readDeclaredState, type DeclaredState } from './index';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-state-')));
  temps.push(dir);
  return dir;
};

const state = { file: 'production/mine/status.json', json: 'publish.status', cases: [{ is: 'done', status: 'done' }] };
const manifest = (node: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'my-step',
    version: '1.0.0',
    name: '我的一站',
    nodes: [{ id: 'my-node', label: '我的站点', step: 'final', ...node }],
    produces: [{ prefix: 'production/mine/' }],
    ops: [
      { name: 'send', summary: '发出去', trigger: 'user', command: ['bin/send'] },
      { name: 'send_to', summary: '发到某处', trigger: 'user', command: ['bin/send'], params: { to: { type: 'string', description: '发到哪', required: true } } },
      { name: 'sync', summary: '同步', command: ['bin/sync'] },
    ],
    pages: [{ id: 'board', label: '看板', entry: 'ui/index.html', reads: ['publish.md'] }],
    ...over,
  });

describe('parsing nodes[].state and guide', () => {
  it('accepts a state without outputs and reports the experimental fields', () => {
    const m = parseManifest(manifest({ state, guide: { ai: '在做', actions: [{ label: '看', page: 'board' }, { label: '发', op: 'send' }, { label: '去发布页', page: 'publish' }] } }));
    expect(m.nodes[0].state).toEqual({ file: 'production/mine/status.json', format: 'json', key: ['publish', 'status'], cases: [{ is: ['done'], status: 'done' }] });
    expect(m.nodes[0].guide?.actions).toEqual([
      { kind: 'page', label: '看', page: 'x:my-step:board' },
      { kind: 'op', label: '发', station: 'my-step', op: 'send', summary: '发出去' },
      { kind: 'page', label: '去发布页', page: 'publish' },
    ]);
    expect(experimentalFields(m)).toEqual(['nodes.state', 'nodes.guide']);
    expect(experimentalFields(parseManifest(manifest({ outputs: ['production/mine/out.json'] })))).toEqual([]);
  });

  it('reads a frontmatter key from a file a page may read', () => {
    const m = parseManifest(manifest({ state: { file: 'publish.md', frontmatter: 'publish_status', cases: [{ is: ['ready', 'done'], status: 'done' }], missing: { detail: '还没写' } } }));
    expect(m.nodes[0].state?.format).toBe('frontmatter');
    expect(m.nodes[0].state?.missing).toEqual({ status: 'todo', detail: '还没写' });
  });

  it.each([
    [{ state: { ...state, extra: 1 } }, /nodes\[0\]\.state 有不认识的字段：extra/],
    [{ state: { ...state, cases: [{ is: 'done', status: 'finished' }] } }, /nodes\[0\]\.state\.cases\[0\]\.status 要是 todo \/ doing \/ done/],
    [{ state: { ...state, cases: [{ is: { a: 1 } }] } }, /cases\[0\]\.is 要是字符串、数字、布尔/],
    [{ state: { ...state, cases: [] } }, /cases 要是非空数组/],
    [{ state: { ...state, frontmatter: 'x' } }, /要写 json 或 frontmatter 之一/],
    [{ state: { ...state, json: 'a..b' } }, /state\.json 要是用 \. 分隔的键/],
    [{ state: { ...state, file: '../outside.json' } }, /state\.file：\.\.\/outside\.json 要是项目里的相对路径/],
    [{ state: { ...state, file: '.env' } }, /是 am 自己的文件/],
    [{ state: { ...state, file: 'production/studio/gates.json' } }, /是 am 自己的文件/],
    [{ state: { ...state, file: 'script.md' } }, /state\.file：script\.md 不在本站的 produces、outputs 或页面 reads 里/],
    [{ state: { ...state, otherwise: { waiting: 'me' } } }, /state\.otherwise\.waiting 要是 user 或 ai/],
    [{ gate: true, gate_files: ['production/mine/a.md'], state }, /是关卡，不能写 state/],
    [{}, /要写 outputs 或 state/],
    [{ state, guide: { actions: [{ label: '两个', say: 'a', draft: 'b' }] } }, /guide\.actions\[0\] 要在 say、draft、page、op 里写且只写一个/],
    [{ state, guide: { actions: [{ label: '发', op: 'sync' }] } }, /actions\[0\]\.op：sync 不是 trigger: user 的操作/],
    [{ state, guide: { actions: [{ label: '发', op: 'send_to' }] } }, /send_to 有必填参数/],
    [{ state, guide: { actions: [{ label: '发', op: 'nope' }] } }, /actions\[0\]\.op：没有操作 nope/],
    [{ state, guide: { actions: [{ label: '看', page: 'nope' }] } }, /actions\[0\]\.page：没有页面 nope/],
    [{ state: { ...state, cases: [{ is: 'x', guide: { actions: [{ label: '看', page: 'nope' }] } }] } }, /state\.cases\[0\]\.guide\.actions\[0\]\.page：没有页面 nope/],
  ])('rejects %j', (node, error) => {
    expect(() => parseManifest(manifest(node))).toThrow(error);
  });
});

describe('reading a declared state', () => {
  const decl = (over: Partial<DeclaredState> = {}): DeclaredState => ({
    file: 'status.json',
    format: 'json',
    key: ['publish', 'status'],
    cases: [
      { is: ['ready'], status: 'done', detail: '好了' },
      { is: ['waiting', 3, true], status: 'doing', detail: '等你：{value}', waiting: 'user' },
    ],
    ...over,
  });
  const write = (root: string, body: string, name = 'status.json') => fs.writeFileSync(path.join(root, name), body);

  it('maps the value through the cases, with fixed results for missing, broken and absent', () => {
    const root = temp();
    expect(readDeclaredState(root, decl())).toEqual({ branch: 'missing', outcome: { status: 'todo' }, mtime: 0 });
    expect(readDeclaredState(root, decl({ missing: { status: 'todo', detail: '还没写' } })).outcome.detail).toBe('还没写');
    write(root, '{"publish":{"status":"ready"}}');
    expect(readDeclaredState(root, decl())).toMatchObject({ branch: 'cases[0]', outcome: { status: 'done', detail: '好了' }, value: 'ready' });
    write(root, '{"publish":{"status":3}}');
    expect(readDeclaredState(root, decl())).toMatchObject({ branch: 'cases[1]', outcome: { status: 'doing', detail: '等你：3', waiting: 'user' } });
    write(root, '{"publish":{"status":"3"}}');
    expect(readDeclaredState(root, decl()).branch).toBe('otherwise');
    expect(readDeclaredState(root, decl({ otherwise: { status: 'doing', detail: '是 {value}' } })).outcome).toEqual({ status: 'doing', detail: '是 3' });
    write(root, '{"publish":');
    expect(readDeclaredState(root, decl({ invalid: { status: 'todo', detail: '坏了' } }))).toMatchObject({ branch: 'invalid', outcome: { detail: '坏了' } });
    write(root, '[1]');
    expect(readDeclaredState(root, decl()).branch).toBe('invalid');
    write(root, '{"publish":{"status":{"a":1}}}');
    expect(readDeclaredState(root, decl({ no_field: { status: 'todo', detail: '没字段' } }))).toMatchObject({ branch: 'no_field', outcome: { detail: '没字段' } });
    write(root, '{"publish":{}}');
    expect(readDeclaredState(root, decl()).branch).toBe('no_field');
  });

  it('reads Markdown frontmatter', () => {
    const root = temp();
    const fm = decl({ file: 'publish.md', format: 'frontmatter', key: ['publish_status'] });
    write(root, '---\npublish_status: waiting\n---\n正文', 'publish.md');
    expect(readDeclaredState(root, fm).outcome).toEqual({ status: 'doing', detail: '等你：waiting', waiting: 'user' });
    write(root, '没有 frontmatter', 'publish.md');
    expect(readDeclaredState(root, fm).branch).toBe('invalid');
  });

  it('refuses files that are too large or point outside the project', () => {
    const root = temp();
    write(root, JSON.stringify({ publish: { status: 'ready' }, pad: 'x'.repeat(MaxStateFileBytes) }));
    expect(readDeclaredState(root, decl()).branch).toBe('invalid');
    const outside = temp();
    write(outside, '{"publish":{"status":"ready"}}', 'secret.json');
    fs.rmSync(path.join(root, 'status.json'));
    fs.symlinkSync(path.join(outside, 'secret.json'), path.join(root, 'status.json'));
    expect(readDeclaredState(root, decl()).branch).toBe('invalid');
  });
});
