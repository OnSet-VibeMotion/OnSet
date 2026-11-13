/**
 * 对照测试：没有流程记录的老项目（口播、卡点、歌曲各一，三种画幅），「片型成为一等概念」前后
 * runPrompt 的输出、制作路线与镜头指纹逐字节不变。
 * 金样（testdata/legacy-flow-golden.json）是改动之前的代码写下的；AM_UPDATE_GOLDEN=1 时重写（只在确实要改行为时用）。
 */
import '../studio/testsupport';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as flow from '../flow';
import { defaultStyle } from '../preset';
import * as projectinit from '../projectinit';
import * as scene from '../scene';
import { computeStations } from '../studio/progress';
import { discoverScenes } from '../studio/scenes';
import { runPrompt } from './runprompt';

const goldenFile = path.join(__dirname, 'testdata', 'legacy-flow-golden.json');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const rule = (r: flow.PathRule) => ({ path: r.path, prefix: r.prefix, base: r.base?.source });

/** 按老版本的样子建项目：新建项目的文件，去掉流程记录（老项目没有它）。 */
export function legacyProject(delivery: string, canvas: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-legacy-flow-')));
  temps.push(root);
  projectinit.create({ target: root, canvas, style: defaultStyle(), delivery, narration: projectinit.NarrationSolo });
  fs.rmSync(path.join(root, flow.LockFile), { force: true });
  const dir = path.join(root, 'scenes', 'scene-001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scene.json'), '{"id":"scene-001","duration_seconds":3.000000,"output":"out.mp4","transcript":"transcription.srt","text":"你好"}\n');
  fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\n你好\n');
  return root;
}

function collect(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const delivery of ['speech', 'beat', 'song']) {
    for (const canvas of ['vertical-3x4', 'vertical-9x16', 'landscape-16x9']) {
      const root = legacyProject(delivery, canvas);
      const got = runPrompt(root, '');
      out[`prompt:${delivery}:${canvas}`] = { sha256: sha(got.prompt), bytes: got.prompt.length, file: path.relative(root, got.path) };
      if (canvas !== 'vertical-3x4') continue;
      const extras = flow.projectExtras(root);
      const id = flow.detectFlow(root, extras);
      out[`route:${delivery}`] = { flow: id, stops: flow.route(id, extras).map(({ station, node }) => ({ station, ...node, produces: node.produces?.map(rule) })) };
      const st = computeStations(root, discoverScenes(root));
      out[`progress:${delivery}`] = { mode: st.mode, current: st.current, waiting_on: st.waiting_on, stations: st.stations.map((s) => [s.id, s.status, s.step, s.page ?? '']) };
      const dir = path.join(root, 'scenes', 'scene-001');
      const s = scene.load(dir);
      // 卡点项目的镜头没有 beat 块时拒绝计算（报错原文也钉住）。
      try {
        const inputs = scene.fingerprint(s, 'claude', scene.resolveAllSkills('claude', dir, {}));
        out[`fingerprint:${delivery}`] = { fingerprint: inputs.fingerprint, parts: inputs.parts ?? {} };
      } catch (err) {
        out[`fingerprint:${delivery}`] = { error: (err as Error).message };
      }
    }
  }
  return JSON.parse(JSON.stringify(out));
}

describe('projects without a flow record keep their prompt, route and fingerprints', () => {
  it('matches the golden output recorded before flows became first-class', () => {
    const got = collect();
    if (process.env.AM_UPDATE_GOLDEN === '1') {
      fs.writeFileSync(goldenFile, JSON.stringify(got, null, 2) + '\n');
      return;
    }
    const want = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const key of Object.keys(want)) expect(got[key], key).toEqual(want[key]);
  });
});
