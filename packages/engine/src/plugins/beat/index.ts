/**
 * 内置插件「音乐卡点」（beat）：没有配音，画面踩着音乐节拍切。项目根有 beat.yaml 时就是卡点项目（新建时写出，与歌曲讲解、
 * 多角色对话互斥）。这里登记它的全部代码：
 *
 * - 流程 beat：路线（故事与文案 → 音乐与节拍 → 整片风格 → 按小节分镜 → 与口播共用的后半程）、制作提示词段落顺序
 *   （卡点自己的段落与对无配音片子不成立的宿主段落的卡点版，都在 assets/plugins/beat/sections/）；
 * - 站点的判断函数与「接下来」的说法；
 * - beat_* 操作与 validate_beat（ops.ts）、渲染前的覆盖检查、镜头的 beat 块（block.ts）；
 * - 节拍页、它的后端接口 /api/beat（api.ts）与两条网页命令（确认网格、重排重拍）；
 * - 顶栏的第一步「节拍」、前置资源「节拍分析环境」、要显式传给子进程的 ONSET_BEAT_ENV_DIR、新建选项「音乐卡点」。
 *
 * 引擎里的卡点实现（beat/：网格、计划、cue、分析环境）仍在原包里，这里引用它。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as beat from '../../beat';
import { planRules, tailStations } from '../../flow/builtin';
import type { BuiltinPlugin, JudgeContext } from '../../plugin/types';
import { hyperframesStage, withProxy } from '../../prereqs';
import * as toolinstall from '../../toolinstall';
import { BeatStoryFile, beatAPI, sameDownbeats } from './api';
import { beatBlock } from './block';
import { beatCoverage, beatGroup, beatOps } from './ops';

export { beatAPI, BeatStoryFile, sameDownbeats } from './api';
export { beatBlock, verifyBeatInputs } from './block';
export { beatCoverage } from './ops';

/** 卡点流程的 id（锁文件记的就是它）。 */
export const BeatFlow = 'beat';

/** 对无配音片子不成立的宿主段落，卡点各有一版：都在这个只带段落的站里（不上路线）。 */
const CommonStation = 'beat-common';

/**
 * 卡点流程的段落顺序：没有口播稿、配音、对齐三个阶段，开自己的阶段「故事、音乐与节拍」「按小节拆分镜头」
 * 「音乐授权和音效」「音乐与音效的混合」；宿主段落里对卡点不成立的，用 beat-common 里的那一版。
 */
export const beatPrompt: readonly string[] = [
  `${CommonStation}/head`,
  `${CommonStation}/work`,
  'host/renderer',
  `${CommonStation}/intake`,
  'intake/visual',
  `${CommonStation}/film-style`,
  `${CommonStation}/film-style-using`,
  `${CommonStation}/film-style-mix`,
  'beat-story/stage',
  'beat-story/story',
  `${CommonStation}/treatment`,
  'beat-music/grid',
  'beat-plan/stage',
  'beat-plan/plan',
  'beat-plan/budget',
  `${CommonStation}/render`,
  'beat-plan/storyboard-gate',
  `${CommonStation}/run`,
  `${CommonStation}/visual-qc`,
  `${CommonStation}/assemble`,
  `${CommonStation}/sound`,
  `${CommonStation}/mix`,
  `${CommonStation}/review`,
  'host/deliverables',
  `${CommonStation}/deliverables-tail`,
  'wrapup/stage',
];

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

const f = (c: JudgeContext, rel: string) => mtime(path.join(c.root, rel));
const anyOf = (c: JudgeContext, ...rels: string[]) => Math.max(0, ...rels.map((rel) => f(c, rel)));

function readGrid(root: string, rel: string): beat.Grid | null {
  try {
    if (!fs.statSync(path.join(root, rel)).isFile()) return null;
    return beat.readDraft(path.join(root, rel));
  } catch {
    return null;
  }
}

const change = (what: string) => ({ kind: 'draft' as const, label: '我要改', text: `${what}这几处要改：\n` });

export const beatPlugin: BuiltinPlugin = {
  id: 'beat',
  apply(ctx) {
    ctx.station({
      id: 'beat-story',
      name: '故事与文案',
      nodes: [
        { id: 'story', label: '故事与文案', step: 'beat', page: 'beat', produces: [{ path: BeatStoryFile }] },
        { id: 'gate-story', label: '故事审核', step: 'beat', gate: true, page: 'beat', gateFiles: [BeatStoryFile] },
      ],
      flows: [],
      after: '',
      sections: [
        { id: 'stage', file: 'sections/story-stage.md', stage: 'beat', title: '故事、音乐与节拍' },
        { id: 'story', file: 'sections/story.md' },
      ],
      judges: {
        story: {
          output: (c) => f(c, BeatStoryFile),
          guide: { ai: 'AI 在写这条片子的故事和文案。', user: '先定故事：这条片子讲什么、分几段。', actions: [{ kind: 'draft', label: '说说想法', text: '这条片子我想讲：' }] },
        },
        'gate-story': {
          guide: {
            user: '故事和文案写好了，看一遍再选音乐。',
            actions: [{ kind: 'page', label: '看故事', page: 'beat' }, { kind: 'gate', label: '没问题，继续', gate: 'gate-story' }, change('故事')],
            confirm: '故事和文案我看过了，没问题，继续。',
          },
        },
      },
    });
    ctx.station({
      id: 'beat-music',
      name: '音乐与节拍',
      nodes: [
        {
          id: 'music',
          label: '导入音乐',
          step: 'beat',
          page: 'beat',
          produces: [{ path: beat.TrackFile }, { path: beat.ConfigFile }, { prefix: beat.Store + '/', base: /^music/ }],
        },
        { id: 'grid', label: '分析节拍', step: 'beat', page: 'beat', produces: [{ prefix: beat.Store + '/' }] },
        // 节拍确认看 grid.json，由编排与 onset 写，不经界面按钮，所以没有 gateFiles。
        { id: 'gate-grid', label: '试听节拍', step: 'beat', gate: true, page: 'beat' },
      ],
      flows: [],
      after: '',
      sections: [{ id: 'grid', file: 'sections/grid.md' }],
      judges: {
        music: {
          output: (c) => f(c, beat.TrackFile),
          guide: { ai: 'AI 在导入音乐。', user: '把要用的配乐文件拖进下面的输入框，告诉 AI 用它。', actions: [{ kind: 'draft', label: '写给 AI', text: '配乐用这首：' }] },
        },
        grid: {
          output: (c) => anyOf(c, beat.DraftFile, beat.GridFile),
          stale: (c, out) => f(c, beat.TrackFile) > out,
          guide: { ai: 'AI 在分析音乐的节拍。' },
        },
        'gate-grid': {
          gateState: (c) => {
            const grid = readGrid(c.root, beat.GridFile);
            if (!grid) return { status: 'todo' };
            const draft = readGrid(c.root, beat.DraftFile);
            const pending = draft !== null && !sameDownbeats(draft, grid);
            return { status: pending ? 'changed' : 'confirmed', at: f(c, beat.GridFile) };
          },
          guide: {
            user: '节拍要你听一遍：重拍对不对、每小节几拍。在节拍页边播边听，不对可以直接改。',
            actions: [{ kind: 'page', label: '去听节拍', page: 'beat' }, { kind: 'say', label: '对的，继续', text: '节拍我听过了，没问题，继续。' }],
          },
        },
      },
    });
    ctx.station({
      id: 'beat-plan',
      name: '按小节分镜',
      nodes: [
        { id: 'plan', label: '分镜计划', step: 'beat', page: 'beat', produces: [{ path: beat.PlanFile }, ...planRules] },
        { id: 'gate-beat-storyboard', label: '分镜审核', step: 'storyboard', gate: true, page: 'storyboard', gateFiles: [beat.PlanFile] },
      ],
      flows: [],
      after: '',
      sections: [
        { id: 'stage', file: 'sections/plan-stage.md', stage: 'beat-plan', title: '按小节拆分镜头' },
        { id: 'plan', file: 'sections/plan.md' },
        { id: 'budget', file: 'sections/budget.md' },
        { id: 'storyboard-gate', file: 'sections/storyboard-gate.md' },
      ],
      judges: {
        plan: {
          output: (c) => f(c, beat.PlanFile),
          stale: (c, out) => f(c, beat.GridFile) > out,
        },
        'gate-beat-storyboard': {
          guide: {
            user: '分镜写好了。渲染前先看一遍每个镜头卡在哪几个小节、画什么。',
            actions: [{ kind: 'page', label: '看分镜', page: 'storyboard' }, { kind: 'gate', label: '没问题，开始渲染', gate: 'gate-beat-storyboard' }, change('分镜')],
            confirm: '分镜我看过了，没问题，开始渲染。',
          },
        },
      },
    });
    // 宿主段落的卡点版：不上路线，只由流程 beat 的段落顺序点名。开阶段的段落标题与宿主那一版相同（音乐两段除外）。
    ctx.station({
      id: CommonStation,
      name: '卡点的公共约定与各阶段',
      nodes: [],
      flows: [],
      after: '',
      sections: [
        { id: 'head', file: 'sections/head.md' },
        { id: 'work', file: 'sections/work.md' },
        { id: 'intake', file: 'sections/intake.md', stage: 'intake', title: '盘点输入和制作规格' },
        { id: 'film-style', file: 'sections/film-style.md' },
        { id: 'film-style-using', file: 'sections/film-style-using.md' },
        { id: 'film-style-mix', file: 'sections/film-style-mix.md' },
        { id: 'treatment', file: 'sections/treatment.md' },
        { id: 'render', file: 'sections/render.md', stage: 'render', title: '建立镜头目录、并发调度渲染工具' },
        { id: 'run', file: 'sections/run.md' },
        { id: 'visual-qc', file: 'sections/visual-qc.md', stage: 'visual-qc', title: '首帧封面和视觉验收' },
        { id: 'assemble', file: 'sections/assemble.md', stage: 'assemble', title: '规范化和拼接静音母版' },
        // 音乐就是导入的那一首，没有人声，所以这两个阶段的标题也与口播不同。
        { id: 'sound', file: 'sections/sound.md', stage: 'beat-sound', title: '音乐授权和音效' },
        { id: 'mix', file: 'sections/mix.md', stage: 'beat-mix', title: '音乐与音效的混合' },
        { id: 'review', file: 'sections/review.md', stage: 'review', title: '最终验收、试听与交付' },
        { id: 'deliverables-tail', file: 'sections/deliverables-tail.md' },
      ],
    });
    ctx.flow({
      id: BeatFlow,
      name: '卡点',
      stations: ['beat-story', 'beat-music', 'style', 'beat-plan', ...tailStations],
      prompt: [...beatPrompt],
      // 两种流程共用的段落（整片风格）引用的「选 BGM 和 SFX」在卡点里是「音乐授权和音效」。
      stage_aliases: { sound: 'beat-sound' },
      first_page: 'beat',
      land_first: true,
      marker: { file: beat.ConfigFile, body: beat.DefaultConfig },
      excludes: { plugins: ['cast'], flows: ['song'], message: '卡点模式不能与歌曲讲解或多角色对话同时启用' },
    });

    beatOps(ctx);
    ctx.opGroup(beatGroup);
    ctx.sceneBlock(beatBlock);
    ctx.renderCheck({
      // 渲染之前核对全部镜头的 beat 块与网格、分镜计划一致：等全部渲染完拼接时才发现，每一镜都已经烧掉一次 AI CLI 调用。
      beforeRender(root, scenes) {
        if (beat.enabled(root)) beatCoverage(root, scenes);
      },
    });

    ctx.page({ id: 'beat', label: '节拍', target: '', after: 'progress' });
    ctx.route({ pattern: '/api/beat', handle: (host) => beatAPI(host) });
    ctx.step({ id: 'beat', label: '节拍', hint: '节拍：故事、音乐、节拍网格、分镜计划', before: 'script', flow: '卡点' });
    ctx.command({ id: 'beat.confirm', label: '确认卡点网格', op: 'beat_confirm', params: (_body, root) => ({ params: { project_root: root } }) });
    ctx.command({
      id: 'beat.regrid',
      label: '重排重拍',
      op: 'beat_regrid',
      params: (body, root) => {
        const { meter, anchor } = body;
        if (!Number.isInteger(meter) || !Number.isInteger(anchor) || (meter as number) < 1 || (meter as number) > 16 || (anchor as number) < 0 || (anchor as number) >= (meter as number)) {
          return { error: { code: 'invalid_regrid', message: '拍号要在 1..16 之间，起始拍要在 0..拍号-1 之间' } };
        }
        return { params: { meter, anchor, project_root: root }, label: `（${meter} 拍，从第 ${(anchor as number) + 1} 拍起）` };
      },
    });

    ctx.prereq({
      group: 'beat',
      id: 'beat',
      // 只有卡点项目要：不选卡点就用不到这一套近 1 GB 的 Python 环境。
      required: false,
      name: '节拍分析环境 beat-this',
      version: beat.AnalyzerVersion,
      later: { title: '音乐卡点', desc: '跟着节奏切镜头的片子用 · 约 1 GB', icon: 'music' },
      ready: (env) => {
        const dir = beat.envDir(env);
        return [beat.envReady(dir), dir];
      },
      prepare: async (run, signal) => {
        // pip 用用户自己的 pip.conf（国内镜像），不套代理，理由同 npm；权重在境外服务器上，--proxy 只给它。
        const weightsEnv = { ...run.base };
        if (run.proxy) weightsEnv.HTTPS_PROXY = weightsEnv.https_proxy = run.proxy;
        // 系统里没有能装 torch 的 Python 时，先下载 uv，由它带一份独立的 Python（不要求用户装 Python）。
        if (!(await beat.hasBasePython(run.base, signal))) {
          await toolinstall.ensureUV({ env: withProxy(run), output: run.log, progress: (p) => run.stage(hyperframesStage(p)), signal });
        }
        await beat.ensureEnv({ env: run.base, weightsEnv, output: run.log, progress: (p) => run.stage(hyperframesStage(p)) }, signal);
      },
    });
    // 节拍分析环境的目录：默认由 XDG_DATA_HOME 推出而它不在子进程白名单里，编排工具调用的 beat_analyze
    // 会算出另一个目录、找不到 onset setup 装好的那一套，就会想自己去建。
    ctx.childEnv({ key: beat.EnvDirEnv, value: (env) => beat.envDir(env) });

    ctx.preset({
      id: 'beat',
      label: '音乐卡点',
      hint: '没有配音，画面踩着节拍切',
      delivery: BeatFlow,
      narration: 'solo',
      canvas: 'vertical-9x16',
      example: '用一首轻快的曲子做卡点短片，每个重拍切一个画面',
    });
    ctx.presentIn((root) => (fs.existsSync(path.join(root, beat.ConfigFile)) ? beat.ConfigFile : ''));
  },
};
