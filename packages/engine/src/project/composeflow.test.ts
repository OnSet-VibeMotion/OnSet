/**
 * 运行期按流程组合制作提示词（flow.composeFlowPrompt）的对照与内容门禁。
 *
 * 「切对了」的证明：口播流程运行期组合的结果，与签入的 assets/presets/<画幅>/PROMPT-PRODUCTION.md
 * 经老路径 runPrompt（插件标记、正则插入、末尾追加）处理后的结果逐字节相同——每个画幅、内置插件开与关、
 * 加了第三方站（阶段补充与说明）都各断言一次。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as assets from '../assets';
import * as flow from '../flow';
import * as preset from '../preset';
import * as projectinit from '../projectinit';
import * as scene from '../scene';
import { substituteCanvas } from '../preset/gen/gen';
import * as song from '../song';
import { skillTreeRoot } from './testsupport';
import { legacyRunPrompt, promptSource, runPrompt } from './runprompt';

const fake = path.join(__dirname, '..', 'flow', 'testdata', 'fake-publisher');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempProject(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-compose-')));
  temps.push(root);
  return root;
}

/** 老路径：项目里只有签入的那份 PROMPT-PRODUCTION.md（没有流程记录）。 */
function legacy(root: string, canvas: string): string {
  fs.copyFileSync(path.join(assets.assetsBase(), 'assets', 'presets', canvas, 'PROMPT-PRODUCTION.md'), path.join(root, 'PROMPT-PRODUCTION.md'));
  return runPrompt(root, '').prompt.toString('utf8');
}

function composed(root: string, id: string, canvas: string): string {
  const p = preset.byID(canvas)!;
  const loaded = flow.loadProjectStations(root);
  expect(loaded.problems).toEqual([]);
  return flow.composeFlowPrompt({ flow: id, stations: loaded.stations, disabled: new Set(flow.disabledPluginStations(root)), canvas: (t) => substituteCanvas(p, t) });
}

const canvases = preset.all().map((p) => p.id);

describe('speech flow composed at run time', () => {
  for (const canvas of canvases) {
    it(`equals the committed PROMPT-PRODUCTION.md through runPrompt (${canvas})`, () => {
      const root = tempProject();
      expect(composed(root, 'speech', canvas)).toBe(legacy(root, canvas));
    });
  }

  it('equals it with the song explainer turned off', () => {
    const root = tempProject();
    flow.setBuiltinEnabled(root, 'song', false);
    const got = composed(root, 'speech', 'vertical-3x4');
    expect(got).not.toContain('歌曲讲解分支');
    expect(got).toBe(legacy(root, 'vertical-3x4'));
  });

  // 老路径关掉发布时编号是生成时写死的，会跳一格（第十一阶段之后是第十三阶段）；运行期组合时发布的段落不参与，编号连续。
  // 除了编号，其余逐字节与老路径相同。
  it('keeps the stage numbers continuous when publishing is off, and is otherwise the same text', () => {
    for (const off of [['publishing'], ['publishing', 'song']]) {
      const root = tempProject();
      for (const id of off) flow.setBuiltinEnabled(root, id, false);
      const got = composed(root, 'speech', 'vertical-3x4');
      const old = legacy(root, 'vertical-3x4');
      expect(old).toContain('## 第十三阶段：项目收尾与归档');
      expect(got).toContain('## 第十一阶段：最终验收、试听与交付');
      expect(got).toContain('## 第十二阶段：项目收尾与归档');
      expect(got).not.toContain('刷新发布配置');
      expect(got).not.toContain('第十三阶段');
      expect(got, off.join(',')).toBe(old.replaceAll('第十三阶段', '第十二阶段'));
    }
  });

  it('equals it with a third-party station that inserts into a stage and adds a note', () => {
    const root = tempProject();
    flow.addToProject(root, flow.fetchStation(`link:${fake}`, process.env).entry);
    const got = composed(root, 'speech', 'landscape-16x9');
    expect(got).toContain('### 第三方站「假发布」的补充');
    expect(got).toContain('## 第三方站：假发布');
    expect(got).toBe(legacy(root, 'landscape-16x9'));
  });
});

/** 编排工具看到的提示词的公共门禁（与 boundary.test.ts 对签入文件的检查相同）。 */
function boundaryProblems(text: string): string[] {
  const problems: string[] = [];
  if (text.includes('./am')) problems.push('引用了 ./am');
  if (text.toLowerCase().split(skillTreeRoot).join('').includes('agent')) problems.push('暴露了执行者身份');
  if (text.includes('{{')) problems.push('留着没替换的占位符');
  return problems;
}

describe('beat flow composed at run time', () => {
  const body = composed(tempProject(), 'beat', 'vertical-9x16');
  const has = (wants: string[]) => {
    for (const want of wants) expect(body.includes(want), `缺少 ${want}`).toBe(true);
  };

  it('has no script, TTS or alignment stage and no "skip these stages" note', () => {
    for (const gone of ['整理口播稿和开场', 'TTS 和断句校对', '依据实际语音重建 SRT', '## 卡点分支', '若项目根存在 beat.yaml', '不做，改为下面的顺序', '歌曲讲解分支']) {
      expect(body.includes(gone), `不应包含 ${gone}`).toBe(false);
    }
  });

  it('numbers its own stages in order', () => {
    const stages = [...body.matchAll(/^## 第([一二三四五六七八九十]+)阶段：(.+)$/gm)].map((m) => m[2]);
    expect(stages).toEqual([
      '盘点输入和制作规格',
      '故事、音乐与节拍',
      '按语义拆分镜头',
      '建立镜头目录、并发调度渲染工具',
      '首帧封面和视觉验收',
      '规范化和拼接静音母版',
      '选择 BGM 和 SFX',
      '配音优先的声音混合',
      '最终验收、试听与交付',
      '刷新发布配置',
      '项目收尾与归档',
    ]);
    // 整片风格那一段的「稿件审核关卡」指向卡点自己的第二阶段。
    expect(body).toContain('在第二阶段的稿件审核关卡一并给出建议');
  });

  // gen.test.ts「tells the beat story before the music」与「stops for storyboard review before rendering」对这份结果成立
  // （卡点的几段不再是文末的「卡点分支」，而是第二阶段「故事、音乐与节拍」）。
  it('tells the beat story before the music', () => {
    has(['：故事、音乐与节拍', '这是一部没有配音、画面踩着音乐节拍走的片子。', 'production/beat/story.md', '画面里的字与字幕就是这部片子的文案', 'studio_show({"page": "beat"', '用户没有点头之前不进入分镜计划', '不得替用户确认', 'beat_cues({"scenes": "scenes/"})', '「音乐卡点」', '不要自己建 Python 环境、不要 pip install']);
    expect(body.indexOf('### 故事与文案')).toBeLessThan(body.indexOf('### 音乐与节拍网格'));
    expect(body.indexOf('### 音乐与节拍网格')).toBeLessThan(body.indexOf('### 分镜计划与镜头'));
  });

  it('stops for storyboard review before rendering', () => {
    has(['### 分镜审核关卡', 'studio_show({"page": "storyboard"', '用户没有点头之前不渲染', '包括代表性镜头的试渲染', '同样过第四阶段的「分镜审核关卡」']);
    expect(body.indexOf('### 分镜审核关卡')).toBeLessThan(body.indexOf('用 `scene_run_all({"scenes": "scenes/", "srt"'));
  });

  it('keeps the orchestrator out of am internals and uses the installed tools', () => {
    has(['不要用 `which`、`strings`、`grep` 去找、去读 `am` 程序本身', '节拍页把这个文件当普通 Markdown 原样显示', 'am 工具服务（MCP）里的工具', '`job_wait`', '`am` 不在终端里']);
    expect(boundaryProblems(body)).toEqual([]);
  });

  it('drops the publish stage and keeps numbering continuous when publishing is off', () => {
    const root = tempProject();
    flow.setBuiltinEnabled(root, 'publishing', false);
    const text = composed(root, 'beat', 'vertical-3x4');
    expect(text).not.toContain('刷新发布配置');
    expect(text).toContain('## 第十阶段：项目收尾与归档');
  });
});

describe('song flow composed at run time', () => {
  it('equals what an untouched song project got from runPrompt', () => {
    const root = tempProject();
    fs.writeFileSync(path.join(root, 'song.yaml'), song.DefaultConfig);
    fs.copyFileSync(path.join(assets.assetsBase(), 'assets', 'shared', 'PROMPT-SONG.md'), path.join(root, 'PROMPT-SONG.md'));
    const want = runPrompt(root, '').prompt.toString('utf8');
    expect(composed(root, 'song', 'vertical-3x4')).toBe(want);
  });

  it('carries the song contract and passes the prompt boundary', () => {
    const body = composed(tempProject(), 'song', 'vertical-3x4');
    for (const want of ['# 单人歌曲讲解制作', '歌曲模式必要契约（优先于口播规程）', '不得代替用户选择', '`am` 不在终端里']) expect(body).toContain(want);
    expect(body).not.toMatch(/第[一二三四五六七八九十]+阶段/);
    expect(body.includes('./am')).toBe(false);
    expect(body.toLowerCase().split(skillTreeRoot).join('').includes('agent')).toBe(false);
  });
});

describe('third-party flow reuses builtin station sections', () => {
  it('takes the shared preamble, the builtin stations it names and its own prompt', () => {
    const root = tempProject();
    flow.addToProject(root, flow.fetchStation(`link:${fake}`, process.env).entry);
    flow.setProjectFlow(root, 'fake-publisher');
    const body = composed(root, 'x:fake-publisher', 'vertical-3x4');
    // 假发布插件的流程：intake、render、assemble、review、本站。
    const stages = [...body.matchAll(/^## (第[一二三四五六七八九十]+阶段：.+|这部片子的流程：.+)$/gm)].map((m) => m[1]);
    expect(stages).toEqual(['第一阶段：盘点输入和制作规格', '第二阶段：建立镜头目录、并发调度渲染工具', '第三阶段：规范化和拼接静音母版', '第四阶段：最终验收、试听与交付', '这部片子的流程：快剪']);
    expect(body.startsWith('# 完成一次从稿件到成片的竖屏 MG 视频制作')).toBe(true);
    // 内置站的段落引用了这套流程没有的阶段：写成那一步的标题。
    expect(body).toContain('「配音优先的声音混合」那一步');
    // 本站的阶段补充插在渲染那一阶段的末尾。
    const insert = body.indexOf('### 第三方站「假发布」的补充');
    expect(insert).toBeGreaterThan(body.indexOf('## 第二阶段：建立镜头目录'));
    expect(insert).toBeLessThan(body.indexOf('## 第三阶段'));
    expect(body.includes('{{')).toBe(false);
  });
});

describe('projects that record their flow', () => {
  function created(delivery: string, canvas = 'vertical-3x4'): string {
    const root = tempProject();
    projectinit.create({ target: root, canvas, style: preset.defaultStyle(), delivery, narration: projectinit.NarrationSolo });
    return root;
  }

  it('records the flow, compose version, canvas and the digest of the shipped prompt file', () => {
    for (const [delivery, file] of [
      ['speech', 'PROMPT-PRODUCTION.md'],
      ['beat', 'PROMPT-PRODUCTION.md'],
      ['song', 'PROMPT-SONG.md'],
    ]) {
      const root = created(delivery, 'vertical-9x16');
      const rec = flow.flowRecord(root)!;
      expect(rec.id).toBe(delivery);
      expect(rec.compose).toBe(flow.ComposeVersion);
      expect(rec.canvas).toBe('vertical-9x16');
      expect(rec.prompt_sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'));
      expect(flow.detectFlow(root, flow.projectExtras(root))).toBe(delivery);
      expect(promptSource(root)).toBe('composed');
    }
  });

  it('composes the prompt of its own flow', () => {
    for (const canvas of canvases) {
      const speech = created('speech', canvas);
      const got = runPrompt(speech, '');
      expect(got.composed).toBe(true);
      expect(path.basename(got.path)).toBe('PROMPT-PRODUCTION.md');
      // 新建的口播项目：与同一份文件走老路径的结果逐字节相同。
      expect(got.prompt.toString('utf8')).toBe(legacyRunPrompt(speech, '').prompt.toString('utf8'));
    }
    const beat = runPrompt(created('beat'), '');
    expect(beat.composed).toBe(true);
    expect(beat.prompt.toString('utf8')).toContain('## 第二阶段：故事、音乐与节拍');
    expect(beat.prompt.toString('utf8')).not.toContain('## 卡点分支');
    const songRoot = created('song');
    const sung = runPrompt(songRoot, '');
    expect(sung.composed).toBe(true);
    expect(path.basename(sung.path)).toBe('PROMPT-SONG.md');
    expect(sung.prompt.toString('utf8')).toBe(legacyRunPrompt(songRoot, '').prompt.toString('utf8'));
  });

  it('uses the project file when the user changed it, and tells so', () => {
    const root = created('beat');
    fs.appendFileSync(path.join(root, 'PROMPT-PRODUCTION.md'), '\n我自己加的一条。\n');
    expect(promptSource(root)).toBe('custom');
    const got = runPrompt(root, '');
    expect(got.composed).toBeFalsy();
    expect(got.prompt.toString('utf8')).toContain('我自己加的一条。');
    expect(got.prompt.toString('utf8')).toBe(legacyRunPrompt(root, '').prompt.toString('utf8'));
  });

  it('composes even without the optional prompt file, and keeps the old rules for overrides and finished transcripts', () => {
    const root = created('speech');
    const before = runPrompt(root, '').prompt.toString('utf8');
    fs.rmSync(path.join(root, 'PROMPT-PRODUCTION.md'));
    expect(runPrompt(root, '').prompt.toString('utf8')).toBe(before);
    const custom = path.join(root, 'custom.md');
    fs.writeFileSync(custom, 'CUSTOM');
    expect(runPrompt(root, custom).prompt.toString('utf8')).toBe('CUSTOM');
    fs.writeFileSync(path.join(root, 'transcription.srt'), '1\n');
    expect(promptSource(root)).toBe('legacy');
    expect(runPrompt(root, '').path).toBe(path.join(root, 'PROMPT.md'));
  });

  it('keeps the route of song projects on the speech route', () => {
    const root = created('song');
    const extras = flow.projectExtras(root);
    expect(flow.route('song', extras)).toEqual(flow.route('speech', extras));
  });

  it('leaves scene fingerprints exactly as in projects without the record', () => {
    const fingerprint = (root: string) => {
      const dir = path.join(root, 'scenes', 'scene-001');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'scene.json'), '{"id":"scene-001","duration_seconds":3.000000,"output":"out.mp4","transcript":"transcription.srt","text":"你好"}\n');
      fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\n你好\n');
      const s = scene.load(dir);
      return scene.fingerprint(s, 'claude', scene.resolveAllSkills('claude', dir, {}));
    };
    const withRecord = created('speech');
    const without = created('speech');
    fs.rmSync(path.join(without, flow.LockFile));
    const a = fingerprint(withRecord);
    const b = fingerprint(without);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.parts).toEqual(b.parts);
  });
});
