import path from 'node:path';
import { goRound } from '../gofmt';
import { frameTime, type Prober, type Report, type Resolved, SeamFrames, type Tile } from './types';

const segmentColumns = 3;
const sampleColumns = 4;

/** planTiles 按镜头取首、中、末帧；没有镜头信息时按固定间隔取帧并补上末帧。 */
function planTiles(opts: Resolved, counted: number): [Tile[], number] {
  const tiles: Tile[] = [];
  if (opts.segments.length > 0) {
    let cursor = 0;
    for (const segment of opts.segments) {
      const spots: [string, number][] = [
        ['start', cursor],
        ['middle', cursor + Math.trunc(segment.frames / 2)],
        ['end', cursor + segment.frames - 1],
      ];
      for (const [position, frame] of spots) {
        tiles.push({ scene_id: segment.id, position, frame, at_seconds: frameTime(frame, opts.fps) });
      }
      cursor += segment.frames;
    }
    return [tiles, segmentColumns];
  }
  const lastFrame = counted - 1;
  const step = Math.max(1, Math.trunc(goRound(opts.every * opts.fps)));
  for (let frame = 0; frame < lastFrame; frame += step) {
    tiles.push({ scene_id: '', position: 'sample', frame, at_seconds: frameTime(frame, opts.fps) });
  }
  if (lastFrame >= 0) {
    tiles.push({ scene_id: '', position: 'end', frame: lastFrame, at_seconds: frameTime(lastFrame, opts.fps) });
  }
  return [tiles, sampleColumns];
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** writeSheets 分页生成联系表。 */
export function writeSheets(p: Prober, report: Report, opts: Resolved): void {
  const [planned, columns] = planTiles(opts, report.counted_frames);
  const tiles = planned.filter((tile) => tile.frame < report.counted_frames);
  const perSheet = Math.max(columns, Math.trunc(opts.tilesPerSheet / columns) * columns);
  for (let start = 0, page = 1; start < tiles.length; start += perSheet, page++) {
    const chunk = tiles.slice(start, Math.min(start + perSheet, tiles.length));
    const image = path.join(opts.outDir, `sheet-${pad2(page)}.png`);
    p.contactSheet(
      opts.video,
      chunk.map((tile) => tile.at_seconds),
      columns,
      opts.thumbWidth,
      image,
    );
    report.sheets.push({ image, columns, tiles: chunk });
  }
}

/** writeSeams 为每个落在成片范围内的交界出一张逐帧条带。 */
export function writeSeams(p: Prober, report: Report, opts: Resolved): void {
  report.cuts.forEach((cut, i) => {
    const tiles: Tile[] = [];
    for (
      let frame = Math.max(0, cut.frame - SeamFrames);
      frame < Math.min(report.counted_frames, cut.frame + SeamFrames);
      frame++
    ) {
      const after = frame >= cut.frame;
      tiles.push({
        scene_id: after ? cut.to : cut.from,
        position: after ? 'after' : 'before',
        frame,
        at_seconds: frameTime(frame, opts.fps),
      });
    }
    const image = path.join(opts.outDir, `seam-${pad2(i + 1)}.png`);
    p.contactSheet(
      opts.video,
      tiles.map((tile) => tile.at_seconds),
      SeamFrames,
      opts.thumbWidth,
      image,
    );
    report.seams.push({ image, columns: SeamFrames, tiles });
  });
}
