/**
 * 内置的站与流程。
 *
 * 制作提示词（productionPrompt）现在仍是一份：口播、卡点、歌曲讲解共用，卡点与歌曲讲解是文末的分支。
 * 拼出来的结果与拆分前的 PROMPT-PRODUCTION.md 逐字节相同（gen.test.ts 的「matches the committed
 * assets byte-for-byte」守着）。各流程拼自己的提示词是下一步的事。
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
    prompt: [{ id: 'head' }, { id: 'deliverables' }],
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
    prompt: [{ id: 'stage', stage: 'intake' }],
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
          { prefix: 'assets/style-guide/' },
          { path: 'frame.md' },
          { path: 'docs/style-brief.md' },
        ],
      },
    ],
    prompt: [{ id: 'film-style' }],
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
    prompt: [{ id: 'treatment' }, { id: 'stage', stage: 'plan' }, { id: 'storyboard-gate' }],
  },
  {
    id: 'render',
    name: '渲染镜头',
    nodes: [{ id: 'render', label: '渲染镜头', step: 'scene', page: 'scene', produces: [{ prefix: 'scenes/' }] }],
    prompt: [{ id: 'stage', stage: 'render' }],
  },
  {
    id: 'visual-qc',
    name: '画面验收',
    nodes: [{ id: 'visual-qc', label: '画面验收', step: 'scene', produces: [{ prefix: 'production/visual-qc/' }] }],
    prompt: [{ id: 'stage', stage: 'visual-qc' }],
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
    prompt: [{ id: 'stage', stage: 'assemble' }],
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
    prompt: [{ id: 'stage', stage: 'review' }],
  },
  {
    id: 'publish',
    name: '发布',
    nodes: [{ id: 'publish', label: '封面与发布信息', step: 'publish', page: 'publish', produces: [{ path: 'publish.md' }, { prefix: 'covers/' }] }],
    prompt: [{ id: 'config-lifecycle' }, { id: 'stage', stage: 'publish' }],
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
    prompt: [{ id: 'branch-intro' }, { id: 'story' }],
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
    prompt: [{ id: 'plan' }],
  },
];

/** 口播与卡点共用的后半程。 */
const tail = ['render', 'visual-qc', 'assemble', 'sound', 'review', 'publish', 'wrapup'];

export const builtinFlows: readonly Flow[] = [
  { id: 'speech', name: '口播', stations: ['intake', 'script', 'voice', 'timeline', 'style', 'plan', ...tail] },
  { id: 'beat', name: '卡点', stations: ['beat-story', 'beat-music', 'style', 'beat-plan', ...tail] },
];

/**
 * 各阶段的标题（「## 第六阶段：<标题>」冒号后面那段）。第三方站往某个阶段里插说明时按标题找：
 * 项目里那份提示词只有编号与标题，编号会随流程变，标题不变。flow.test.ts 核对它与模板一致。
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
  publish: '刷新发布配置',
  wrapup: '项目收尾与归档',
};

/** 制作提示词的段落顺序：「站/段」。 */
export const productionPrompt: readonly string[] = [
  'host/head',
  'intake/stage',
  'style/film-style',
  'publish/config-lifecycle',
  'script/stage',
  'plan/treatment',
  'voice/stage',
  'timeline/stage',
  'plan/stage',
  'render/stage',
  'plan/storyboard-gate',
  'visual-qc/stage',
  'assemble/stage',
  'sound/stage',
  'sound/mix',
  'review/stage',
  'publish/stage',
  'host/deliverables',
  'wrapup/stage',
  'beat-story/branch-intro',
  'beat-story/story',
  'beat-music/grid',
  'beat-plan/plan',
];
