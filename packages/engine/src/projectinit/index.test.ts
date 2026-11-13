import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as preset from '../preset';
import {
  castYAML,
  create,
  DeliveryBeat,
  DeliverySong,
  DeliverySpeech,
  NarrationCast,
  NarrationSolo,
  skillsInstalled,
  validate,
  writeCastScaffold,
} from './index';

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
    // 已有内容不同的 cast.yaml 不覆盖。
    const dir = temp();
    fs.writeFileSync(path.join(dir, 'cast.yaml'), 'other');
    expect(() => writeCastScaffold(dir)).toThrow('内容不同');
    expect(skillsInstalled(dir)).toBe(false);
  });

  // Go 版用 yaml.v3 序列化；字节取自 Go 版 am init --narration cast 实际写出的 cast.yaml。
  it('writes cast.yaml byte-identical to the Go version', () => {
    expect(castYAML()).toBe('schema: cast/v1\npacks: []\ndefaults:\n    ground_y: 0.78\n    gap_ms:\n        turn: 240\n        interject: 100\n');
  });
});
