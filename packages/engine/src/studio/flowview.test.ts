// /api/state 的 flow：界面按流程声明排顶栏，不按片型写死。
import './testsupport';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as flow from '../flow';
import * as preset from '../preset';
import * as projectinit from '../projectinit';
import { flowView, pageGate } from './progress';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
/** 一个记下了流程的项目目录（id 为空时不写记录）。 */
function root(id = 'speech'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-flowview-')));
  temps.push(dir);
  if (id !== '') flow.recordFlow(dir, { id, canvas: preset.defaultPreset().id });
  return dir;
}

describe('flowView', () => {
  it('declares the steps and pages of the speech and beat flows as the top bar had them', () => {
    expect(flowView(root())).toEqual({
      id: 'speech',
      name: '口播',
      first_page: 'script',
      steps: ['script', 'storyboard', 'scene', 'final', 'publish'],
      hidden_pages: ['beat'],
      first_steps: ['script', 'beat'],
      land_page: '',
    });
    expect(flowView(root('beat'))).toEqual({
      id: 'beat',
      name: '卡点',
      first_page: 'beat',
      steps: ['beat', 'storyboard', 'scene', 'final', 'publish'],
      hidden_pages: ['script'],
      first_steps: ['beat', 'script'],
      land_page: 'beat',
    });
  });

  it('follows the recorded flow of a new song project', () => {
    const dir = root('');
    projectinit.create({ target: dir, canvas: preset.defaultPreset().id, delivery: 'song', narration: 'solo' });
    const v = flowView(dir);
    expect(v.id).toBe('song');
    expect(v.steps).toEqual(['script', 'storyboard', 'scene', 'final', 'publish']);
    expect(v.hidden_pages).toEqual(['beat']);
  });

  it('puts the first page of a third-party flow first', () => {
    flow.installStation(`link:${path.join(__dirname, '..', 'flow', 'testdata', 'fake-publisher')}`);
    const dir = root('x:fake-publisher');
    const v = flowView(dir);
    expect(v.id).toBe('x:fake-publisher');
    expect(v.steps[0]).toBe('x:fake-publisher:dashboard');
    // 第一页是插件自己的页面：自带的第一页按口播算，节拍页用不上。
    expect(v.hidden_pages).toEqual(['beat']);
    expect(v.land_page).toBe('');
    expect(v.first_steps).toEqual(['x:fake-publisher:dashboard', 'script', 'beat']);
  });

  it('says which plugin is missing when the project flow comes from one that is not installed', () => {
    expect(() => flowView(root('x:fake-publisher'))).toThrow('插件「fake-publisher」带来的做法');
  });
});

describe('directories without a flow record', () => {
  it('have no flow view, no progress route and say why', async () => {
    const { readProgress } = await import('./progress');
    const dir = root('');
    // 标记文件不再决定流程。
    fs.writeFileSync(path.join(dir, 'beat.yaml'), 'schema: 1\n');
    expect(() => flowView(dir)).toThrow(flow.MissingFlowRecordError);
    expect(() => readProgress(dir)).toThrow('不是用这一版片场新建的项目');
  });
});

describe('pageGate', () => {
  it('names the review gate of a page on the route of the project\'s own flow', () => {
    expect(pageGate(root(), 'storyboard')).toEqual({ id: 'gate-storyboard' });
    expect(pageGate(root(), 'script')).toEqual({ id: 'gate-script' });
    expect(pageGate(root('beat'), 'storyboard')).toEqual({ id: 'gate-beat-storyboard', confirm: '分镜我看过了，没问题，开始渲染。' });
    expect(pageGate(root('beat'), 'script')).toBeNull();
    expect(pageGate(root(''), 'storyboard')).toBeNull();
  });
});
