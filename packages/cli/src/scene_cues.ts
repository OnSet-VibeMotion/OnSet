/**
 * scene_cues：由字幕或短语锚点推导口播镜头的帧区间，写入各镜头的 duration_seconds 与 timing 块。
 */
import * as scene from '@onset/engine/scene';
import { bool, num, str } from './ops/common';
import { defineOp } from './ops/op';
import { runSceneCues } from './scene_cues_run';

export { commitWrites, type JSONField, type PendingWrite, rewriteJSONObject } from './scene_cues_json';

function styleShiftList(): string {
  return scene.StyleShifts.map((x) => `${x.id}（${x.name}，配 ${x.devices.join('/')}）`).join('、');
}

function handoffDeviceList(): string {
  return scene.HandoffDevices.map((d) => d.id).join('、');
}

defineOp({
  name: 'scene_cues',
  cli: ['scene', 'cues'],
  summary: '由字幕或短语锚点推导镜头帧区间，写入时长与 timing 块',
  description:
    `按分镜计划里每个镜头的起始锚点，把全片切成首尾相接的整数帧区间，
写入 scenes 下每个镜头 scene.json 的 duration_seconds（帧数 ÷ 帧率，保留 6 位小数）
与 timing 块。镜头时长从此由这一步决定，不要手算、不要手改。

分镜计划（plan，JSON）：
  {
    "schema": 1,
    "look": {"background": "#0F1720", "ink": "#F5F1E8", "accent": "#F2B134"},
    "scenes": [
      {"id": "scene-001", "dir": "scenes/scene-001", "chapter": "问题"},
      {"id": "scene-002", "dir": "scenes/scene-002", "chapter": "问题", "first_subtitle": 5},
      {"id": "scene-003", "dir": "scenes/scene-003", "chapter": "机制", "first_phrase": "p-07", "cut": "mid_gap",
       "handoff": {"device": "push_in", "bridge": "画面被琥珀色圆形表面铺满，中心一个 24px 的深色圆点"}}
    ]
  }

  id              必须与镜头目录里 scene.json 的 id 一致
  dir             镜头目录，相对 project_root；顺序必须与 scenes 下镜头目录的
                  字典序一一对应，不得遗漏或多出
  first_subtitle  本镜头第一条字幕在 srt 里的序号（按出现顺序，从 1 开始）
  first_phrase    本镜头第一条短语的 phrase_id，需要 phrases
  cut             切点规则，缺省 next_start：
                    next_start  切在锚点开始处，前面的无文字空白并入前一个镜头
                    prev_end    切在锚点前一条字幕/短语结束处，空白并入本镜头
                    mid_gap     切在空白正中（向下取整）
                  前一条与锚点重叠、没有空白时，三种规则都切在锚点开始处。
  look            可选，全片配色：background、ink、accent 必填，surface、accent_2 可选，
                  一律 #RRGGBB。写了就进每个镜头的提示词与 onset-scene.js，镜头不再自主选色
  chapter         可选，镜头所属章节；写了就每个镜头都要写，相邻镜头章节不同即章节交界
  handoff         从上一镜头进入本镜头的交接，章节交界必填、章节内可选：
                    device  手法：` +
    handoffDeviceList() +
    `
                    bridge  交界那一帧两侧共有的画面（物件、位置、大小、状态、底色），
                            不超过 200 字
                    style_shift  交界两侧风格不同时必填（风格相同时不能写），画法怎么换过去：
                            ` +
    styleShiftList() +
    `
                  相邻两个章节交界不得用同一种手法。交接写进两侧镜头的 timing.enter /
                  timing.exit，两个镜头的渲染提示词拿到同一份约定。
  film_style      可选，本镜头的整片风格：不写用项目的默认风格，「来源/目录名」用项目里装的
                  另一种（先 film_style_add()），none 不用整片风格。抄进镜头 scene.json 的
                  film_style；相邻镜头实际用的风格不同即风格交界，必须写 handoff.style_shift
  motion_effects  可选，本镜头选定的动效标识数组（支持简写 "005" 或完整 "来源:id"，
                  单镜最多 3 条）。校验存在性后抄进镜头 scene.json，渲染时自动注入配方并联动技能

first_subtitle 与 first_phrase 每个镜头恰好填一个；第一个镜头固定从第 0 帧开始，
可以不填。最后一个镜头延伸到 total_frames。锚点必须严格递增，每个镜头至少一帧，
合计正好等于 total_frames。秒换帧统一按「秒 × 帧率四舍五入」。

帧率缺省取镜头 frame.md 的画幅（全部镜头必须一致）；给了 fps 时必须与画幅相同。
给了 phrases 时，把短语时间轴原样复制进每个镜头目录（` +
    scene.PhraseCopyFile +
    `），
并写进 timing.phrases，渲染时据此生成局部短语表。

timing 块：{"fps", "start_frame", "end_frame_exclusive", "plan", "phrases",
"chapter", "look", "enter", "exit"}，
帧号是全片全局帧，plan 是分镜计划文件的 SHA-256。scene.json 其余字段与顺序不变。
任何一处不合格都不写文件；内容没变的文件不重写。

check 只重算并核对，不写文件：时长、timing 块或短语副本与重算结果不符
（例如有人手改了 duration_seconds）时逐条列出并失败。
镜头带自己时间轴的块（歌曲、卡点镜头）时拒绝：它们的时长由各自的 cues 操作决定。`,
  examples: [
    'scene_cues({"scenes": "scenes/", "plan": "production/scene-plan.json", "srt": "transcription-production.srt", "total_frames": 5400})',
    'scene_cues({"scenes": "scenes/", "plan": "production/scene-plan.json", "srt": "transcription-production.srt", "phrases": "production/phrase-timeline.json", "total_frames": 5400})',
    'scene_cues({"scenes": "scenes/", "check": true, "plan": "production/scene-plan.json", "srt": "transcription-production.srt", "total_frames": 5400})',
  ],
  params: {
    scenes: { type: 'string', description: '镜头目录的上级目录', required: true, positional: 0 },
    plan: { type: 'string', description: '分镜计划 JSON（必填）' },
    srt: { type: 'string', description: '全片字幕 SRT（必填）' },
    phrases: { type: 'string', description: '全片短语时间轴 phrase-timeline.json（可选）' },
    total_frames: { type: 'integer', description: '全片总帧数（必填）' },
    fps: { type: 'integer', description: '帧率，缺省取镜头画幅' },
    project_root: { type: 'string', description: '项目根目录，计划里的 dir 相对它解析', default: '.' },
    check: { type: 'boolean', description: '只核对，不写文件' },
  },
  run: (p, { out }) => {
    const data = runSceneCues(
      {
        plan: str(p.plan),
        srt: str(p.srt),
        phrases: str(p.phrases),
        projectRoot: str(p.project_root),
        scenesRoot: str(p.scenes),
        totalFrames: num(p.total_frames),
        fps: num(p.fps),
        check: bool(p.check),
      },
      out,
    );
    return { data };
  },
});
