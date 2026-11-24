/**
 * 真人口播 / 录屏增强双时钟操作（presenter_remap）。
 */
import fs from 'node:fs';
import { atomicWrite } from '@onset/engine/fsutil';
import * as presenter from '@onset/engine/presenter';
import { defineGroup } from './ops/cli';
import { str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['presenter'],
  summary: '真人口播 / 录屏双时钟剪辑映射与受管字幕导出',
  description:
    '建立真人口播或录屏源素材到输出时间轴的精确双时钟映射，支持字幕自动随剪切/倍速重映射、导出 SRT/VTT 及以注释边界就地切换字幕样式。',
});

defineOp({
  name: 'presenter_remap',
  cli: ['presenter', 'remap'],
  summary: '按源片剪辑映射表将字幕/事件从源时钟重映射到输出时间轴，并导出 SRT/VTT',
  description: `处理真人口播或录屏精剪时的「源时间 ≠ 输出时间」问题：输入选段 JSON（EditSegment[]）与源字幕 JSON（SourceCue[]），
按 timelineStart + (sourceTime - sourceStart) / playbackRate 精确计算输出时间轴并可选写出 SRT/VTT 文件。`,
  examples: [
    'presenter_remap({"segments_json": "[{\\"id\\":\\"s1\\",\\"source_start\\":12,\\"source_end\\":18,\\"role\\":\\"presenter\\"}]", "cues_json": "[{\\"start\\":12,\\"end\\":15,\\"text\\":\\"你好\\"}]", "format": "srt"})',
  ],
  params: {
    segments_json: { type: 'string', description: '剪辑选段 JSON 数组（EditSegment[]）', required: true },
    cues_json: { type: 'string', description: '源字幕/关键词 JSON 数组（SourceCue[]）', required: true },
    format: { type: 'string', description: '导出格式：srt 或 vtt，默认 srt' },
    out_file: { type: 'string', description: '可选：写出字幕文件路径' },
  },
  run: async (p, { out }) => {
    const rawSegs = JSON.parse(str(p.segments_json)) as presenter.EditSegment[];
    const rawCues = JSON.parse(str(p.cues_json)) as presenter.SourceCue[];
    const timeline = presenter.buildOutputTimeline(rawSegs);
    const remapped = presenter.remapCuesToOutput(timeline.segments, rawCues);
    const fmt = str(p.format) === 'vtt' ? 'vtt' : 'srt';
    const text = presenter.formatOutputCues(remapped, fmt);
    const outFile = str(p.out_file);
    if (outFile) {
      atomicWrite(outFile, text, 0o644);
      out.write(
        `已写出 ${fmt.toUpperCase()}（${remapped.length} 条，总时长 ${timeline.total_duration}s）：${outFile}\n`,
      );
    } else {
      out.write(
        `已映射 ${timeline.segments.length} 个选段（总时长 ${timeline.total_duration}s），产出 ${remapped.length} 条字幕。\n`,
      );
    }
    return { data: { ...timeline, cues: remapped, formatted: text } };
  },
});

defineOp({
  name: 'presenter_patch_captions',
  cli: ['presenter', 'patch-captions'],
  summary: '以注释边界就地更新合成 HTML 中的受管字幕块样式与显隐',
  description:
    '在指定合成 index.html 中用 <!-- onset-caption:<track>:start/end --> 就地写入或切换字幕预设样式，不破坏其余源码。',
  examples: [
    'presenter_patch_captions({"html_file": "scenes/scene-001/index.html", "track_id": "main", "cues_json": "[]", "preset": "highlight", "position": "bottom"})',
  ],
  params: {
    html_file: { type: 'string', description: '目标合成 HTML 路径', required: true },
    track_id: { type: 'string', description: '受管轨道 ID，默认 main' },
    cues_json: { type: 'string', description: '输出字幕 JSON 数组（OutputCue[]）', required: true },
    preset: { type: 'string', description: '样式预设：minimal / highlight / box / editorial' },
    position: { type: 'string', description: '位置：bottom / center / top' },
    visible: { type: 'boolean', description: '是否显示', default: true },
  },
  run: async (p, { out }) => {
    const file = str(p.html_file);
    const html = fs.readFileSync(file, 'utf8');
    const cues = JSON.parse(str(p.cues_json)) as presenter.OutputCue[];
    const presetRaw = str(p.preset);
    const preset = (
      ['minimal', 'highlight', 'box', 'editorial'].includes(presetRaw) ? presetRaw : 'minimal'
    ) as presenter.CaptionStylePreset['preset'];
    const posRaw = str(p.position);
    const position = (
      ['bottom', 'center', 'top'].includes(posRaw) ? posRaw : 'bottom'
    ) as presenter.CaptionStylePreset['position'];
    const next = presenter.patchManagedCaptionBlock(html, str(p.track_id) || 'main', cues, {
      preset,
      position,
      scale: 1,
      visible: p.visible !== false,
    });
    atomicWrite(file, next, 0o644);
    out.write(`已就地更新受管字幕块：${file}（${cues.length} 条，预设 ${preset}）\n`);
    return { data: { file, cue_count: cues.length, preset, position } };
  },
});
