import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canvas } from '../assets';
import * as preset from '../preset';
import { create, DeliveryBeat, DeliverySong, DeliverySpeech, narrations, NarrationSolo, skillsInstalled, validate } from './index';

// 多角色对话插件登记的叙事模式。
const NarrationCast = 'cast';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-projectinit-'));

describe('projectinit', () => {
  it('rejects conflicting modes', () => {
    const dir = temp();
    for (const [delivery, narration] of [
      ['opera', NarrationSolo],
      [DeliverySpeech, 'choir'],
      [DeliveryBeat, NarrationCast],
      [DeliverySong, NarrationCast],
    ]) {
      expect(() => validate({ target: dir, canvas: '', delivery, narration }), `${delivery}/${narration}`).toThrow();
    }
    expect(() => validate({ target: dir, canvas: '', delivery: DeliverySpeech, narration: NarrationCast })).not.toThrow();
  });

  // 卡点写 beat.yaml、歌曲写 song.yaml、多角色写 cast.yaml 与 cast/。
  it('writes the mode files', () => {
    const cases: Record<string, [string, string, string[]]> = {
      beat: [DeliveryBeat, NarrationSolo, ['beat.yaml']],
      song: [DeliverySong, NarrationSolo, ['song.yaml']],
      cast: [DeliverySpeech, NarrationCast, ['cast.yaml', 'cast']],
      speech: [DeliverySpeech, NarrationSolo, ['article-to-motion.flow.json', 'frame.md']],
    };
    for (const [name, [delivery, narration, want]] of Object.entries(cases)) {
      const dir = path.join(temp(), name);
      create({ target: dir, canvas: preset.defaultPreset().id, delivery, narration, extra: { 'docs/note.md': 'x' } });
      for (const file of [...want, 'docs/note.md']) expect(fs.existsSync(path.join(dir, file)), `${name} 缺 ${file}`).toBe(true);
    }
    // 叙事模式写出的初始文件与已有内容不同时整体失败，不覆盖。
    const dir = temp();
    fs.writeFileSync(path.join(dir, 'cast.yaml'), 'other');
    expect(() => create({ target: dir, canvas: preset.defaultPreset().id, delivery: DeliverySpeech, narration: NarrationCast })).toThrow('内容不同');
    expect(skillsInstalled(dir)).toBe(false);
  });

  // 项目根的 frame.md 就是所选画幅的那份，逐字节来自 assets/presets/<画幅>/；不再有风格文件与风格字体。
  it('writes the canvas frame.md and nothing of the old styles', () => {
    for (const p of preset.all()) {
      const dir = path.join(temp(), p.id);
      create({ target: dir, canvas: p.id, delivery: DeliverySpeech, narration: NarrationSolo });
      expect(fs.readFileSync(path.join(dir, 'frame.md'), 'utf8')).toBe(canvas(p.id).readText('frame.md'));
      expect(fs.readFileSync(path.join(dir, 'frame.md'), 'utf8')).toContain(`height_px: ${p.canvas.heightPx}\n`);
      for (const gone of ['docs/style-brief.md', 'assets/style-guide', 'docs']) expect(fs.existsSync(path.join(dir, gone)), `${p.id} 不该有 ${gone}`).toBe(false);
    }
  });

  it('lists solo first, then the narrations that plugins register', () => {
    expect(narrations().map((n) => [n.id, n.owner])).toEqual([
      ['solo', ''],
      ['cast', 'cast'],
    ]);
  });
});
