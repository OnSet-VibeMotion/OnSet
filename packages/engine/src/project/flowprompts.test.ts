/**
 * 制作提示词只有一条路：按项目记下的流程在开工时组合（project.runPrompt → flow.composeFlowPrompt）。
 *
 * 这里是它的门禁：
 * - 新建的口播、卡点、歌曲项目的 runPrompt 全文摘要与阶段标题序列（testdata/flow-prompts.json，ONSET_UPDATE_GOLDEN=1 时重写）；
 * - 提示词内容的门禁（原先钉在签入的 PROMPT-PRODUCTION.md 上），对适用的每个内置流程的组合结果断言；
 * - 没有流程记录的目录直接报错，不按 beat.yaml / song.yaml 推断；
 * - 内置流程不引用自己没有的阶段（第三方流程才有「<标题>那一步」的退路）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as flow from '../flow';
import * as hyperframes from '../hyperframes';
import * as preset from '../preset';
import * as projectinit from '../projectinit';
import * as scene from '../scene';
import * as song from '../song';
import { composeProjectPrompt, runPrompt } from './runprompt';
import { builtinFlowIDs, composeFor, everyBuiltinPrompt } from './testsupport';

const fake = path.join(__dirname, '..', 'flow', 'testdata', 'fake-publisher');
const goldenFile = path.join(__dirname, 'testdata', 'flow-prompts.json');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempProject(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-flowprompt-')));
  temps.push(root);
  return root;
}

function created(delivery: string, canvas = 'vertical-3x4'): string {
  const root = tempProject();
  projectinit.create({ target: root, canvas, delivery, narration: projectinit.NarrationSolo });
  return root;
}

const stageTitles = (text: string) => [...text.matchAll(/^## (第[一二三四五六七八九十]+阶段：.+)$/gm)].map((m) => m[1]);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('new projects compose the prompt of their own flow', () => {
  it('requires self-review of the current candidate before user review in every flow', () => {
    for (const { text, name: label } of everyBuiltinPrompt()) {
      expect(text, label).toContain('先做完当前成片候选的内部验收，再请用户观看、试听或确认该候选');
      expect(text, label).toContain('候选已交给用户后才发现漏检的问题');
    }
  });

  it('keeps scene implementation with the renderer in every flow', () => {
    for (const { text, name: label } of everyBuiltinPrompt()) {
      expect(text, label).toContain('## 镜头实现的归属');
      for (const rule of [
        '不得创建、编辑或覆盖镜头实现代码',
        '共用模块',
        '修复自己引入的问题',
        'prompt.md',
        'scene_run',
        'scene_run_all',
        'scene_frames({"scene": "<镜头目录>"})',
        '不得用 Chrome DevTools',
        'visible-events.json',
      ]) {
        expect(text, label).toContain(rule);
      }
      for (const old of ['改完合成代码、重渲染前', '修改源工程时间轴并只重渲染', '再做最小源级修改'])
        expect(text, label).not.toContain(old);
    }
  });

  // 每种讲解形式一种画幅：全文摘要与阶段标题序列都钉住。改了提示词段落就要重写金样，并在差异里看清改了什么。
  const cases: [string, string][] = [
    ['speech', 'vertical-3x4'],
    ['beat', 'vertical-9x16'],
    ['song', 'landscape-16x9'],
  ];
  const collect = () => {
    const out: Record<string, { sha256: string; bytes: number; stages: string[] }> = {};
    for (const [delivery, canvas] of cases) {
      const root = created(delivery, canvas);
      const got = runPrompt(root, '');
      const text = got.prompt.toString('utf8');
      expect(got.path).toBe('');
      out[`${delivery}/${canvas}`] = { sha256: sha(text), bytes: got.prompt.length, stages: stageTitles(text) };
    }
    return out;
  };

  it('matches the golden digest and stage titles', () => {
    const got = collect();
    if (process.env.ONSET_UPDATE_GOLDEN === '1') fs.writeFileSync(goldenFile, JSON.stringify(got, null, 2) + '\n');
    expect(got).toEqual(JSON.parse(fs.readFileSync(goldenFile, 'utf8')));
  });

  it('keeps numbering and gates when loading only the requested production stage', () => {
    const root = created('speech', 'vertical-3x4');
    const full = composeProjectPrompt(root).text;
    const focused = composeProjectPrompt(root, 'plan', true).text;
    expect(focused).toContain(stageTitles(full).find((title) => title.includes('拆分镜头'))!);
    expect(focused).toContain('storyboard');
    expect(focused).toContain('flow_guide(');
    expect(focused.length).toBeLessThan(full.length / 2);
    expect(focused).not.toContain('audio_mix()');
    expect(() => composeProjectPrompt(root, 'missing', true)).toThrow(/可用阶段/);
  });

  it('records the flow, the canvas and the render prompt version', () => {
    for (const delivery of ['speech', 'beat', 'song']) {
      const root = created(delivery, 'vertical-9x16');
      expect(flow.flowRecord(root)).toEqual({
        id: delivery,
        canvas: 'vertical-9x16',
        render_prompt: flow.RenderPromptVersion,
      });
      expect(flow.detectFlow(root, flow.stationExtras())).toBe(delivery);
      // 项目里不放任何提示词文件。
      for (const file of ['PROMPT.md', 'PROMPT-PRODUCTION.md', 'PROMPT-SONG.md', 'PROMPT-CAST-ADDENDUM.md'])
        expect(fs.existsSync(path.join(root, file)), file).toBe(false);
    }
  });

  it('keeps the cast instructions referenced by the focused script stage', () => {
    const root = created('speech', 'vertical-3x4');
    expect(composeProjectPrompt(root, 'script', true).text).toContain('## 附：多角色叙事作业规程');
    expect(composeProjectPrompt(root, 'plan', true).text).not.toContain('## 附：多角色叙事作业规程');
  });

  it('labels the composed prompt with the flow name and reads an override as is', () => {
    const root = created('beat');
    expect(runPrompt(root, '').label).toBe('卡点流程');
    const custom = path.join(root, 'custom.md');
    fs.writeFileSync(custom, 'CUSTOM');
    const got = runPrompt(root, custom);
    expect(got.prompt.toString('utf8')).toBe('CUSTOM');
    expect(got.path).toBe(custom);
    expect(() => runPrompt(root, path.join(root, 'missing.md'))).toThrow('找不到 prompt 文件');
  });

  // song.yaml 由歌曲讲解插件经 Flow.check 核对：写坏了在开工组合提示词时就报。
  it('lets the song plugin check song.yaml before composing', () => {
    const root = created('song');
    expect(() => runPrompt(root, '')).not.toThrow();
    fs.writeFileSync(path.join(root, 'song.yaml'), 'provider: [\n');
    expect(() => runPrompt(root, '')).toThrow();
  });

  it('keeps the route of song projects on the speech route', () => {
    const root = created('song');
    const extras = flow.stationExtras();
    expect(flow.detectFlow(root, extras)).toBe('song');
    expect(flow.route('song', extras)).toEqual(flow.route('speech', extras));
  });

  it('switches the flow when song assets are added to the record', () => {
    // 流程只看记录：有 song.yaml 也不会变成歌曲讲解，记录改了才变。
    const root = created('speech');
    fs.writeFileSync(path.join(root, 'song.yaml'), song.DefaultConfig);
    expect(composeProjectPrompt(root).flow).toBe('speech');
    flow.recordFlow(root, { id: 'song', canvas: 'vertical-3x4' });
    expect(composeProjectPrompt(root).flow).toBe('song');
  });
});

describe('directories without a flow record', () => {
  it('refuse to compose and say which part of the lock file is missing', () => {
    const root = tempProject();
    // 旧版的标记文件不再决定流程。
    fs.writeFileSync(path.join(root, 'beat.yaml'), 'schema: 1\n');
    for (const call of [() => runPrompt(root, ''), () => flow.detectFlow(root)]) {
      expect(call).toThrow(flow.MissingFlowRecordError);
      expect(call).toThrow(`${flow.LockFile} 里要有 "production"`);
      expect(call).toThrow('不是用这一版片场新建的项目');
    }
  });

  it('refuse an unknown flow or canvas in the record', () => {
    const root = tempProject();
    flow.recordFlow(root, { id: 'nope', canvas: 'vertical-3x4' });
    expect(() => runPrompt(root, '')).toThrow('不是这一版认得的流程');
    flow.recordFlow(root, { id: 'speech', canvas: 'square-1x1' });
    expect(() => runPrompt(root, '')).toThrow('production.canvas 不是认得的画幅');
  });

  it('still read an explicit override', () => {
    const root = tempProject();
    fs.writeFileSync(path.join(root, 'mine.md'), 'MINE');
    expect(runPrompt(root, path.join(root, 'mine.md')).prompt.toString('utf8')).toBe('MINE');
  });
});

describe('every builtin prompt', () => {
  // 内置流程引用了自己没有的阶段时直接报错（第三方流程才写成「<标题>那一步」）：组合得出来、也没有这种写法。
  it('references only stages of its own flow', () => {
    const prompts = everyBuiltinPrompt();
    expect(new Set(prompts.map((p) => p.flow))).toEqual(new Set(builtinFlowIDs()));
    for (const { name, text } of prompts) {
      expect(text, name).not.toMatch(/」那一步/);
      expect(text, name).not.toContain('{{');
    }
  });

  it('substitutes the canvas label', () => {
    for (const { name, flow: id, canvas, text } of everyBuiltinPrompt()) {
      if (id === 'song') continue;
      const p = preset.byID(canvas)!;
      expect(text, name).toContain(preset.canvasLabel(p.canvas));
      for (const other of preset.all())
        if (other.id !== canvas) expect(text, name).not.toContain(preset.canvasLabel(other.canvas) + '、30fps');
    }
  });

  // 锁定文件规则写明的版本等于 PinnedVersion，且出现的 hyperframes@ 版本全部等于它。
  it('pins the same HyperFrames version as the binary', () => {
    const want = 'hyperframes@' + hyperframes.PinnedVersion;
    for (const { name, flow: id, text } of everyBuiltinPrompt()) {
      if (id !== 'song') expect(text, name).toContain('版本固定为 `' + hyperframes.PinnedVersion + '`');
      for (const got of text.match(/hyperframes@[0-9][0-9A-Za-z.-]*/g) ?? []) expect(got, name).toBe(want);
    }
  });

  it('leaves the visual style free and names no style source', () => {
    for (const { name, text } of everyBuiltinPrompt()) {
      for (const banned of [
        '定风格（仅自定义风格）',
        'custom-draft',
        'docs/style-brief.md',
        'onset style add-font',
        'onset validate style --regenerate-examples',
        'docs/自定义-视频风格说明书.md',
        'lemo',
        'DEMO.md',
        'core/fonts',
      ]) {
        expect(text.includes(banned), `${name} 不应包含 ${banned}`).toBe(false);
      }
    }
  });

  // 配音与对齐工具是前置资源：提示词里写安装命令的话，编排工具会在对话里自己装一份全局的。onset 不在 PATH 里：$(onset …) 跑不起来。
  it('installs nothing and never tells to use a terminal', () => {
    for (const { name, text } of everyBuiltinPrompt()) {
      for (const banned of [
        '$(onset ',
        '在终端运行',
        '在终端里运行',
        'pipx install',
        'npm install -g',
        'brew install',
        'uv tool install',
        'pip install funasr',
        'pip install tccli',
      ]) {
        expect(text.includes(banned), `${name} 不应包含 ${banned}`).toBe(false);
      }
    }
  });
});

/** 内容门禁：这些章节被删或改回旧写法时，编排工具会照着错的流程做。每条断言写明对哪些流程成立。 */
describe('prompt content', () => {
  const speech = composeFor('speech', 'vertical-9x16');
  const beat = composeFor('beat', 'vertical-9x16');
  const sung = composeFor('song', 'vertical-9x16');
  const has = (body: string, wants: string[], what: string) => {
    for (const want of wants) expect(body.includes(want), `${what}缺少 ${want}`).toBe(true);
  };
  const lacks = (body: string, banned: string[], what: string) => {
    for (const b of banned) expect(body.includes(b), `${what}不应包含 ${b}`).toBe(false);
  };

  // TTS 会把「2025 年」读成「两千零二十五年」，只能在生成前逐个钉住。口播才有 TTS。
  it('pins year readings (speech)', () => {
    has(
      speech,
      [
        '四位数年份一律逐位读',
        '不得读成「一千九百七十二年」「两千零二十五年」',
        '2025年/二零二五年',
        '直接写成逐位汉字',
        '每个四位年份是否逐位读出',
      ],
      '口播·年份读法',
    );
  });

  it('leaves the visual style free (speech, beat)', () => {
    for (const [body, what] of [
      [speech, '口播'],
      [beat, '卡点'],
    ])
      has(body, ['视觉风格不由项目预设或字段锁定'], what + '·风格自由声明');
  });

  // 镜头交接经分镜计划的 handoff 由 scene_cues() 写进两侧：只有口播的分镜计划有它。卡点没有这套机制，交接写在两侧的 prompt.md 里。
  it('carries scene handoffs (speech) and states them in prompt.md (beat)', () => {
    has(
      speech,
      [
        '### 镜头交接',
        '"look"',
        '"chapter"',
        '"handoff"',
        '`bridge`',
        '不要给章节交界套一个统一的擦除或闪白',
        '相邻两个章节交界不得用同一种手法',
        '`carry`',
        '`match`',
        '`push_in`',
        '`flood`',
        '`pan`',
        '`settle`',
        '前一镜末帧与后一镜首帧',
      ],
      '口播·镜头交接',
    );
    has(
      beat,
      ['章节之间怎么接', '这份约定写进两侧镜头 `prompt.md` 的出场状态与入场状态', '相邻两个章节交界不要用同一种接法'],
      '卡点·镜头交接',
    );
    lacks(beat, ['"handoff"', 'scene_cues(', 'scene-plan.json'], '卡点');
  });

  // 风格交界的手法表与 scene.StyleShifts 一一对应：改了代码里的表忘了改提示词（或反过来），编排工具就会写出 scene_cues 拒收的计划。
  it('carries style boundaries (speech table; beat in prose)', () => {
    has(
      speech,
      [
        '### 风格交界',
        '`style_shift`',
        '"film_style"',
        '段落换风格',
        'film_style_add({"style": "<来源/目录名>"})',
        '禁止整画面叠化',
      ],
      '口播·风格交界',
    );
    for (const shift of scene.StyleShifts) {
      const row = speech.split('\n').find((line) => line.startsWith(`| \`${shift.id}\` ${shift.name} |`));
      expect(row, `风格交界表缺少 ${shift.id}`).toBeTruthy();
      expect(
        row!.trimEnd().endsWith('| ' + shift.devices.map((d) => '`' + d + '`').join('、') + ' |'),
        `${shift.id} 那一行的 device 与 scene.StyleShifts 不一致`,
      ).toBe(true);
    }
    has(
      beat,
      [
        '段落换风格',
        'film_style_add({"style": "<来源/目录名>"})',
        '就是风格交界',
        '禁止整画面叠化',
        '在这些镜头的 `scene.json` 里写 `film_style`',
      ],
      '卡点·风格交界',
    );
  });

  it('carries the film style without naming a source (speech, beat)', () => {
    const common = [
      '### 整片风格',
      'film_style_list()',
      'film_style_use({"style": "<来源/目录名>"})',
      'film_style_show()',
      '"replace": true',
      '.agents/skills/onset-film-style/',
      'SKILL.md',
      'STYLE.md',
      '不用整片风格',
      '工具准备页',
      'STYLE.md 里关于声音的内容只作为选曲和音效方向的参考',
    ];
    has(speech, [...common, '稿件审核关卡', '第六阶段渲染镜头之前'], '口播·整片风格');
    has(beat, [...common, '在第二阶段的故事审核关卡', '第四阶段渲染镜头之前'], '卡点·整片风格');
  });

  // 记忆在用户确认成片可用之后整理：那时这部片子的问题才记全。
  it('consolidates memory after the user approves the film (speech, beat)', () => {
    for (const [body, what] of [
      [speech, '口播'],
      [beat, '卡点'],
    ])
      has(
        body,
        ['### 整理这次制作的经验', '用户明确确认这一版成片可用之后', 'memory_consolidate()', '不要在用户确认之前整理'],
        what + '·整理经验',
      );
  });

  // 片场宣传视频（2026-11-18）：用户说「可以了」之后，编排才补做画面文字对账，查出问题就自己改镜头、重渲染。
  it('finishes every check before approval and stops after it (speech, beat)', () => {
    for (const [body, what] of [
      [speech, '口播'],
      [beat, '卡点'],
    ]) {
      has(
        body,
        [
          '不得把还没查完的候选交给用户批准',
          '用户批准后只做交付',
          '立即停下，不要自行修复',
          '之前的批准作废',
          '不得沿用上一版的 `onscreen-facts.json`',
        ],
        what + '·审批',
      );
    }
  });

  it('tells the beat story before the music (beat)', () => {
    has(
      beat,
      [
        '：故事、音乐与节拍',
        '这是一部没有配音、画面踩着音乐节拍走的片子。',
        'production/beat/story.md',
        '画面里的字与字幕就是这部片子的文案',
        'studio_show({"page": "beat"',
        '用户没有点头之前不进入分镜计划',
        '不得替用户确认',
        'beat_cues({"scenes": "scenes/"})',
        '「音乐卡点」',
        '不要自己建 Python 环境、不要 pip install',
      ],
      '卡点分支',
    );
    expect(beat.indexOf('### 故事与文案')).toBeLessThan(beat.indexOf('### 音乐与节拍网格'));
    expect(beat.indexOf('### 音乐与节拍网格')).toBeLessThan(beat.indexOf('### 分镜计划与镜头'));
    // 口播流程不再带卡点与歌曲的分支。
    lacks(speech, ['## 卡点分支', '## 歌曲讲解分支', 'beat_cues('], '口播');
  });

  // 分镜和每个镜头的画面描述在渲染前就写好了；不停下来的话，用户第一次看到画面时每个镜头都已经渲染过一遍。
  it('stops for storyboard review before rendering (speech, beat)', () => {
    for (const [body, what] of [
      [speech, '口播'],
      [beat, '卡点'],
    ]) {
      has(
        body,
        ['### 分镜审核关卡', 'studio_show({"page": "storyboard"', '用户没有点头之前不渲染', '包括代表性镜头的试渲染'],
        what + '·分镜审核',
      );
      expect(body.indexOf('### 分镜审核关卡'), what).toBeLessThan(
        body.indexOf('用 `scene_run_all({"scenes": "scenes/", '),
      );
    }
    has(beat, ['过第四阶段的「分镜审核关卡」'], '卡点·分镜审核');
  });

  it('documents the optional single-scene pilot gate in storyboard and render prompts (speech)', () => {
    has(speech, ['gate-pilot', 'pilot_gate: true', 'studio_confirm({"gate": "gate-pilot"'], '口播·单镜打样闸门');
  });

  // 编排工具缺了信息时会 strings / grep 已装的 onset 程序反推格式（实测），每次都弹权限确认打断用户。
  it('keeps the orchestrator out of onset internals (all flows)', () => {
    for (const [body, what] of [
      [speech, '口播'],
      [beat, '卡点'],
      [sung, '歌曲'],
    ])
      has(body, ['onset 工具服务（MCP）里的工具', '`job_wait`', '`onset` 不在终端里'], what + '·格式约定');
    for (const [body, what] of [
      [speech, '口播'],
      [beat, '卡点'],
    ])
      has(body, ['不要用 `which`、`strings`、`grep` 去找、去读 `onset` 程序本身'], what + '·格式约定');
    has(beat, ['节拍页把这个文件当普通 Markdown 原样显示'], '卡点·格式约定');
  });

  it('keeps all speech synthesis behind OnSet operations', () => {
    has(speech, ['voice_synthesize(', 'voice_catalog()', 'voice_design(', 'voice_save('], '配音托管');
    lacks(
      speech,
      [
        'mlx_audio.tts.generate',
        'mmx speech synthesize',
        'bl speech synthesize',
        'edge-tts -v',
        'elevenlabs text-to-speech',
        'tccli tts',
        '--ref_audio',
        '--ref_text',
      ],
      '配音托管',
    );
  });

  it('leaves voice tools to the tool page (speech)', () => {
    has(speech, ['配音与对齐工具都是前置资源', '工具准备页', 'align_run({"publish": true})'], '口播·配音工具');
    expect(speech).not.toContain('funasr-python');
  });

  it('requires platform covers (speech, beat)', () => {
    for (const [body, what] of [
      [speech, '口播'],
      [beat, '卡点'],
    ])
      has(
        body,
        [
          'douyin',
          'xiaohongshu',
          'channels',
          'bilibili',
          'zhihu',
          '16:10',
          '安全区',
          'covers/src/',
          'cover.images',
          'designed_image',
        ],
        what + '·平台封面',
      );
  });

  it('carries the treatment before TTS (speech) and before the bar plan (beat)', () => {
    const common = [
      '### 整片处理方案',
      'production/treatment.md',
      '钩子—揭示—收束',
      '持续物件',
      '全片配色',
      '微动效参数由各镜自主调优，核心表达所需的标志性动效手法在分镜阶段通过 `motion_effects` 显式选型',
      '章节之间怎么接',
      '先改 `treatment.md`',
    ];
    has(speech, [...common, '- `production/treatment.md` 整片处理方案'], '口播·整片处理方案');
    expect(speech.indexOf('### 整片处理方案')).toBeLessThan(speech.indexOf('## 第三阶段'));
    has(beat, [...common, '- `production/treatment.md` 整片处理方案。'], '卡点·整片处理方案');
    expect(beat.indexOf('### 整片处理方案')).toBeLessThan(beat.indexOf('### 分镜计划与镜头'));
  });

  it('declares scene handoff states (speech, beat)', () => {
    for (const [body, what] of [
      [speech, '口播'],
      [beat, '卡点'],
    ])
      has(
        body,
        ['在 `prompt.md` 中写明镜头交接：入场状态', '出场状态（最后一帧留给下一镜头', '声明的出场状态与入场状态'],
        what + '·镜头交接约定',
      );
  });

  it('points the orchestrator to the motion effects catalog (speech, beat)', () => {
    for (const [body, what] of [
      [speech, '口播'],
      [beat, '卡点'],
    ])
      has(
        body,
        ['motion_effect_list({"query": "<关键词>"})', 'motion_effect_show({"ref": "<标识>"})', 'plugin_skills'],
        what + '·动效库',
      );
  });

  it('injects the compact motion menu only into planning stages', () => {
    const speechRoot = created('speech', 'vertical-3x4');
    const planFocused = composeProjectPrompt(speechRoot, 'plan', true).text;
    expect(planFocused).toContain('文字与数据');
    expect(planFocused).toContain('005 遮罩显现');
    expect(planFocused).toContain('其余内置与插件动效可用 `motion_effect_list()` 检索');
    expect(planFocused).not.toContain('{{MOTION_MENU}}');

    for (const stage of ['script', 'voice', 'mix', 'publish']) {
      const other = composeProjectPrompt(speechRoot, stage, true).text;
      expect(other, `stage ${stage} should not carry compact motion menu`).not.toContain(
        '其余内置与插件动效可用 `motion_effect_list()` 检索',
      );
    }

    const beatRoot = created('beat', 'vertical-9x16');
    const beatPlan = composeProjectPrompt(beatRoot, 'beat-plan', true).text;
    expect(beatPlan).toContain('005 遮罩显现');
    expect(beatPlan).toContain('其余内置与插件动效可用 `motion_effect_list()` 检索');
    const beatMix = composeProjectPrompt(beatRoot, 'beat-mix', true).text;
    expect(beatMix).not.toContain('其余内置与插件动效可用 `motion_effect_list()` 检索');
  });

  it('renders every builtin preset and flow on startup with zero unresolved placeholders', () => {
    const allPresets = preset.all();
    expect(allPresets.map((p) => p.id)).toContain('landscape-16x9');
    for (const p of allPresets) {
      for (const delivery of builtinFlowIDs()) {
        const root = created(delivery, p.id);
        const label = `${delivery}/${p.id}`;
        const frameText = fs.readFileSync(path.join(root, 'frame.md'), 'utf8');
        expect(frameText, `${label} frame.md`).not.toMatch(/\{\{[^}]+\}\}/);

        const full = runPrompt(root, '').prompt.toString('utf8');
        expect(full, `${label} full runPrompt`).not.toMatch(/\{\{[^}]+\}\}/);
        expect(full, `${label} full runPrompt`).not.toContain('{{MOTION_MENU}}');
        if (delivery === 'speech' || delivery === 'beat') {
          expect(full, `${label} motion menu`).toContain('文字与数据');
          expect(full, `${label} motion menu`).toContain('005 遮罩显现');
          expect(full, `${label} motion menu`).toContain('其余内置与插件动效可用 `motion_effect_list()` 检索');
        }

        // 模拟客户端「新建项目 → 88% 开始制作」首轮聚焦启动，以及每个阶段的按需展开（flow_guide）。
        const def = flow.allFlows().find((f) => f.id === delivery)!;
        const firstStage = def.stations[0];
        if (firstStage) {
          const initialFocused = runPrompt(root, '', firstStage).prompt.toString('utf8');
          expect(initialFocused, `${label} initial focus ${firstStage}`).not.toMatch(/\{\{[^}]+\}\}/);
        }
        const planStage = delivery === 'speech' ? 'plan' : delivery === 'beat' ? 'beat-plan' : '';
        if (planStage) {
          const planFocused = composeProjectPrompt(root, planStage, true).text;
          expect(planFocused, `${label} ${planStage}`).not.toMatch(/\{\{[^}]+\}\}/);
          expect(planFocused, `${label} ${planStage}`).toContain('005 遮罩显现');
          expect(planFocused, `${label} ${planStage}`).toContain('其余内置与插件动效可用 `motion_effect_list()` 检索');
        }
      }
    }
  });

  it('mixes without amix normalization (speech, beat)', () => {
    has(speech, ['`amix`', '`normalize=0`', '`event_id`', '`phrase_id`', '：配音优先的声音混合'], '口播·声音设计');
    has(beat, ['`amix`', '`normalize=0`', '`event_id`', '：音乐与音效的混合'], '卡点·声音设计');
  });

  it('aligns with code (speech)', () => {
    has(
      speech,
      ['`align_text()`', 'align_build(', '`<显示|朗读>`', '`@{短语编号}', 'phrase-adjust.json'],
      '口播·对齐流程',
    );
    lacks(speech, ['按替换清单映射回终稿原文', '按顺序与原文逐字对回'], '口播·对齐流程');
  });

  it('derives scene durations (speech from subtitles, beat from bars)', () => {
    has(
      speech,
      [
        'scene_cues({"scenes": "scenes/", "plan": "production/scene-plan.json"',
        '`first_subtitle`',
        '`first_phrase`',
        '"check": true',
        'onset-scene.js',
        '`scene-kit`',
      ],
      '口播·镜头时长',
    );
    has(
      beat,
      [
        '：按小节拆分镜头',
        'production/beat/plan.json',
        'beat_cues({"scenes": "scenes/"})',
        '不得手改 duration_seconds',
        '`scene-kit`',
      ],
      '卡点·镜头时长',
    );
    for (const [body, what] of [
      [speech, '口播'],
      [beat, '卡点'],
    ])
      lacks(body, ['每个镜头先定帧数，再写 `duration_seconds = 帧数 ÷ 帧率`'], what);
  });

  // 卡点片没有配音：口播稿、TTS、对齐、短语时间轴与「配音优先」的说法都不该出现在卡点的提示词里。
  it('says nothing about voice-over in the beat flow', () => {
    lacks(
      beat,
      [
        '整理口播稿和开场',
        'TTS 和断句校对',
        '依据实际语音重建 SRT',
        '配音优先',
        'transcription-production.srt',
        'phrase-timeline.json',
        'timing-report.json',
        'scene-plan',
        '人声',
        '没有配音时使用 TTS',
        '付费 TTS',
        'voice.wav',
        '断句、发音',
      ],
      '卡点',
    );
    expect(stageTitles(beat).map((t) => t.slice(t.indexOf('：') + 1))).toEqual([
      '盘点输入和制作规格',
      '故事、音乐与节拍',
      '按小节拆分镜头',
      '建立镜头目录、并发调度渲染工具',
      '首帧封面和视觉验收',
      '规范化和拼接静音母版',
      '音乐授权和音效',
      '音乐与音效的混合',
      '最终验收、试听与交付',
      '刷新发布配置',
      '项目收尾与归档',
    ]);
  });

  // 多角色对话的作业规程是口播流程的附录（项目根有 cast.yaml 时生效），不再是项目里的一份文件。
  it('carries the cast rules as an appendix of the speech flow', () => {
    has(
      speech,
      ['必须同时遵守文末的「附：多角色叙事作业规程」', '## 附：多角色叙事作业规程（cast 模式）', 'dialogue_assemble()'],
      '口播·多角色',
    );
    lacks(speech, ['PROMPT-CAST-ADDENDUM.md', 'PROMPT-PRODUCTION.md'], '口播');
    lacks(beat, ['多角色叙事作业规程'], '卡点');
  });

  it('carries the whole song production once (song)', () => {
    has(sung, ['# 单人歌曲讲解制作', '不得代替用户选择', 'song_mux('], '歌曲');
    expect(sung.split('# 单人歌曲讲解制作').length - 1).toBe(1);
    lacks(sung, ['PROMPT-SONG.md', '歌曲模式必要契约'], '歌曲');
    expect(sung).not.toMatch(/第[一二三四五六七八九十]+阶段/);
  });
});

describe('third-party flow reuses builtin station sections', () => {
  it('takes the shared preamble, the builtin stations it names and its own prompt', () => {
    // 插件带来的流程是新建时的一个做法：项目的流程记录写 x:<插件 id>。
    flow.installStation(`link:${fake}`);
    const root = created('x:fake-publisher');
    expect(flow.flowRecord(root)).toEqual({
      id: 'x:fake-publisher',
      canvas: 'vertical-3x4',
      render_prompt: flow.RenderPromptVersion,
    });
    const { text: body, flow: id } = composeProjectPrompt(root);
    expect(id).toBe('x:fake-publisher');
    // 假发布插件的流程：intake、render、assemble、review、本站。
    const stages = [...body.matchAll(/^## (第[一二三四五六七八九十]+阶段：.+|这部片子的流程：.+)$/gm)].map((m) => m[1]);
    expect(stages).toEqual([
      '第一阶段：盘点输入和制作规格',
      '第二阶段：建立镜头目录、并发调度渲染工具',
      '第三阶段：规范化和拼接静音母版',
      '第四阶段：最终验收、试听与交付',
      '这部片子的流程：快剪',
    ]);
    expect(body.startsWith('# 完成一次从稿件到成片的竖屏 MG 视频制作')).toBe(true);
    expect(body).toContain('## 工作边界');
    // 内置站的段落引用了这套流程没有的阶段：写成那一步的标题（只有第三方流程有这条退路）。
    expect(body).toContain('「配音优先的声音混合」那一步');
    // 本站的阶段补充插在渲染那一阶段的末尾。
    const insert = body.indexOf('### 第三方站「假发布」的补充');
    expect(insert).toBeGreaterThan(body.indexOf('## 第二阶段：建立镜头目录'));
    expect(insert).toBeLessThan(body.indexOf('## 第三阶段'));
    expect(body.includes('{{')).toBe(false);
  });
});
