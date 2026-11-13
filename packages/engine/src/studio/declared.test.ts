/**
 * 第三方站点的声明式状态（清单 nodes[].state / guide）接到制作路线上：假发布只用清单顶替内置「发布」，
 * 在六种发布状态下路线的状态、说明、等谁与内置发布插件的判断函数对齐。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addToProject, fetchStation, recordFlow } from '../flow';
import { computeStations } from './progress';
import { discoverScenes } from './scenes';

const fake = path.join(__dirname, '..', 'flow', 'testdata', 'fake-publisher');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** 假发布的一份拷贝，清单并进 declared-state.json（顶替内置发布、站点带上 state 与 guide）。 */
function declaredPublisher(): string {
  const dir = temp('am-fake-declared-');
  fs.cpSync(fake, dir, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'am-station.json'), 'utf8'));
  const patch = JSON.parse(fs.readFileSync(path.join(dir, 'declared-state.json'), 'utf8'));
  m.replaces = patch.replaces;
  delete m.after;
  delete m.flow;
  Object.assign(m.nodes[0], patch.node);
  fs.writeFileSync(path.join(dir, 'am-station.json'), JSON.stringify(m, null, 2));
  return dir;
}

/** 走到发布这一站的项目：试听确认过，前面的站都算过了。 */
function project(publishMD: string | null, station?: string): string {
  const root = temp('am-declared-');
  recordFlow(root, { id: 'speech', canvas: 'vertical-3x4' });
  fs.mkdirSync(path.join(root, 'production'), { recursive: true });
  fs.writeFileSync(path.join(root, 'production', 'approval.json'), '{"approved_at":"2026-11-01T00:00:00Z"}');
  if (publishMD !== null) fs.writeFileSync(path.join(root, 'publish.md'), publishMD);
  if (station) addToProject(root, fetchStation(`link:${station}`, process.env).entry);
  return root;
}

const md = (status: string) => `---\nplatform: douyin\npublish_status: ${status}\n---\n`;
const inputs: [string, string | null][] = [
  ['没有 publish.md', null],
  ['draft', md('draft')],
  ['pending_manual_checks', md('pending_manual_checks')],
  ['blocked', md('blocked')],
  ['ready', md('ready')],
  ['frontmatter 写坏了', '---\nplatform: [douyin\n---\n'],
  ['没有 publish_status', '---\nplatform: douyin\n---\n'],
  ['不认识的状态', md('archived')],
];

function view(root: string, id: string) {
  const p = computeStations(root, discoverScenes(root));
  const s = p.stations.find((x) => x.id === id)!;
  return { status: s.status, detail: s.detail ?? '', current: p.current === id, waiting_on: p.current === id ? p.waiting_on : '' };
}

describe('declared station state', () => {
  it('matches the builtin publishing judge in every publish state', () => {
    const station = declaredPublisher();
    const rows: string[] = [];
    for (const [name, body] of inputs) {
      const builtin = view(project(body), 'publish');
      const declared = view(project(body, station), 'auto-publish');
      rows.push(`${name}: ${JSON.stringify(builtin)}`);
      expect(declared, name).toEqual(builtin);
    }
    expect(rows).toMatchSnapshot();
  });

  it('carries the declared guide in the same shape as a builtin one', () => {
    const station = declaredPublisher();
    const at = (body: string) => computeStations(project(body, station), []).stations.find((s) => s.id === 'auto-publish')!.guide;
    expect(at(md('draft'))).toEqual({
      ai: 'AI 在按各平台的规格做封面、写标题和简介。',
      user: '最后一步：封面、标题和简介。',
      actions: [{ kind: 'page', label: '看发布看板', page: 'x:fake-publisher:dashboard' }],
    });
    // 停在「等你」的那一项自带说法与按钮：填进输入框、请用户确认后执行本站的操作、开插件页面。
    expect(at(md('pending_manual_checks'))).toEqual({
      user: '发布前还剩几项人工检查：核对完告诉 AI，或者先记一笔。',
      actions: [
        { kind: 'draft', label: '核对完了', text: '发布前的人工检查我核对完了：' },
        { kind: 'op', label: '先记一笔', station: 'fake-publisher', op: 'scribble', summary: '顺手记一笔（测试用：会写一个没声明的文件）' },
        { kind: 'page', label: '看发布看板', page: 'x:fake-publisher:dashboard' },
      ],
    });
  });

  it('counts the outputs as done before reading the state, and keeps a started station from being skipped', () => {
    const station = declaredPublisher();
    const root = project(md('draft'), station);
    fs.mkdirSync(path.join(root, 'production', 'publish'), { recursive: true });
    fs.writeFileSync(path.join(root, 'production', 'publish', 'receipts.json'), '{}');
    const s = computeStations(root, []).stations.find((x) => x.id === 'auto-publish')!;
    expect(s.status).toBe('done');
    expect(s.detail).toBeUndefined();
  });

  it('leaves a station without the new fields judged by its outputs alone', () => {
    const root = project(md('pending_manual_checks'), fake);
    const p = computeStations(root, []);
    const s = p.stations.find((x) => x.id === 'auto-publish')!;
    expect(s.detail).toBeUndefined();
    expect(s.guide).toBeUndefined();
  });
});
