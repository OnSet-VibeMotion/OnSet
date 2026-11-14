import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import * as assets from '../assets';
import { problems, scan } from '../determinism';
import { skillTreeRoot } from './testsupport';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** exampleFontFiles 读出示例 @font-face 引用的 assets/fonts/ 下的文件名。 */
function exampleFontFiles(shared: assets.AssetTree, file: string): string[] {
  const body = shared.readText(file);
  return [...body.matchAll(/assets\/fonts\/([\w.-]+\.woff2)/g)].map((m) => m[1]);
}

describe('scene-kit', () => {
  function textKit(start: number | null = 100) {
    const win: Record<string, unknown> = { ONSET_SCENE: { schema: 1, scene_id: 'scene-001', fps: 30, frames: 90, start_frame: start,
      phrases: [{ phrase_id: 'p1', text: '顺序', start_frame: 10, end_frame_exclusive: 45 }] } };
    vm.runInNewContext(assets.shared().readText(`${skillTreeRoot}/scene-kit/scene-kit.js`), { window: win });
    return win.SceneKit as { phraseText: (element: unknown, id: string, options?: Record<string, unknown>) => {
      render: (frame: number) => void; event: (coordinates?: {global: boolean}) => Record<string, unknown>;
    } };
  }

  it('keeps every text layer hidden before its phrase, including backward seeks, and exports one coordinate conversion', () => {
    const kit = textKit();
    const nodes = [0, 1].map((i) => ({ id: `line-${i}`, tagName: 'DIV', style: {} as Record<string,string>, textContent: '' }));
    const labels = nodes.map((node) => kit.phraseText(node, 'p1', { readableStartFrame: 15, endFrame: 60 }));
    expect(nodes.map(n => n.style.visibility)).toEqual(['hidden', 'hidden']);
    for (const frame of [0, 9, 10, 59, 0, 60, 10]) {
      labels.forEach(label => label.render(frame));
      expect(nodes.map(n => n.style.visibility)).toEqual([frame >= 10 && frame < 60 ? 'visible' : 'hidden'].flatMap(v => [v,v]));
    }
    expect(labels[0].event()).toMatchObject({ text: '顺序', phrase_id: 'p1', enter_frame: 10, readable_start_frame: 15, readable_end_frame_exclusive: 60 });
    expect(labels[0].event({global:true})).toMatchObject({ enter_frame: 110, readable_start_frame: 115, exit_end_frame: 160 });
    expect(labels[0].event().enter_frame).toBe(10);
    expect(() => textKit(null).phraseText(nodes[0], 'p1').event({global:true})).toThrow('缺少 start_frame');
  });

  it('clears a dedicated canvas even when seeking before the phrase and never draws outside its window', () => {
    const drawn: number[] = [], cleared: unknown[][] = [];
    const context = { save() {}, restore() {}, setTransform() {}, clearRect(...args: unknown[]) { cleared.push(args); } };
    const node = { id: 'canvas-label', tagName: 'CANVAS', style: {} as Record<string,string>, width: 300, height: 100, getContext: () => context };
    const label = textKit().phraseText(node, 'p1', { endFrame: 50, draw: (frame: number) => drawn.push(frame) });
    for (const frame of [0, 10, 49, 9, 50]) label.render(frame);
    expect(drawn).toEqual([10, 49]);
    expect(cleared).toHaveLength(5);
    expect(cleared.every(args => args.join(',') === '0,0,300,100')).toBe(true);
    expect(node.style.visibility).toBe('hidden');
    expect(() => textKit().phraseText(node, 'p1')).toThrow('独占图层');
  });

  it('rejects invented bindings, decorative text and windows outside the frozen scene', () => {
    const kit = textKit(), node = { id:'text', tagName:'DIV', style:{}, textContent:'' };
    expect(() => kit.phraseText(node, 'invented')).toThrow('没有短语');
    expect(() => kit.phraseText(node, 'p1', {role:'decorative'})).toThrow('不能标为 decorative');
    for (const options of [{enterFrame:9}, {endFrame:91}, {readableStartFrame:60,endFrame:60}]) {
      expect(() => kit.phraseText(node, 'p1', options)).toThrow('须满足');
    }
  });

  it('exports captions from the actual layout windows and line text instead of another hand-copied timeline', () => {
    const element = () => ({ style: {}, className: '', textContent: '', appendChild() {}, setAttribute() {} });
    const win: Record<string, unknown> = { ONSET_SCENE: { schema: 1, scene_id: 'fixture', fps: 30, frames: 90, start_frame: 100,
      width_px: 800, height_px: 600, safe_area: {subtitles:{left_px:20,top_px:400,right_px:20,bottom_px:30}},
      subtitles: {font_size_px:{min:24,max:24},max_lines:2}, cues:[{index:4,text:'早一点',start_frame:10,end_frame_exclusive:30}],phrases:[] },
      document: {createElement:element} };
    vm.runInNewContext(assets.shared().readText(`${skillTreeRoot}/scene-kit/scene-kit.js`), {window:win});
    const kit=win.SceneKit as {captions:(root:unknown,options:unknown)=>{layouts:{lines:string[]}[];events:(coordinates?:{global:boolean})=>Record<string,unknown>[]}};
    const captions=kit.captions({appendChild() {},ownerDocument:win.document},{leadFrames:3,tailFrames:4});
    expect(captions.events()).toMatchObject([{event_id:'subtitle-4',role:'subtitle',text:'早一点',readable_start_frame:7,readable_end_frame_exclusive:34}]);
    expect(captions.events({global:true})).toMatchObject([{readable_start_frame:107,readable_end_frame_exclusive:134}]);
    captions.layouts[0].lines=['早','一点'];
    expect(captions.events()[0].text).toBe('早\n一点');
  });

  // HyperFrames lint 的 gsap_timeline_not_registered 逐个脚本按正则查（0.8.225 实测）：脚本里出现 gsap 紧跟 .timeline，
  // 又没有 window.__timelines 赋值，就判「建了时间线却没注册」。scene-kit.js 被复制进每个镜头目录、作为单独的
  // <script> 加载，它的注释或报错文案里只要写了这串字，所有用 scene-kit 的镜头都报这条错，渲染器自己修不掉，
  // 只能去翻 HyperFrames 的源码（实测）。
  it('does not trip HyperFrames lint as a separate script', () => {
    const body = assets.shared().readText(`${skillTreeRoot}/scene-kit/scene-kit.js`);
    expect(/gsap\.timeline/.test(body)).toBe(false);
  });

  // 把 scene-kit 放进一个照技能说明搭起来的镜头目录，跑一遍 onset 自己的确定性源码扫描。
  //
  // 技能要求渲染器把 scene-kit.js 复制进每个镜头目录，所以它会被每个镜头的
  // 扫描读到。库里一旦混进时钟、未播种随机数或定时器，所有用它的镜头都会被
  // 判失败——必须在这里先炸，而不是在用户的渲染里。example.html 是 SKILL.md
  // 指定的写法参考，照着抄的镜头也必须能过同一道门。
  it('passes determinism scan', () => {
    const shared = assets.shared();
    const skill = `${skillTreeRoot}/scene-kit/`;
    const sceneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-project-'));
    temps.push(sceneDir);
    const copies: Record<string, string> = {
      [skill + 'scene-kit.js']: 'scene-kit.js',
      [skill + 'example.html']: 'index.html',
    };
    for (const [from, to] of Object.entries(copies)) fs.writeFileSync(path.join(sceneDir, to), shared.readFile(from));
    // 示例引用的字体按技能说明随镜头目录提供；缺了它，扫描会如实报字体文件缺失。
    const fonts = path.join(sceneDir, 'assets', 'fonts');
    fs.mkdirSync(fonts, { recursive: true });
    for (const name of exampleFontFiles(shared, skill + 'example.html')) fs.writeFileSync(path.join(fonts, name), 'woff2');
    // onset-scene.js 由 onset 在渲染前生成，这里只放一个占位，让引用能解析到本地文件。
    fs.writeFileSync(path.join(sceneDir, 'onset-scene.js'), 'window.ONSET_SCENE = {schema: 1};\n');

    const report = scan(sceneDir);
    expect(report.ok, `scene-kit 没通过确定性扫描：\n${problems(report).join('\n')}`).toBe(true);
    expect(
      report.files.includes('scene-kit.js'),
      `扫描没有读到 scene-kit.js（可能被当成第三方库跳过）：files=${report.files} skipped=${report.skipped ?? []}`,
    ).toBe(true);
    expect(report.allowed ?? [], 'scene-kit 不应依赖逐行豁免').toEqual([]);
  });

  // frame.md 的字幕规范只有版式：配色由镜头自己定。没给配色时文字跟随整片配色的 ink，没有底框；镜头给了就用镜头的。
  it('captions take layout from frame.md and colours from the scene', () => {
    const frame = assets.canvas('vertical-9x16').readText('frame.md');
    const front = YAML.parse(frame.split('\n---\n')[0].replace(/^---\n/, '')) as { safe_area: unknown; subtitles: Record<string, unknown> };
    for (const key of ['background', 'text_color', 'padding_px', 'radius_px']) expect(front.subtitles, key).not.toHaveProperty(key);
    const safe = { left_px: 60, top_px: 1500, right_px: 60, bottom_px: 200 };
    const run = (look: unknown, options: Record<string, unknown> = {}) => {
      const made: { style: Record<string, string>; className: string }[] = [];
      const el = () => {
        const node = { style: {} as Record<string, string>, className: '', textContent: '', appendChild: () => undefined, setAttribute: () => undefined };
        made.push(node);
        return node;
      };
      const win: Record<string, unknown> = {
        ONSET_SCENE: { schema: 1, fps: 30, frames: 60, width_px: 1080, height_px: 1920, safe_area: { subtitles: safe }, subtitles: front.subtitles, cues: [{ index: 1, text: '你好', start_frame: 0, end_frame_exclusive: 30 }], phrases: [], ...(look ? { look } : {}) },
      };
      win.document = { createElement: el };
      vm.runInNewContext(assets.shared().readText(`${skillTreeRoot}/scene-kit/scene-kit.js`), { window: win });
      const kit = win.SceneKit as { captions: (root: unknown, o: unknown) => { render: (f: number) => unknown } };
      kit.captions({ appendChild: () => undefined, ownerDocument: win.document }, options).render(0);
      return made.find((n) => n.className === 'scene-kit-caption')!.style;
    };
    const plain = run(null);
    expect(plain.background).toBe('transparent');
    expect(plain.color).toBeUndefined();
    expect(plain.borderRadius).toBe('0px');
    expect(run({ background: '#000000', ink: '#F5F1E8', accent: '#F2B134' }).color).toBe('#F5F1E8');
    const own = run({ ink: '#F5F1E8' }, { color: '#111111', background: 'rgba(255, 255, 255, 0.8)', padding: { vertical: 10, horizontal: 20 }, radius: 8 });
    expect(own).toMatchObject({ color: '#111111', background: 'rgba(255, 255, 255, 0.8)', padding: '10px 20px', borderRadius: '8px' });
  });
});
