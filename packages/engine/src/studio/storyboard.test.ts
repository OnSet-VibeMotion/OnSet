import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readStoryboard } from './storyboard';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-storyboard-')));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

const plan = {
  schema: 1,
  look: { background: '#0F1720', ink: '#F5F1E8', accent: '#F2B134' },
  scenes: [
    { id: 'scene-001', dir: 'scenes/scene-001', chapter: '问题', visual_role: '语境', summary: '开场提出问题' },
    {
      id: 'scene-002',
      dir: 'scenes/scene-002',
      chapter: '机制',
      first_subtitle: 5,
      visual_role: '机制',
      summary: '计数器开始累加',
      handoff: { device: 'push_in', bridge: '计数器铺满画面' },
    },
  ],
};

const sceneJSON = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, duration_seconds: 1, output: `render-${id}.mp4`, transcript: 'transcription.srt', text: `${id} 的口播`, ...extra });

describe('readStoryboard', () => {
  it('lists the plan with each scene’s text, timing and prompt', () => {
    const root = project({
      'production/scene-plan.json': JSON.stringify(plan),
      'production/scene-plan.md': '# 分镜',
      'production/treatment.md': '# 处理方案\n\n主旨：一句话。',
      'scenes/scene-001/scene.json': sceneJSON('scene-001', { duration_seconds: 4.5, timing: { start_frame: 0 } }),
      'scenes/scene-001/prompt.md': '# 开场\n\n画一个问号。',
      'scenes/scene-001/render-scene-001.mp4': 'x',
      'scenes/scene-002/scene.json': sceneJSON('scene-002'),
    });
    const out = readStoryboard(root);
    expect(out.plan_path).toBe('production/scene-plan.json');
    expect(out.parse_error).toBeUndefined();
    expect(out.look).toEqual({ background: '#0F1720', ink: '#F5F1E8', accent: '#F2B134' });
    expect(out.treatment?.content).toContain('主旨');
    expect(out.doc_path).toBe('production/scene-plan.md');
    expect(out.scenes.map((s) => s.id)).toEqual(['scene-001', 'scene-002']);

    const [first, second] = out.scenes;
    expect(first).toMatchObject({ chapter: '问题', visual_role: '语境', summary: '开场提出问题', text: 'scene-001 的口播', seconds: 4.5, created: true, rendered: true });
    expect(first.prompt).toEqual({ path: 'scenes/scene-001/prompt.md', content: '# 开场\n\n画一个问号。' });
    expect(first.anchor).toBeUndefined();

    // 占位时长（cues 还没跑）不当真；没有 prompt.md 就不给。
    expect(second.seconds).toBeUndefined();
    expect(second.prompt).toBeUndefined();
    expect(second.rendered).toBe(false);
    expect(second.anchor).toBe('第 5 条字幕');
    expect(second.handoff).toEqual({ device: 'push_in', device_label: '推进穿越', bridge: '计数器铺满画面' });
  });

  it('marks planned scenes whose directory is not created yet', () => {
    const root = project({ 'production/scene-plan.json': JSON.stringify(plan) });
    const out = readStoryboard(root);
    expect(out.scenes.map((s) => [s.id, s.created])).toEqual([
      ['scene-001', false],
      ['scene-002', false],
    ]);
  });

  it('falls back to scene directories when the plan is broken or missing', () => {
    const root = project({
      'production/scene-plan.json': '{"schema": 1, "scenes": [], "extra": 1}',
      'scenes/scene-001/scene.json': sceneJSON('scene-001'),
      'scenes/scene-001/prompt.md': '画面',
    });
    const out = readStoryboard(root);
    expect(out.parse_error).toBeTruthy();
    expect(out.scenes).toHaveLength(1);
    expect(out.scenes[0]).toMatchObject({ id: 'scene-001', dir: 'scenes/scene-001', text: 'scene-001 的口播', created: true });
    expect(out.scenes[0].prompt?.content).toBe('画面');

    const empty = readStoryboard(project({}));
    expect(empty).toEqual({ plan_path: '', installed_styles: [], scenes: [] });
  });

  it('does not read outside the project when the plan points there', () => {
    const outside = project({ 'scenes/x/prompt.md': '项目外' });
    const root = project({
      'production/scene-plan.json': JSON.stringify({ schema: 1, scenes: [{ id: 'scene-001', dir: path.relative('/', outside) + '/../../' + path.basename(outside) + '/scenes/x' }, { id: 'scene-002', dir: '../' + path.basename(outside) + '/scenes/x', first_subtitle: 2 }] }),
    });
    const out = readStoryboard(root);
    expect(out.parse_error).toBeUndefined();
    for (const sc of out.scenes) expect(sc.prompt).toBeUndefined();
  });

  it('resolves each scene’s film style and leaves boundaries visible', () => {
    const manifest = (source: string, slug: string, cn: string) => JSON.stringify({ source, slug, cn, en: slug, version: '1', digest: 'x', installed_at: '' });
    const root = project({
      '.agents/skills/onset-film-style/onset-film-style.json': manifest('lemo-opuscar', 'watercolor', '水彩'),
      '.agents/onset-film-styles/lemo-opuscar/ink-wash/onset-film-style.json': manifest('lemo-opuscar', 'ink-wash', '水墨'),
      'production/scene-plan.json': JSON.stringify({
        schema: 1,
        scenes: [
          { id: 'scene-001', dir: 'scenes/scene-001' },
          { id: 'scene-002', dir: 'scenes/scene-002', first_subtitle: 2, film_style: 'lemo-opuscar/ink-wash', handoff: { device: 'carry', bridge: '墨滴', style_shift: 'morph' } },
          { id: 'scene-003', dir: 'scenes/scene-003', first_subtitle: 3, film_style: 'none' },
          { id: 'scene-004', dir: 'scenes/scene-004', first_subtitle: 4, film_style: 'lemo-opuscar/crayon-book' },
        ],
      }),
    });
    const out = readStoryboard(root);
    expect(out.parse_error).toBeUndefined();
    expect(out.default_style).toMatchObject({ key: 'lemo-opuscar/watercolor', cn: '水彩' });
    expect(out.installed_styles.sort()).toEqual(['lemo-opuscar/ink-wash', 'lemo-opuscar/watercolor']);
    expect(out.scenes.map((s) => [s.style.kind, s.style.key, !!s.style.missing])).toEqual([
      ['default', 'lemo-opuscar/watercolor', false],
      ['named', 'lemo-opuscar/ink-wash', false],
      ['none', '', false],
      ['named', 'lemo-opuscar/crayon-book', true],
    ]);
    expect(out.scenes[1].style.cn).toBe('水墨');
    expect(out.scenes[1].handoff?.style_shift).toBe('morph');

    // 没有默认风格时，不写风格的镜头自主定视觉；没有分镜计划时读镜头自己的 scene.json。
    const bare = readStoryboard(project({ 'scenes/scene-001/scene.json': sceneJSON('scene-001', { film_style: 'none' }), 'scenes/scene-002/scene.json': sceneJSON('scene-002') }));
    expect(bare.default_style).toBeUndefined();
    expect(bare.scenes.map((s) => s.style.kind)).toEqual(['none', 'free']);
  });
});
