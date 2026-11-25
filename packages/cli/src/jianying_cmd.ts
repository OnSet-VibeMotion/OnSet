/**
 * 剪映可二次编辑素材包导出操作（project_export_jianying）。
 */
import * as jianying from '@onset/engine/jianying';
import { currentEnvironment } from './cli';
import { defineGroup } from './ops/cli';
import { bool, projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['jianying'],
  summary: '剪映可二次编辑分镜分轨素材包导出',
  description:
    '按时间轴精确重编码导出纯画面分镜（clips/shot-NN.mp4）、对齐分轨音频（audio/）、字幕与元数据清单，可选生成通用剪映草稿骨架。',
});

defineOp({
  name: 'project_export_jianying',
  cli: ['jianying', 'export'],
  summary: '导出剪映可二次编辑素材包（分镜纯画面 + 分轨音频 + 字幕 + 可选通用草稿骨架）',
  description: `将片场工程导出至指定输出目录（默认 <project>/exports/jianying-<name>/，防路径穿越）：
- clips/shot-01.mp4 ...：libx264 CRF 18 + yuv420p + BT.709 + 强制首帧关键帧精确重编码，无声纯画面轨（绝不用 -c copy）；
- audio/：voice.wav、bgm.wav（如有）、sfx.wav（如有），48kHz 立体声 PCM16 与视频总帧数严格对齐；
- subtitles.srt（如有字幕时间轴）、shots.json、audio.json 与 README.md；
- 传入 include_draft=true 时额外生成通用剪映草稿骨架 draft_content.json 与 draft_meta_info.json（未绑定特定剪映宿主版本）。`,
  examples: [
    'project_export_jianying({"project_root": "."})',
    'project_export_jianying({"project_root": ".", "dest": "exports/jianying-v1", "include_draft": true})',
  ],
  params: {
    project_root: projectRoot,
    dest: {
      type: 'string',
      description: '输出目录路径；留空默认导出到 <project>/exports/jianying-<name>/',
      positional: 0,
    },
    name: { type: 'string', description: '素材包名称；留空取项目目录名' },
    include_draft: {
      type: 'boolean',
      description: '是否额外生成通用剪映草稿骨架 draft_content.json 与 draft_meta_info.json（默认关闭）',
    },
    overwrite: { type: 'boolean', description: '目标目录已存在且非空时是否允许覆盖（默认关闭）' },
  },
  run: async (p, { out, signal }) => {
    const root = str(p.project_root) || '.';
    const res = await jianying.exportJianying(root, {
      dest: str(p.dest) || undefined,
      name: str(p.name) || undefined,
      includeDraft: bool(p.include_draft),
      overwrite: bool(p.overwrite),
      env: currentEnvironment(),
      signal,
    });
    out.write(
      `已导出剪映素材包「${res.name}」（${res.clips.length} 镜 / ${res.total_frames} 帧，${res.audio_tracks.length} 条音轨` +
        (res.subtitles ? '，含字幕' : '') +
        (res.draft ? '，含通用草稿骨架' : '') +
        `）：${res.output_dir}\n`,
    );
    if (res.draft) out.write(`说明：${res.draft.compatibility_note}\n`);
    return { data: res };
  },
});
