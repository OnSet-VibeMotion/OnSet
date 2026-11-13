// 镜头扩展块注册表：只在测试里登记一个假块，证明加一种块不用改 scene 的内核文件，
// 解析、写回、load 校验、互斥、渲染前校验、提示词段、指纹与 timing 互斥都会带上它。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { blockValue, registerBlock, type SceneBlock } from './block';
import { optionalFields as indexOptionalFields } from './index';
import { fingerprint } from './record';
import { buildPrompt, load, newScene, optionalFields, sceneToJSON, type Scene } from './scene';
import { frameWithCanvas, tempDir } from './testsupport';
import { verifyTimingInputs } from './timing';
import { VerificationError } from './verification';
import type { StructType } from './jsondecode';

interface Fake {
  note: string;
  weight: number;
}

const fakeType: StructType = {
  kind: 'struct',
  goName: 'fake.Block',
  name: 'Block',
  fields: [
    ['note', 'string'],
    ['weight', 'int'],
  ],
};

function fakeBlock(extra: Partial<SceneBlock<Fake>> = {}): SceneBlock<Fake> {
  return {
    key: 'fake',
    order: 25,
    type: fakeType,
    toJSON: (f) => ({ note: f.note, weight: f.weight || undefined }),
    validate: (_s, f) => {
      if (f.note === '') throw new Error('fake.note 不能为空');
    },
    excludes: { keys: ['cast'], message: '假块不能与 cast 同时出现' },
    verifyInputs: (s) => {
      const f = fake(s);
      if (f !== null && f.note === 'stale') throw new VerificationError(s.output, ['假块过期']);
    },
    promptSection: (s) => `\n假块（强制）：${fake(s)!.note}\n`,
    fingerprintParts: (_s, f) => ({ ['fake:' + f.note]: 'digest-' + f.weight }),
    ...extra,
  };
}

function fake(s: Scene): Fake | null {
  return blockValue(s, 'fake') as Fake | null;
}

function register(block: SceneBlock<Fake>): void {
  onTestFinished(registerBlock(block));
}

function sceneWith(extra: string): string {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\n一句话\n');
  fs.writeFileSync(path.join(dir, 'frame.md'), frameWithCanvas(1080, 1440));
  fs.writeFileSync(
    path.join(dir, 'scene.json'),
    `{"id":"scene-001","duration_seconds":2,"output":"out.mp4","transcript":"transcript.srt","text":"一句话","style_guide":"frame.md"${extra}}`,
  );
  return dir;
}

describe('scene block registry', () => {
  it('registers the builtin blocks through the package entry in their fixed order', () => {
    expect(indexOptionalFields()).toEqual(['style_guide', 'renderer', 'film_style', 'plugin_skills', 'cast', 'song', 'beat', 'timing']);
  });

  it('a registered block goes through load, writeback, prompt and fingerprint', () => {
    const dir = sceneWith(',"fake":{"note":"hello","weight":3}');
    expect(() => load(dir), '未登记时应是未知字段').toThrow('scene.json 含未知字段：fake');
    register(fakeBlock());
    expect(optionalFields()).toEqual(['style_guide', 'renderer', 'film_style', 'plugin_skills', 'cast', 'song', 'fake', 'beat', 'timing']);
    expect(fake(newScene()), '零值镜头上的块是 null').toBeNull();

    const s = load(dir);
    expect(fake(s)).toEqual({ note: 'hello', weight: 3 });
    expect(Object.keys(sceneToJSON(s) as object)).toEqual(['id', 'duration_seconds', 'output', 'transcript', 'text', 'style_guide', 'renderer', 'film_style', 'plugin_skills', 'cast', 'song', 'fake', 'beat', 'timing']);
    expect((sceneToJSON(s) as Record<string, unknown>).fake).toEqual({ note: 'hello', weight: 3 });

    const prompt = buildPrompt(s, {});
    expect(prompt).toContain('\n假块（强制）：hello\n');
    expect(prompt.indexOf('假块（强制）'), '块的段落接在视觉自由度段之后').toBeGreaterThan(prompt.indexOf('视觉自由度（强制）'));

    const inputs = fingerprint(s, 'claude', {});
    expect(inputs.parts!['fake:hello']).toBe('digest-3');
    const plain = fingerprint({ ...s, fake: null } as Scene, 'claude', {});
    expect(plain.parts!['fake:hello'], '块缺省时不加指纹项').toBeUndefined();
  });

  it('runs the block checks', () => {
    register(fakeBlock());
    expect(() => load(sceneWith(',"fake":{"note":""}'))).toThrow('fake.note 不能为空');
    expect(() => load(sceneWith(',"fake":{"note":1}'))).toThrow('json: cannot unmarshal number into Go struct field Block.fake.note of type string');

    const stale = load(sceneWith(',"fake":{"note":"stale"}'));
    expect(() => buildPrompt(stale, {})).toThrow('假块过期');

    const s = load(sceneWith(',"fake":{"note":"ok"}'));
    const withCast = { ...s, cast: { pack_dir: 'cast', ground_y: 0.5, on_stage: [], beats: [] } };
    expect(() => buildPrompt(withCast, {})).toThrow('假块不能与 cast 同时出现');
  });

  it('a block with its own timeline excludes the timing block', () => {
    register(fakeBlock({ order: 40, timeline: { label: '假时间轴' } }));
    const s = { ...load(sceneWith(',"fake":{"note":"ok"}')), timing: {} } as Scene;
    expect(() => verifyTimingInputs(s)).toThrow('timing 块不能与 song 或 beat 或 fake 块同时出现：口播、歌曲、卡点、假时间轴的时间轴来源互斥');
  });

  it('rejects a block that clashes with another block or a core field', () => {
    expect(() => registerBlock(fakeBlock({ key: 'cast' }))).toThrow('镜头扩展块重名：cast');
    register(fakeBlock({ key: 'timing' }));
    expect(() => optionalFields()).toThrow('镜头扩展块与 scene.json 的内核字段重名：timing');
  });
});
