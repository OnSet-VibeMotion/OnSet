import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '@onset/engine/fsutil';
import { marshalIndent } from '@onset/engine/gojson';
import { newToolchain, videoFPS } from '@onset/engine/mediaprobe';
import { rejectSymlinkPath } from '@onset/engine/project';
import { loadInventory } from '@onset/engine/reads';
import { canvasOf, contained, parsePhraseTimeline } from '@onset/engine/scene';
import { envMap } from '@onset/engine/envutil';
import { projectRoot, str, strs } from './ops/common';
import { defineOp } from './ops/op';

defineOp({
  name: 'phrase_frames',
  cli: ['scene', 'phrase-frames'],
  summary: '批量生成受保护短语的前三联帧证据',
  description: '从候选成片批量取短语开始前一帧、开始帧和已登记的稳定可读帧。联系表每行一个短语；没有对应可读元素的行会标记待复核。修订时可给 phrase_ids 只取指定短语。',
  examples: ['phrase_frames()', 'phrase_frames({"phrase_ids":["p-1","p-7"]})'],
  params: {
    project_root: projectRoot,
    video: { type: 'string', description: '已拼接的成片或静音母版', default: 'production/audio/candidate.mp4' },
    phrase_ids: { type: 'strings', description: '只取这些短语，留空为全片' },
  },
  run: (p, { out, signal }) => {
    const root = fs.realpathSync(str(p.project_root));
    const video = contained(root, str(p.video), '成片');
    const { fps } = canvasOf(root, 'frame.md');
    const timingFile = contained(root, 'production/phrase-timeline.json', '短语时间轴');
    const timeline = parsePhraseTimeline(fs.readFileSync(timingFile), fps);
    const ids = new Set(strs(p.phrase_ids));
    const selected = timeline.phrases!.filter(phrase => ids.size === 0 || ids.has(phrase.phrase_id));
    if (ids.size !== 0 && selected.length !== ids.size) throw new Error('phrase_ids 中有不在时间轴上的短语');
    const inventoryPath = contained(root, 'production/visible-event-inventory.json', '可见事件清单');
    const inventory = fs.existsSync(inventoryPath) ? loadInventory(inventoryPath) : null;
    if (inventory && inventory.fps !== fps) throw new Error('可见事件清单的帧率与画幅不符');
    const toolchain = newToolchain(envMap());
    const media = toolchain.probe(video);
    if (!media.video || Math.abs(videoFPS(media.video) - fps) > 0.00001) throw new Error('证据视频的帧率与画幅不符');
    const frames = toolchain.countFrames(video);
    const rows = selected.map(phrase => {
      const start = phrase.start_frame;
      if (start >= frames || phrase.end_frame_exclusive > frames) throw new Error(`短语 ${phrase.phrase_id} 超出成片`);
      const readable = (inventory?.events ?? []).filter(event =>
        event.phrase_id === phrase.phrase_id && event.readable_start_frame >= start &&
        event.readable_end_frame_exclusive > event.readable_start_frame && event.readable_start_frame < frames)
        .sort((a, b) => a.readable_start_frame - b.readable_start_frame)[0];
      const last = readable
        ? Math.floor((readable.readable_start_frame + Math.min(readable.readable_end_frame_exclusive, frames) - 1) / 2)
        : Math.floor((start + phrase.end_frame_exclusive - 1) / 2);
      return { phrase_id: phrase.phrase_id, frames: [Math.max(0, start - 1), start, last], has_previous: start > 0, registered_readable_frame: !!readable };
    });
    const dir = path.join(root, 'production/visual-qc');
    rejectSymlinkPath(root, dir);
    fs.mkdirSync(dir, { recursive: true });
    const evidence = fs.mkdtempSync(path.join(dir, 'phrase-evidence-'));
    const display = path.relative(root, evidence).split(path.sep).join('/');
    const sheets: { path: string; rows: typeof rows }[] = [];
    try {
      for (let i = 0; i < rows.length; i += 8) {
        signal.throwIfAborted();
        const page = rows.slice(i, i + 8);
        const name = `sheet-${sheets.length + 1}.png`;
        toolchain.contactSheet(video, page.flatMap(row => row.frames.map(frame => frame / fps)), 3, 360, path.join(evidence, name));
        sheets.push({ path: display + '/' + name, rows: page });
      }
      const manifest = display + '/report.json';
      atomicWrite(path.join(evidence, 'report.json'), marshalIndent({ video: str(p.video), fps, columns: ['before', 'start', 'readable'], sheets }) + '\n');
      out.write(`已取证 ${rows.length} 个短语，联系表 ${sheets.length} 张，位置 ${display}\n`);
      return { data: { report: manifest, sheets: sheets.map(sheet => sheet.path),
        needs_review: rows.filter(row => !row.registered_readable_frame).map(row => row.phrase_id) } };
    } catch (err) {
      fs.rmSync(evidence, { recursive: true, force: true });
      throw err;
    }
  },
});
