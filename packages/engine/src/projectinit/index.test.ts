import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as preset from '../preset';
import { BeatFlow as DeliveryBeat } from '../plugins/beat';
import { create, DeliverySong, DeliverySpeech, narrations, NarrationSolo, skillsInstalled, validate } from './index';

// 多角色对话插件登记的叙事模式。
const NarrationCast = 'cast';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-projectinit-'));
const style = preset.CustomStyle;

describe('projectinit', () => {
  it('rejects conflicting modes', () => {
    const dir = temp();
    for (const [delivery, narration] of [
      ['opera', NarrationSolo],
      [DeliverySpeech, 'choir'],
      [DeliveryBeat, NarrationCast],
      [DeliverySong, NarrationCast],
    ]) {
      expect(() => validate({ target: dir, canvas: '', style, delivery, narration }), `${delivery}/${narration}`).toThrow();
    }
    expect(() => validate({ target: dir, canvas: '', style, delivery: DeliverySpeech, narration: NarrationCast })).not.toThrow();
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
      create({ target: dir, canvas: preset.defaultPreset().id, style, delivery, narration, extra: { 'docs/note.md': 'x' } });
      for (const file of [...want, 'docs/note.md']) expect(fs.existsSync(path.join(dir, file)), `${name} 缺 ${file}`).toBe(true);
    }
    // 叙事模式写出的初始文件与已有内容不同时整体失败，不覆盖。
    const dir = temp();
    fs.writeFileSync(path.join(dir, 'cast.yaml'), 'other');
    expect(() => create({ target: dir, canvas: preset.defaultPreset().id, style, delivery: DeliverySpeech, narration: NarrationCast })).toThrow('内容不同');
    expect(skillsInstalled(dir)).toBe(false);
  });

  it('lists solo first, then the narrations that plugins register', () => {
    expect(narrations().map((n) => [n.id, n.owner])).toEqual([
      ['solo', ''],
      ['cast', 'cast'],
    ]);
  });
});
