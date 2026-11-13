import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as scene from '../../scene';
import * as preset from '../index';
import {
  canvasAndSafeArea,
  canvasMarker,
  generate,
  generatedStyles,
  loadProduction,
  loadTemplates,
  renderCanvas,
  renderExamples,
  renderStyle,
  repoRoot,
  selectStyles,
  selectTargets,
  substituteCanvas,
} from './gen';

const repo = repoRoot(__dirname);
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-gen-'));
const discard = { write: () => {} };
const byID = (id: string) => preset.byID(id)!;
const renderStyleOf = (p: preset.Preset, style: preset.Style) => renderStyle(p, style, loadTemplates(repo, style.id));
const frontmatterOf = (body: string) => {
  const parts = body.split('---');
  expect(parts.length).toBeGreaterThanOrEqual(3);
  return parts[1];
};

/** generate 应写出的全部文本产物（相对 assets/）。 */
function outputs(): string[] {
  const out: string[] = [];
  for (const p of preset.all()) {
    out.push(`presets/${p.id}/PROMPT-PRODUCTION.md`);
    for (const style of generatedStyles()) {
      const dir = `styles/${style.id}/${p.id}`;
      out.push(`${dir}/frame.md`, `${dir}/${preset.guideDoc(style)}`);
    }
  }
  return out;
}

describe('preset generator', () => {
  it('renders the canvas and safe-area block', () => {
    expect(canvasAndSafeArea(byID('vertical-9x16'))).toBe(
      [
        'canvas:',
        '  width_px: 1080',
        '  height_px: 1920',
        '  fps: 30',
        '  orientation: vertical',
        'safe_area:',
        '  structural: {left_px: 40, right_px: 40, top_px: 96, bottom_px: 60}',
        '  main_content: {left_px: 88, right_px: 88, top_px: 120, bottom_px: 100}',
        '  critical_text: {left_px: 88, right_px: 180, top_px: 120, bottom_px: 260}',
        '  cover_title: {left_px: 88, right_px: 180, top_px: 260, bottom_px: 940}',
        '  subtitles: {left_px: 88, right_px: 180, top_px: 1470, bottom_px: 260}',
      ].join('\n'),
    );
  });

  // frame.md 与说明书的 frontmatter 必须逐字节相同，validate.Style 会做 DeepEqual。
  it('keeps frontmatter identical across frame.md and the guide', () => {
    const p = byID('vertical-9x16');
    for (const style of preset.allStyles()) {
      const files = renderStyleOf(p, style);
      const frame = frontmatterOf(files.get('frame.md')!);
      expect(frontmatterOf(files.get(preset.guideDoc(style))!), style.id).toBe(frame);
      expect(frame).toContain('height_px: 1920');
    }
  });

  it('rejects a mismatched style identity', () => {
    const style = preset.defaultStyle();
    const tpl = loadTemplates(repo, style.id);
    tpl.frontmatter = tpl.frontmatter.replace('style_id: ' + style.id, 'style_id: other-v1');
    expect(() => renderStyle(byID('vertical-3x4'), style, tpl)).toThrow('与风格表不一致');
  });

  it('has templates for every style', () => {
    for (const style of preset.allStyles()) expect(() => loadTemplates(repo, style.id)).not.toThrow();
  });

  it('renders the custom draft for every canvas', () => {
    const tpl = loadTemplates(repo, preset.CustomStyle.id);
    for (const p of preset.all()) {
      const files = renderStyle(p, preset.CustomStyle, tpl);
      expect(frontmatterOf(files.get('frame.md')!)).toContain(`style_id: ${preset.DraftStyleID}\n`);
      expect(files.has(preset.guideDoc(preset.CustomStyle))).toBe(true);
    }
  });

  it('substitutes the canvas label', () => {
    const body = renderCanvas(byID('vertical-9x16'), loadProduction(repo)).get('PROMPT-PRODUCTION.md')!;
    expect(body).not.toContain('1080×1440');
    expect(body).toContain('1080×1920');
    expect(body).not.toContain('{{CANVAS}}');
  });

  it('rejects a template without the marker', () => {
    const tpl = loadTemplates(repo, preset.defaultStyle().id);
    tpl.frontmatter = 'schema_version: 1\n';
    expect(() => renderStyle(byID('vertical-3x4'), preset.defaultStyle(), tpl)).toThrow(canvasMarker);
  });

  it('finds the repo root by walking up', () => {
    const root = temp();
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.mkdirSync(path.join(root, 'assets', 'shared'), { recursive: true });
    const deep = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    expect(fs.realpathSync(repoRoot(deep))).toBe(fs.realpathSync(root));
    expect(() => repoRoot(temp())).toThrow('找不到仓库根目录');
  });

  // 缺手写 SVG 时必须报错并点名文件，而不是产出一套残缺示例。
  it('names the missing SVG', () => {
    expect(() => renderExamples(repo, temp(), byID('vertical-3x4'), preset.defaultStyle(), discard)).toThrow('proposition.svg');
  });

  it('rejects a broken anchor', () => {
    const p: preset.Preset = {
      id: 'broken',
      label: '',
      canvas: { widthPx: 1080, heightPx: 1440, fps: 30, orientation: 'vertical' },
      safeArea: [{ name: 'x', leftPx: 0, rightPx: 0, anchor: 'middle' }],
      platform: byID('vertical-3x4').platform,
      layoutNotes: '',
    };
    expect(() => canvasAndSafeArea(p)).toThrow();
  });

  it('produces parseable frontmatter', () => {
    for (const p of preset.all()) {
      const body = renderStyleOf(p, preset.defaultStyle()).get('frame.md')!;
      expect(body.startsWith('---\n')).toBe(true);
      expect(body.split('\n---').length).toBeGreaterThan(1);
      expect(body).not.toContain(canvasMarker);
    }
  });

  it('writes every preset into the root and logs sorted paths', () => {
    const root = temp();
    let log = '';
    generate(repo, root, preset.all(), generatedStyles(), false, { write: (t) => (log += t) });
    for (const name of outputs()) expect(fs.existsSync(path.join(root, 'assets', name)), name).toBe(true);
    for (const p of preset.all()) {
      expect(fs.readFileSync(path.join(root, 'assets', 'presets', p.id, 'PROMPT-PRODUCTION.md'), 'utf8')).toContain(preset.canvasLabel(p.canvas));
    }
    expect(log).toContain(`generated assets/styles/${preset.defaultStyle().id}/vertical-9x16/frame.md`);
  });

  // 产物必须与仓库里签入的一致——这正是 CI 幂等门要保证的事，也证明 TS 生成器与 Go 版逐字节相同。
  it('matches the committed assets byte-for-byte', () => {
    const root = temp();
    generate(repo, root, preset.all(), generatedStyles(), false, discard);
    for (const name of outputs()) {
      const fresh = fs.readFileSync(path.join(root, 'assets', name));
      const committed = fs.readFileSync(path.join(repo, 'assets', name));
      expect(fresh.equals(committed), `${name} 与签入产物不一致，需重跑生成器`).toBe(true);
    }
  });

  it('selects styles and targets', () => {
    expect(selectStyles('')).toHaveLength(preset.allStyles().length + 1);
    expect(selectStyles(preset.DraftStyleID).map((s) => s.id)).toEqual([preset.DraftStyleID]);
    expect(() => selectStyles('no-such-style')).toThrow();
    expect(selectTargets('')).toHaveLength(preset.all().length);
    expect(selectTargets('vertical-9x16').map((p) => p.id)).toEqual(['vertical-9x16']);
    expect(() => selectTargets('square-1x1')).toThrow();
  });

  it('fills canvas placeholders per orientation', () => {
    const style = preset.defaultStyle();
    const v = renderStyleOf(byID('vertical-3x4'), style).get('frame.md')!;
    const l = renderStyleOf(byID('landscape-16x9'), style).get('frame.md')!;
    for (const want of ['content_width_px: 904', '竖屏', '抖音右侧互动栏']) expect(v).toContain(want);
    for (const want of ['content_width_px: 1680', '横屏', '播放器底部控制栏', '## 横屏构图要点']) expect(l).toContain(want);
    for (const leaked of ['{{', '抖音']) expect(l).not.toContain(leaked);
  });

  it('rejects unknown placeholders and applies offsets', () => {
    expect(() => substituteCanvas(byID('vertical-3x4'), 'x {{NO_SUCH_TOKEN}} y')).toThrow('未知占位符');
    expect(substituteCanvas(byID('vertical-3x4'), '{{CONTENT_LEFT_PX+8}}/{{CONTENT_WIDTH_PX-16}}')).toBe('96/888');
  });
});

/** 制作提示词的内容门禁：这些章节被删或改回旧写法时，编排工具会照着错的流程做。 */
describe('PROMPT-PRODUCTION template', () => {
  const body = loadProduction(repo);
  const has = (wants: string[], what: string) => {
    for (const want of wants) expect(body.includes(want), `${what}缺少 ${want}`).toBe(true);
  };
  const lacks = (banned: string[], what: string) => {
    for (const b of banned) expect(body.includes(b), `${what}不应包含 ${b}`).toBe(false);
  };

  // TTS 会把「2025 年」读成「两千零二十五年」，只能在生成前逐个钉住。
  it('pins year readings', () => {
    has(['四位数年份一律逐位读', '不得读成「一千九百七十二年」「两千零二十五年」', '--pronunciation "2025年/二零二五年"', '直接写成逐位汉字', '每个四位年份是否逐位读出'], '年份读法');
  });

  it('leaves the visual style free', () => {
    lacks(['定风格（仅自定义风格）', 'custom-draft', 'docs/style-brief.md', 'am style add-font', 'am validate style --regenerate-examples', 'docs/自定义-视频风格说明书.md'], '风格前置约束');
    has(['视觉风格不由项目预设或字段锁定'], '风格自由声明');
  });

  it('carries scene handoffs', () => {
    has(['### 镜头交接', '"look"', '"chapter"', '"handoff"', '`bridge`', '不要给章节交界套一个统一的擦除或闪白', '相邻两个章节交界不得用同一种手法', '`carry`', '`match`', '`push_in`', '`flood`', '`pan`', '`settle`', '前一镜末帧与后一镜首帧'], '镜头交接');
  });

  // 风格交界的手法表与 scene.StyleShifts 一一对应：每种手法连同能配的 device 都写进第五阶段的表格，
  // 改了代码里的表忘了改提示词（或反过来），编排工具就会写出 am scene cues 拒收的计划。
  it('carries style boundaries', () => {
    has(['### 风格交界', '`style_shift`', '"film_style"', '段落换风格', 'film_style_add({"style": "<来源/目录名>"})', '禁止整画面叠化'], '风格交界');
    for (const shift of scene.StyleShifts) {
      const row = body.split('\n').find((line) => line.startsWith(`| \`${shift.id}\` ${shift.name} |`));
      expect(row, `风格交界表缺少 ${shift.id}`).toBeTruthy();
      expect(row!.trimEnd().endsWith('| ' + shift.devices.map((d) => '`' + d + '`').join('、') + ' |'), `${shift.id} 那一行的 device 与 scene.StyleShifts 不一致`).toBe(true);
    }
  });

  it('carries the film style without naming a source', () => {
    has(['### 整片风格', 'film_style_list()', 'film_style_use({"style": "<来源/目录名>"})', 'film_style_show()', '"replace": true', '.agents/skills/am-film-style/', 'SKILL.md', 'STYLE.md', '稿件审核关卡', '不用整片风格', '第六阶段渲染镜头之前', '工具准备页', 'STYLE.md 里关于声音的内容只作为选曲和音效方向的参考'], '整片风格');
    lacks(['lemo', 'DEMO.md', 'core/fonts'], '制作提示词');
  });

  // 记忆在用户确认成片可用之后整理：那时这部片子的问题才记全；客户端成片页的「确认可用」走同一个命令。
  it('consolidates memory after the user approves the film', () => {
    has(['### 整理这次制作的经验', '用户明确确认这一版成片可用之后', 'memory_consolidate()', '不要在用户确认之前整理'], '整理经验');
  });

  it('tells the beat story before the music', () => {
    has(['## 卡点分支', 'beat.yaml', 'production/beat/story.md', '画面里的字与字幕就是这部片子的文案', 'studio_show({"page": "beat"', '用户没有点头之前不进入分镜计划', '不得替用户确认', 'beat_cues({"scenes": "scenes/"})', '「音乐卡点」', '不要自己建 Python 环境、不要 pip install'], '卡点分支');
    expect(body.indexOf('### 故事与文案')).toBeLessThan(body.indexOf('### 音乐与节拍网格'));
  });

  // 分镜和每个镜头的画面描述在渲染前就写好了；不停下来的话，用户第一次看到画面时每个镜头都已经渲染过一遍。
  it('stops for storyboard review before rendering', () => {
    has(['### 分镜审核关卡', 'studio_show({"page": "storyboard"', '用户没有点头之前不渲染', '包括代表性镜头的试渲染'], '分镜审核');
    expect(body.indexOf('### 分镜审核关卡')).toBeLessThan(body.indexOf('用 `scene_run_all({"scenes": "scenes/", "srt"'));
    expect(body.indexOf('## 卡点分支')).toBeLessThan(body.lastIndexOf('studio_show({"page": "storyboard"'));
  });

  // 配音与对齐工具是前置资源（toolinstall，由 am setup 装进用户级目录）：提示词里写安装命令的话，编排工具会在对话里
  // 自己装一份全局的，版本不受控，客户端用户的机器上还常常没有 npm、pip、brew。
  // 编排工具缺了信息时会 strings / grep 已装的 am 程序反推格式（实测：反推 story.md 的格式），每次都弹权限确认打断用户。
  it('keeps the orchestrator out of am internals', () => {
    has(['不要用 `which`、`strings`、`grep` 去找、去读 `am` 程序本身', '节拍页把这个文件当普通 Markdown 原样显示', 'am 工具服务（MCP）里的工具', '`job_wait`', '`am` 不在终端里'], '格式约定');
  });

  it('leaves voice tools to am setup', () => {
    has(['配音与对齐工具都是前置资源', '工具准备页', 'funasr-python', '--model <ALIGN_MODEL 的本地目录>', 'config_get({"key": "ALIGN_MODEL"})'], '配音工具');
    // am 不在编排工具的 PATH 里：$(am …) 这样的命令替换跑不起来。
    lacks(['$(am ', '在终端运行', '在终端里运行'], '配音工具');
    lacks(['pipx install', 'npm install -g', 'brew install', 'uv tool install', 'pip install funasr', 'pip install tccli'], '配音工具');
  });

  it('requires platform covers', () => {
    has(['douyin', 'xiaohongshu', 'channels', 'bilibili', 'zhihu', '16:10', '安全区', 'covers/src/', 'cover.images', 'designed_image'], '平台封面');
  });

  it('carries the treatment before TTS', () => {
    has(['### 整片处理方案', 'production/treatment.md', '钩子—揭示—收束', '持续物件', '全片配色', '字体、版式和动效由各镜头根据文案自由决定', '章节之间怎么接', '先改 `treatment.md`', '- `production/treatment.md` 整片处理方案'], '整片处理方案');
    expect(body.indexOf('### 整片处理方案')).toBeLessThan(body.indexOf('## 第三阶段'));
  });

  it('declares scene handoff states', () => {
    has(['在 `prompt.md` 中写明镜头交接：入场状态', '出场状态（最后一帧留给下一镜头', '声明的出场状态与入场状态'], '镜头交接约定');
  });

  it('mixes without amix normalization', () => {
    has(['`amix`', '`normalize=0`', '`event_id`', '`phrase_id`'], '声音设计');
  });

  it('aligns with code', () => {
    has(['`align_text()`', 'align_build(', '`<显示|朗读>`', '`@{短语编号}', 'phrase-adjust.json'], '对齐流程');
    lacks(['按替换清单映射回终稿原文', '按顺序与原文逐字对回'], '对齐流程');
  });

  it('derives scene durations', () => {
    has(['scene_cues({"scenes": "scenes/", "plan": "production/scene-plan.json"', '`first_subtitle`', '`first_phrase`', '"check": true', 'am-scene.js', '`scene-kit`'], '镜头时长流程');
    lacks(['每个镜头先定帧数，再写 `duration_seconds = 帧数 ÷ 帧率`'], '镜头时长流程');
  });
});
