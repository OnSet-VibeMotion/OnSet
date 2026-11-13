/**
 * 内置的站与流程。
 *
 * 每个流程既定路线（stations）也定制作提示词的段落顺序（prompt），运行期按它组合（compose.ts），这是制作提示词唯一的来源。
 * 段落正文在 assets/prompts/<站>/<段>.md；对某个流程不成立的话不写成「如果是卡点则…」，而是拆成更细的段落，
 * 由各流程的顺序挑自己那一版（例如 host/intro 与 host/intro-beat）。
 *
 * 这里只有宿主自己的站。内置插件在 apply 里登记的站（例如发布）由 registered.ts 并进来：
 * 要「全部的站、流程、阶段、段落顺序」时用 allStations / allFlows / allStageTitles / flowPrompt。
 */
import * as beat from '../beat';
import type { Flow, PathRule, Station } from './types';

/** 分镜计划与镜头说明：口播与卡点的「拆分镜头」都写这些。 */
const planRules: PathRule[] = [
  { path: 'production/treatment.md' },
  { prefix: 'production/scene-plan' },
  { path: 'production/visible-event-inventory.json' },
  { prefix: 'scenes/', base: /^(scene\.json|prompt\.md)$/ },
];

export const builtinStations: readonly Station[] = [
  {
    id: 'host',
    name: '公共约定',
    nodes: [],
    prompt: [
      { id: 'head' },
      { id: 'head-beat' },
      { id: 'work' },
      { id: 'work-beat' },
      { id: 'renderer' },
      { id: 'deliverables' },
      { id: 'deliverables-tail' },
      { id: 'deliverables-tail-beat' },
    ],
  },
  {
    id: 'intake',
    name: '盘点素材与规格',
    nodes: [
      {
        id: 'intake',
        label: '盘点素材与规格',
        step: 'script',
        file: 'production/input-inventory.md',
        produces: [
          { path: 'production/input-inventory.md' },
          { path: 'production/input-manifest.json' },
          { path: 'production/production-config.json' },
          { path: 'article-to-motion.conf' },
        ],
      },
    ],
    prompt: [{ id: 'stage', stage: 'intake' }, { id: 'stage-beat', stage: 'intake' }, { id: 'visual' }],
  },
  {
    id: 'script',
    name: '口播稿',
    nodes: [
      {
        id: 'script',
        label: '整理口播稿',
        step: 'script',
        page: 'script',
        produces: [{ path: 'production/script-final.md' }, { path: 'production/script-change-log.md' }, { path: 'script.md' }, { path: 'SCRIPT.md' }],
      },
      { id: 'gate-script', label: '稿件审核', step: 'script', gate: true, page: 'script', gateFiles: ['production/script-final.md'] },
    ],
    prompt: [{ id: 'stage', stage: 'script' }],
  },
  {
    id: 'voice',
    name: '配音',
    nodes: [
      { id: 'voice', label: '配音', step: 'script', file: 'production/audio/voice.wav', produces: [{ prefix: 'production/audio/' }] },
      { id: 'gate-voice', label: '配音审核', step: 'script', gate: true, file: 'production/audio/voice.wav', gateFiles: ['production/audio/voice.wav'] },
    ],
    prompt: [{ id: 'stage', stage: 'voice' }],
  },
  {
    id: 'timeline',
    name: '字幕时间轴',
    nodes: [
      {
        id: 'timeline',
        label: '字幕时间轴',
        step: 'script',
        file: 'production/audio/voice.srt',
        produces: [
          { prefix: 'production/audio/', base: /^(align|voice-16k|production-srt)|^voice\.srt$/ },
          { path: 'production/phrase-timeline.json' },
          { path: 'production/phrase-adjust.json' },
          { path: 'production/timing-report.json' },
          { path: 'transcription-production.srt' },
          { path: 'transcription.srt' },
        ],
      },
    ],
    prompt: [{ id: 'stage', stage: 'timeline' }],
  },
  {
    id: 'style',
    name: '整片风格',
    nodes: [
      {
        id: 'style',
        label: '定整片风格',
        step: 'storyboard',
        optional: true,
        page: 'style',
        produces: [
          { prefix: '.agents/skills/am-film-style/' },
          { prefix: '.agents/am-film-styles/' },
        ],
      },
    ],
    prompt: [{ id: 'film-style' }, { id: 'film-style-beat' }, { id: 'film-style-using' }, { id: 'film-style-using-beat' }, { id: 'film-style-mix' }, { id: 'film-style-mix-beat' }],
  },
  {
    id: 'plan',
    name: '拆分镜头',
    nodes: [
      { id: 'plan', label: '拆分镜头', step: 'storyboard', page: 'storyboard', produces: planRules },
      {
        id: 'gate-storyboard',
        label: '分镜审核',
        step: 'storyboard',
        gate: true,
        page: 'storyboard',
        gateFiles: ['production/scene-plan.json', 'production/treatment.md'],
      },
    ],
    prompt: [{ id: 'treatment' }, { id: 'treatment-beat' }, { id: 'stage', stage: 'plan' }, { id: 'budget' }, { id: 'storyboard-gate' }],
  },
  {
    id: 'render',
    name: '渲染镜头',
    nodes: [{ id: 'render', label: '渲染镜头', step: 'scene', page: 'scene', produces: [{ prefix: 'scenes/' }] }],
    prompt: [{ id: 'stage', stage: 'render' }, { id: 'stage-beat', stage: 'render' }, { id: 'cues' }, { id: 'run' }, { id: 'run-beat' }],
  },
  {
    id: 'visual-qc',
    name: '画面验收',
    nodes: [{ id: 'visual-qc', label: '画面验收', step: 'scene', produces: [{ prefix: 'production/visual-qc/' }] }],
    prompt: [
      { id: 'stage', stage: 'visual-qc' },
      { id: 'stage-beat', stage: 'visual-qc' },
    ],
  },
  {
    id: 'assemble',
    name: '拼接母版',
    nodes: [
      {
        id: 'assemble',
        label: '拼接母版',
        step: 'final',
        file: 'production/silent-master.mp4',
        produces: [{ prefix: 'production/silent-master' }, { prefix: 'production/review-silent' }],
      },
    ],
    prompt: [
      { id: 'stage', stage: 'assemble' },
      { id: 'stage-beat', stage: 'assemble' },
    ],
  },
  {
    id: 'sound',
    name: '配乐、音效与混音',
    nodes: [
      {
        id: 'sound',
        label: '配乐、音效与混音',
        step: 'final',
        file: 'production/audio/candidate.mp4',
        produces: [{ prefix: 'production/audio/', base: /^(music|sfx|premaster|premix|candidate|cue-sheet|asset-ledger|sound-checklist|machine-qc)/ }],
      },
    ],
    prompt: [
      { id: 'stage', stage: 'sound' },
      { id: 'mix', stage: 'mix' },
      // 卡点：音乐就是导入的那一首，没有人声，所以这两个阶段的标题也不同。
      { id: 'stage-beat', stage: 'beat-sound' },
      { id: 'mix-beat', stage: 'beat-mix' },
    ],
  },
  {
    id: 'review',
    name: '复查与试听',
    nodes: [
      { id: 'review', label: '整片复查', step: 'final', page: 'review', produces: [{ prefix: 'production/review/' }, { path: 'production/final-check.json' }] },
      {
        id: 'gate-final',
        label: '试听确认',
        step: 'final',
        gate: true,
        page: 'final',
        produces: [{ path: 'production/approval.json' }, { path: 'final.mp4' }, { path: 'production/final.mp4' }],
      },
    ],
    prompt: [
      { id: 'stage', stage: 'review' },
      { id: 'stage-beat', stage: 'review' },
    ],
  },
  {
    id: 'wrapup',
    name: '收尾与归档',
    nodes: [],
    prompt: [{ id: 'stage', stage: 'wrapup' }],
  },
  {
    id: 'beat-story',
    name: '故事与文案',
    nodes: [
      { id: 'story', label: '故事与文案', step: 'beat', page: 'beat', produces: [{ path: beat.Store + '/story.md' }] },
      { id: 'gate-story', label: '故事审核', step: 'beat', gate: true, page: 'beat', gateFiles: [beat.Store + '/story.md'] },
    ],
    prompt: [{ id: 'stage', stage: 'beat' }, { id: 'story' }],
  },
  {
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
      // 节拍确认看 grid.json，由编排与 am 写，不经界面按钮，所以没有 gateFiles。
      { id: 'gate-grid', label: '试听节拍', step: 'beat', gate: true, page: 'beat' },
    ],
    prompt: [{ id: 'grid' }],
  },
  {
    id: 'beat-plan',
    name: '按小节分镜',
    nodes: [
      { id: 'plan', label: '分镜计划', step: 'beat', page: 'beat', produces: [{ path: beat.PlanFile }, ...planRules] },
      { id: 'gate-beat-storyboard', label: '分镜审核', step: 'storyboard', gate: true, page: 'storyboard', gateFiles: [beat.PlanFile] },
    ],
    prompt: [{ id: 'stage', stage: 'beat-plan' }, { id: 'plan' }, { id: 'budget' }, { id: 'storyboard-gate' }],
  },
];

/** 口播与卡点共用的后半程（发布由内置插件 publishing 排在 review 后面）。 */
const tail = ['render', 'visual-qc', 'assemble', 'sound', 'review', 'wrapup'];

/** 口播流程的段落顺序：「站/段」。插件的段落按各自的 after 插进来（registered.flowPrompt）。 */
export const speechPrompt: readonly string[] = [
  'host/head',
  'host/work',
  'host/renderer',
  'intake/stage',
  'intake/visual',
  'style/film-style',
  'style/film-style-using',
  'style/film-style-mix',
  'script/stage',
  'plan/treatment',
  'voice/stage',
  'timeline/stage',
  'plan/stage',
  'plan/budget',
  'render/stage',
  'render/cues',
  'plan/storyboard-gate',
  'render/run',
  'visual-qc/stage',
  'assemble/stage',
  'sound/stage',
  'sound/mix',
  'review/stage',
  'host/deliverables',
  'host/deliverables-tail',
  'wrapup/stage',
];

/**
 * 卡点流程的段落顺序：没有口播稿、配音、对齐三个阶段，开自己的阶段「故事、音乐与节拍」「按小节拆分镜头」；
 * 对无配音的片子不成立的段落各有一版（-beat）。
 */
export const beatPrompt: readonly string[] = [
  'host/head-beat',
  'host/work-beat',
  'host/renderer',
  'intake/stage-beat',
  'intake/visual',
  'style/film-style-beat',
  'style/film-style-using-beat',
  'style/film-style-mix-beat',
  'beat-story/stage',
  'beat-story/story',
  'plan/treatment-beat',
  'beat-music/grid',
  'beat-plan/stage',
  'beat-plan/plan',
  'beat-plan/budget',
  'render/stage-beat',
  'beat-plan/storyboard-gate',
  'render/run-beat',
  'visual-qc/stage-beat',
  'assemble/stage-beat',
  'sound/stage-beat',
  'sound/mix-beat',
  'review/stage-beat',
  'host/deliverables',
  'host/deliverables-tail-beat',
  'wrapup/stage',
];

export const builtinFlows: readonly Flow[] = [
  { id: 'speech', name: '口播', stations: ['intake', 'script', 'voice', 'timeline', 'style', 'plan', ...tail], prompt: [...speechPrompt], first_page: 'script' },
  {
    id: 'beat',
    name: '卡点',
    stations: ['beat-story', 'beat-music', 'style', 'beat-plan', ...tail],
    prompt: [...beatPrompt],
    // 两种流程共用的段落（整片风格）引用的「选 BGM 和 SFX」在卡点里是「音乐授权和音效」。
    stage_aliases: { sound: 'beat-sound' },
    first_page: 'beat',
    land_first: true,
    marker: { file: beat.ConfigFile, body: beat.DefaultConfig },
    excludes: { plugins: ['cast'], flows: ['song'], message: '卡点模式不能与歌曲讲解或多角色对话同时启用' },
  },
];

/**
 * 各阶段的标题（「## 第六阶段：<标题>」冒号后面那段）：第三方站的阶段补充找不到那个阶段、第三方流程引用了它没有的阶段时，
 * 用标题说明是哪一步。flow.test.ts 核对它与模板一致。
 */
export const stageTitles: Readonly<Record<string, string>> = {
  intake: '盘点输入和制作规格',
  script: '整理口播稿和开场',
  voice: 'TTS 和断句校对',
  timeline: '依据实际语音重建 SRT',
  plan: '按语义拆分镜头',
  render: '建立镜头目录、并发调度渲染工具',
  'visual-qc': '首帧封面和视觉验收',
  assemble: '规范化和拼接静音母版',
  sound: '选择 BGM 和 SFX',
  mix: '配音优先的声音混合',
  review: '最终验收、试听与交付',
  wrapup: '项目收尾与归档',
  beat: '故事、音乐与节拍',
  'beat-plan': '按小节拆分镜头',
  'beat-sound': '音乐授权和音效',
  'beat-mix': '音乐与音效的混合',
};
