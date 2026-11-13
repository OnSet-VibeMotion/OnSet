// /api/state 的 flow：界面按流程声明排顶栏，不按片型写死。
import './testsupport';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as flow from '../flow';
import * as preset from '../preset';
import * as projectinit from '../projectinit';
import { flowView } from './progress';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
/** 一个记下了流程的项目目录（id 为空时不写记录）。 */
function root(id = 'speech'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-flowview-')));
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

  it('puts the first page of a third-party flow first and keeps the base flow pages', () => {
    const dir = root('beat');
    flow.addToProject(dir, flow.fetchStation(`link:${path.join(__dirname, '..', 'flow', 'testdata', 'fake-publisher')}`, process.env).entry);
    flow.setProjectFlow(dir, 'fake-publisher');
    const v = flowView(dir);
    expect(v.id).toBe('x:fake-publisher');
    expect(v.steps[0]).toBe('x:fake-publisher:dashboard');
    expect(v.hidden_pages).toEqual(['script']);
    expect(v.land_page).toBe('beat');
    expect(v.first_steps).toEqual(['x:fake-publisher:dashboard', 'script', 'beat']);
  });
});

describe('directories without a flow record', () => {
  it('have no flow view, no progress route and say why', async () => {
    const { readProgress } = await import('./progress');
    const dir = root('');
    // 标记文件不再决定流程。
    fs.writeFileSync(path.join(dir, 'beat.yaml'), 'schema: 1\n');
    expect(() => flowView(dir)).toThrow(flow.MissingFlowRecordError);
    expect(() => readProgress(dir)).toThrow('不是用这一版 ArticleToMotion 新建的项目');
  });
});
