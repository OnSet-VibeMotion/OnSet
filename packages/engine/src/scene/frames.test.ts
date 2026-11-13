// 移植自 internal/scene/frames_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyFrameAlignment } from './frames';
import { buildPrompt, load } from './scene';
import { frameWithCanvas, writeScene } from './testsupport';
import { VerificationError } from './verification';

describe('frame alignment', () => {
  // 实跑 C 语言那期时，4 个镜头写成 14.367 秒一类的时长：14.367×30=431.01 帧，
  // 渲染器向上取整多渲一帧，母版因此比时间轴长 4 帧，只能重渲染。
  it('rejects fractional frames', () => {
    const dir = writeScene('{"id":"scene-001","duration_seconds":14.367,"output":"out.mp4","transcript":"transcript.srt","text":"hello","style_guide":"frame.md"}');
    fs.writeFileSync(path.join(dir, 'frame.md'), frameWithCanvas(1080, 1440));
    const s = load(dir);
    let err: unknown = null;
    try {
      verifyFrameAlignment(s);
    } catch (e) {
      err = e;
    }
    expect(err, '非整数帧时长应抛 VerificationError（确定性失败，不重试）').toBeInstanceOf(VerificationError);
    for (const want of ['431.01', '14.366667']) expect((err as Error).message).toContain(want);
  });

  // 精确到 6 位小数的 N/fps 时长是对齐的；整数秒自然也是。
  it('accepts exact frames', () => {
    for (const duration of ['14.366667', '4', '0.5']) {
      const dir = writeScene('{"id":"scene-001","duration_seconds":' + duration + ',"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
      expect(() => verifyFrameAlignment(load(dir)), `${duration} 秒应视为整数帧`).not.toThrow();
    }
  });

  // 提示词若把 14.366667 格式化成 14.367，渲染器照样多出一帧。必须把帧数写明。
  it('buildPrompt states the exact frame count', () => {
    const dir = writeScene('{"id":"scene-001","duration_seconds":14.366667,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
    const prompt = buildPrompt(load(dir), null);
    for (const want of ['431 帧', '431/30', '正好 431 帧']) expect(prompt).toContain(want);
  });
});
