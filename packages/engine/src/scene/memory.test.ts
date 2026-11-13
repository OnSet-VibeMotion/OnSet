// 移植自 internal/scene/memory_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckOutputAudio, CheckOutputDuration, CheckOutputFPS, CheckOutputFrames, CheckOutputOther, CheckOutputResolution, DeterminismCheckPrefix } from './checks';
import { changedInputs, fingerprint } from './record';
import { verifyOutput } from './run';
import { buildPrompt, load, outputPath } from './scene';
import { fakeFfprobe, tempDir, writeScene } from './testsupport';
import { VerificationError } from './verification';

const plainScene = '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}';

describe('memory', () => {
  // 渲染记忆按 checks 聚类失败：checks 与 problems 必须一一对应，且产物校验的每条文字都能归到具体校验器。
  it('verification checks align with problems', () => {
    const dir = writeScene(plainScene);
    const s = load(dir);
    const bin = tempDir();
    fakeFfprobe(bin, { widthPx: 720, heightPx: 1280, fpsNum: 25, duration: '9.000', audio: true });
    fs.writeFileSync(outputPath(s), 'video');
    fs.writeFileSync(path.join(dir, 'index.html'), '<script>requestAnimationFrame(() => {})</script>');
    let err: unknown = null;
    try {
      verifyOutput(s, { PATH: bin, HOME: tempDir() }, 0.15);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VerificationError);
    const v = err as VerificationError;
    expect(v.checks?.length, `checks ${v.checks} 与 problems ${v.problems} 不等长`).toBe(v.problems.length);
    const want = new Set([CheckOutputResolution, CheckOutputFPS, CheckOutputDuration, CheckOutputFrames, CheckOutputAudio, DeterminismCheckPrefix + 'raf']);
    v.checks!.forEach((check, i) => {
      expect(check, `问题没能归到具体校验器：${v.problems[i]}`).not.toBe(CheckOutputOther);
      want.delete(check);
    });
    expect([...want], `缺少校验器（实际 ${v.checks}）`).toEqual([]);
  });

  // 召回段在确定性段之后注入，指纹单列 memory 一项；没有召回时提示词与指纹与引入记忆之前完全一致。
  it('memory recall enters the prompt and the fingerprint', () => {
    const s = load(writeScene(plainScene));
    const plain = buildPrompt(s, null);
    const base = fingerprint(s, 'claude', null);
    s.memory = { snapshot: 0, names: null, section: '', digest: '' };
    expect(buildPrompt(s, null), '没有召回条目时提示词不该变化').toBe(plain);
    expect(fingerprint(s, 'claude', null).fingerprint, '没有召回条目时指纹不该变化：打开记忆会让老镜头全部 Stale').toBe(base.fingerprint);
    s.memory = { snapshot: 3, names: ['font-local-block'], section: '\n记忆（召回）：\n- 【font-local-block】字体用本地文件\n', digest: 'abc' };
    const prompt = buildPrompt(s, null);
    const section = prompt.indexOf('【font-local-block】');
    expect(section >= 0 && section > prompt.indexOf('确定性（强制'), `召回段应当出现在确定性段之后：\n${prompt}`).toBe(true);
    const fp = fingerprint(s, 'claude', null);
    expect(fp.parts!.memory, '指纹应当单列 memory 项').toBe('abc');
    expect(changedInputs(fp, base), 'changedInputs 应当点名 memory').toContain('memory');
    s.afterAttempt = () => {};
    expect(fingerprint(s, 'claude', null).fingerprint, 'afterAttempt 不是输入，不该影响指纹').toBe(fp.fingerprint);
  });
});
