// 移植自 internal/memory/importer_test.go。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookPath } from '../envutil';
import { attemptLog, attemptToJSON, newAttempt, OutcomeSucceeded, OutcomeVerificationFailed, type Attempt } from '../scene';
import { marshal } from '../gojson';
import { passed, SourceRender, type Episode } from './episode';
import { dropRetimed } from './importer';
import { runReport } from './report';
import { newStore, tempDir, writeSceneDir } from './testsupport';

function writeAttemptFile(file: string, a: Attempt): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, marshal(attemptToJSON(a)));
}

function find(name: string): string {
  try {
    return lookPath(name, process.env.PATH ?? '');
  } catch {
    return '';
  }
}

const ffmpeg = find('ffmpeg');
const ffprobe = find('ffprobe');

describe('importer', () => {
  // 最早的尝试算首次，其余算重试；老尝试没有校验器 ID 时按文字补上；重复导入跳过。
  it('TestImportProjectOrdersAttemptsAndDedupes', () => {
    const store = newStore();
    const root = path.join(tempDir(), 'demo');
    const s = writeSceneDir(path.join(root, 'scenes', 'scene-001'), 'scene-001', '中文', '');
    writeAttemptFile(
      path.join(s.directory, 'attempts', 'attempt-01', 'render-scene-001.attempt.json'),
      newAttempt({
        renderer: 'claude',
        started_at: '2026-10-01T00:00:00Z',
        outcome: OutcomeVerificationFailed,
        problems: ['源码不确定：index.html:3 [raf] 使用了 requestAnimationFrame：x', '总帧数不符：期望 30 帧，逐帧解码实测 31 帧'],
      }),
    );
    writeAttemptFile(attemptLog(s), newAttempt({ renderer: 'claude', model: 'claude-opus-5-5', started_at: '2026-10-01T01:00:00Z', outcome: OutcomeSucceeded }));
    const result = store.importProject(root, {});
    expect([result.attempts, result.failures, result.run]).toEqual([2, 1, 'import:demo']);
    let first: Episode | null = null;
    let second: Episode | null = null;
    for (const e of store.episodes()) {
      if (passed(e)) second = e;
      else if (e.source === SourceRender) first = e;
    }
    // 顺序或校验器不对。
    expect(first!.retry).toBe(false);
    expect(second!.retry).toBe(true);
    expect(first!.checks).toEqual(['determinism.raf', 'output.frames']);
    expect(second!.model).toBe('claude-opus-5-5');
    const again = store.importProject(root, {});
    // 重复导入应当跳过。
    expect(again.attempts).toBe(0);
    expect(again.skipped).toBe(2);
    const runs = runReport(store.episodes());
    // 导入的批次。
    expect(runs.length).toBe(1);
    expect(runs[0].pass_rate).toBe(0);
    expect(runs[0].retries).toBe(1);
  });

  it('TestDropRetimedKeepsRendererOffByOne', () => {
    const problems = ['总帧数不符：期望 1035 帧（34.500000 秒 × 30fps），逐帧解码实测 1036 帧', '源码不确定：x [raf] y'];
    const checks = ['output.frames', 'determinism.raf'];
    let got = dropRetimed('d', problems, checks);
    // 差一帧是渲染器的错，要保留。
    expect(got.problems.length).toBe(2);
    expect(got.note).toBe('');
    problems[0] = '总帧数不符：期望 1035 帧（34.500000 秒 × 30fps），逐帧解码实测 1092 帧';
    got = dropRetimed('d', [...problems, '时长不符：期望 34.500 秒（容差 0.150），实测 36.400 秒'], [...checks, 'output.duration']);
    // 差几十帧多半是改过时长，只丢时长与帧数。
    expect(got.problems.length).toBe(1);
    expect(got.checks[0]).toBe('determinism.raf');
    expect(got.note).toContain('改过时长');
  });

  // 只有产物的老归档用现在的校验重判；字体等素材从镜头目录补上，不会被误判成 font-missing。
  it.skipIf(ffmpeg === '' || ffprobe === '')('TestImportReverifiesArchivedOutputs', () => {
    const store = newStore();
    const root = path.join(tempDir(), 'demo');
    const s = writeSceneDir(path.join(root, 'scenes', 'scene-001'), 'scene-001', '中文', '');
    fs.writeFileSync(path.join(s.directory, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
    fs.writeFileSync(
      path.join(s.directory, 'scene.json'),
      '{"id":"scene-001","duration_seconds":3,"output":"out.mp4","transcript":"transcript.srt","text":"中文","style_guide":"frame.md"}',
    );
    fs.mkdirSync(path.join(s.directory, 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(s.directory, 'fonts', 'x.woff2'), 'font');
    const archive = path.join(root, 'production', 'failed-attempts', 'scene-001-attempt-01-extra-frame');
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, 'index.html'), "<style>@font-face{font-family:X;src:url('./fonts/x.woff2');font-display:block}</style>");
    const out = spawnSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-frames:v', '91', '-pix_fmt', 'yuv420p', path.join(archive, 'scene-001.mp4')]);
    expect(out.status, String(out.stderr)).toBe(0);
    const result = store.importProject(root, { env: { PATH: process.env.PATH ?? '', HOME: tempDir() }, tolerance: 0.15 });
    const episodes = store.episodes();
    // 多一帧的归档应当记为 output.frames，且字体不误判。
    expect(result.failures).toBe(1);
    expect(episodes.length).toBe(1);
    expect(episodes[0].checks).toEqual(['output.frames']);
  });
});
