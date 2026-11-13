// 移植自 internal/schedule/schedule_test.go。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import * as scene from '../scene';
import type { Scene } from '../scene';
import {
  coverageProblems,
  emptyCounts,
  Failed,
  fatal,
  newReport,
  newSceneResult,
  outcome,
  plan,
  renderReport,
  renderWorkers,
  reportExitCode,
  runAll,
  sceneDirs,
  setRetryBackoff,
  setWaitFunc,
  Skipped,
  startOffsets,
  Succeeded,
  systemMemory,
  writeReportJSON,
} from './schedule';

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-schedule-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** recordSleeps：把重试退避换成记录，测试既不真的等待，又能断言等了多久。 */
function recordSleeps(): () => number[] {
  const slept: number[] = [];
  const original = setWaitFunc(async (_signal, ms) => {
    slept.push(ms);
  });
  onTestFinished(() => {
    setWaitFunc(original);
  });
  return () => [...slept];
}

function testScene(root: string, id: string): Scene {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.srt'), 'test');
  fs.writeFileSync(
    path.join(dir, 'scene.json'),
    `{"id":"${id}","duration_seconds":1,"output":"${id}.mp4","transcript":"transcript.srt","text":"hello"}`,
  );
  return scene.load(dir);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const background = () => new AbortController().signal;

describe('plan', () => {
  it('sorts scenes and ignores helpers', () => {
    const root = tempDir();
    testScene(root, 'scene-002');
    testScene(root, 'scene-001');
    fs.mkdirSync(path.join(root, 'attempts'));
    const got = plan(root);
    expect(got.map((s) => s.id)).toEqual(['scene-001', 'scene-002']);
  });
});

describe('runAll', () => {
  it('honors concurrency and retries', async () => {
    recordSleeps();
    const root = tempDir();
    const scenes = [testScene(root, 'scene-001'), testScene(root, 'scene-002'), testScene(root, 'scene-003')];
    let active = 0;
    let maximum = 0;
    const attempts: Record<string, number> = {};
    const report = await runAll(background(), scenes, 2, 1, async (_signal, s) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        attempts[s.id] = (attempts[s.id] ?? 0) + 1;
        const attempt = attempts[s.id];
        await sleep(30);
        if (s.id === 'scene-002' && attempt === 1) throw new Error('renderer exit code 3');
      } finally {
        active--;
      }
    });
    expect(maximum).toBeLessThanOrEqual(2);
    expect(reportExitCode(report)).toBe(0);
    expect(report.counts.succeeded).toBe(3);
    expect(attempts['scene-002']).toBe(2);
  });

  it('returns a partial report on cancellation', async () => {
    const root = tempDir();
    const scenes = [testScene(root, 'scene-001'), testScene(root, 'scene-002')];
    const controller = new AbortController();
    const report = await runAll(controller.signal, scenes, 1, 0, async (signal, s) => {
      if (s.id === 'scene-001') {
        controller.abort();
        return;
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('context canceled');
    });
    expect(report.interrupted).toBe(true);
    expect(report.scenes.length).toBeGreaterThan(0);
  });

  it('records a skip without retry', async () => {
    const root = tempDir();
    const scenes = [testScene(root, 'scene-001')];
    const report = await runAll(background(), scenes, 1, 5, async () => {
      throw outcome(Skipped, '已有合格产物');
    });
    expect(report.counts.skipped).toBe(1);
    expect(report.scenes[0].attempts).toBe(0);
  });

  // 守着下发 PROMPT 里的承诺：「产物校验失败不会重试」。每次重试都是一次完整的 AI CLI 调用，
  // 而规格不符是确定性的，重跑只会得到同样的产物。
  it('does not retry fatal errors', async () => {
    recordSleeps();
    const root = tempDir();
    const scenes = [testScene(root, 'scene-001')];
    let calls = 0;
    const report = await runAll(background(), scenes, 1, 5, async () => {
      calls++;
      throw fatal(new Error('产物时长不符：期望 2.833 秒，实测 5.000 秒'));
    });
    expect(calls, '不可重试的失败被重试了').toBe(1);
    expect(report.counts.failed).toBe(1);
    expect(report.scenes[0].attempts).toBe(1);
    expect(report.scenes[0].reason).toContain('产物时长不符');
  });

  // 上一条的反面：渲染器非零退出仍要重试，否则一次网络抖动就会判定镜头失败。
  it('still retries ordinary errors', async () => {
    recordSleeps();
    const root = tempDir();
    const scenes = [testScene(root, 'scene-001')];
    let calls = 0;
    await runAll(background(), scenes, 1, 2, async () => {
      calls++;
      throw new Error('渲染器退出码 3');
    });
    expect(calls).toBe(3);
  });

  // 守着 PROMPT 里写的「退避 10 秒与 30 秒」。失败后立刻重启 AI CLI 通常只会撞上同一个瞬时故障。
  it('backs off between attempts', async () => {
    const slept = recordSleeps();
    const root = tempDir();
    const scenes = [testScene(root, 'scene-001')];
    await runAll(background(), scenes, 1, 2, async () => {
      throw new Error('渲染器退出码 3');
    });
    expect(slept()).toEqual([10_000, 30_000]);
  });

  // 中断时不能还坐等 30 秒退避走完。用真实的等待实现，只把退避时长调长，确保测的是取消真的能打断等待。
  it('backoff does not delay cancellation', async () => {
    const original = setRetryBackoff([3_600_000]);
    onTestFinished(() => {
      setRetryBackoff(original);
    });
    const root = tempDir();
    const scenes = [testScene(root, 'scene-001')];
    const controller = new AbortController();
    const done = runAll(controller.signal, scenes, 1, 3, async () => {
      throw new Error('渲染器退出码 3');
    });
    // 让第一次失败进入退避，再取消。
    await sleep(20);
    controller.abort();
    const report = await Promise.race([done, sleep(3000).then(() => null)]);
    expect(report, '取消没有打断退避等待：runAll 卡住了').not.toBeNull();
    expect(report!.interrupted).toBe(true);
  });

  // 重试必须带上上一次的失败原因与归档日志位置，同一提示词原样重跑大概率重蹈覆辙。首次尝试不带任何说明。
  it('retry carries the previous failure', async () => {
    recordSleeps();
    const root = tempDir();
    const scenes = [testScene(root, 'scene-001')];
    const notes: string[] = [];
    await runAll(background(), scenes, 1, 2, async (_signal, s) => {
      notes.push(s.retryNote);
      // 真实渲染总会留下日志；归档只搬实际存在的文件。
      fs.writeFileSync(scene.streamLog(s), '{}\n');
      throw new Error(`渲染器退出码 ${notes.length}`);
    });
    expect(notes).toHaveLength(3);
    expect(notes[0]).toBe('');
    const wants = [
      { reason: '渲染器退出码 1', archive: 'attempts/attempt-01/' },
      { reason: '渲染器退出码 2', archive: 'attempts/attempt-02/' },
    ];
    wants.forEach((want, i) => {
      const note = notes[i + 1];
      expect(note).toContain(want.reason);
      expect(note).toContain(want.archive);
      expect(note).not.toContain(root);
    });
  });

  // 渲染器连日志都没留下时不建空的归档目录，重试说明也不指向一个空目录。
  it('retry note without artifacts omits the archive', async () => {
    recordSleeps();
    const root = tempDir();
    const scenes = [testScene(root, 'scene-001')];
    const notes: string[] = [];
    await runAll(background(), scenes, 1, 1, async (_signal, s) => {
      notes.push(s.retryNote);
      throw new Error('启动渲染器失败');
    });
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain('启动渲染器失败');
    expect(notes[1]).not.toContain('attempts/');
    expect(fs.existsSync(path.join(scenes[0].directory, 'attempts'))).toBe(false);
  });

  // 单 worker 时派发顺序就是执行顺序，能直接观测；报告必须仍按时间轴顺序，拼接与审阅都依赖它。
  it('dispatches longest first but reports in timeline order', async () => {
    const root = tempDir();
    const withDuration = (s: Scene, seconds: number): Scene => ({ ...s, duration_seconds: seconds });
    const scenes = [
      withDuration(testScene(root, 'scene-001'), 2),
      withDuration(testScene(root, 'scene-002'), 9),
      withDuration(testScene(root, 'scene-003'), 2),
      withDuration(testScene(root, 'scene-004'), 5),
    ];
    const started: string[] = [];
    const report = await runAll(background(), scenes, 1, 0, async (_signal, s) => {
      started.push(s.id);
    });
    expect(started.join(',')).toBe('scene-002,scene-004,scene-001,scene-003');
    expect(report.scenes.map((r) => r.scene_id).join(',')).toBe('scene-001,scene-002,scene-003,scene-004');
    expect(scenes[0].id, 'dispatchOrder 不得改动调用方的数组').toBe('scene-001');
  });
});

describe('report', () => {
  it('writes atomic JSON and renders', () => {
    const report = newReport({
      schema_version: 1,
      seconds: 1.5,
      counts: { ...emptyCounts(), succeeded: 1 },
      scenes: [newSceneResult({ scene_id: 'scene-001', status: Succeeded, attempts: 1 })],
    });
    const file = path.join(tempDir(), 'nested', 'report.json');
    writeReportJSON(report, file);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('"schema_version": 1');
    expect(renderReport(report)).toContain('成功 1');
    const failed = report;
    failed.counts[Failed] = 1;
    expect(reportExitCode(failed)).toBe(1);
  });
});

describe('coverageProblems', () => {
  // 守着 PROMPT 里那条纯可判定的规则：「所有镜头 duration_seconds 之和应等于字幕跨度，误差不超过 0.1 秒」。
  it('catches split mistakes', () => {
    const root = tempDir();
    const makeScene = (id: string, duration: number): Scene => {
      const dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'transcript.srt'), 'test');
      fs.writeFileSync(
        path.join(dir, 'scene.json'),
        `{"id":"${id}","duration_seconds":${duration},"output":"${id}.mp4","transcript":"transcript.srt","text":"hello"}`,
      );
      return scene.load(dir);
    };
    const full = [makeScene('scene-001', 2.5), makeScene('scene-002', 5.0)];
    expect(coverageProblems(full, 7.5, 0.1)).toEqual([]);
    // 误差在容差内。
    expect(coverageProblems(full, 7.55, 0.1)).toEqual([]);
    // 漏了一镜：合计明显短于字幕跨度。
    const problems = coverageProblems(full, 12.0, 0.1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('7.500');
    expect(problems[0]).toContain('12.000');
  });

  it('rejects empty and duplicate scenes', () => {
    expect(coverageProblems(null, 0, 0.1)).toHaveLength(1);
    const root = tempDir();
    const a = testScene(path.join(root, 'a'), 'scene-001');
    const b = testScene(path.join(root, 'b'), 'scene-001');
    const problems = coverageProblems([a, b], 0, 0.1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('编号重复');
  });

  // 没给字幕时只查集合自身，不能凭空拿 0 当成期望跨度去比。
  it('skips the span check when there is no SRT', () => {
    const root = tempDir();
    expect(coverageProblems([testScene(root, 'scene-001')], 0, 0.1)).toEqual([]);
  });
});

describe('startOffsets', () => {
  // 钉住"镜头全局起点"这条累加规则只有一处实现。
  it('accumulates durations', () => {
    const scenes = [
      scene.newScene({ id: 'scene-001', duration_seconds: 2.5 }),
      scene.newScene({ id: 'scene-002', duration_seconds: 1.25 }),
      scene.newScene({ id: 'scene-003', duration_seconds: 3 }),
    ];
    expect(startOffsets(scenes)).toEqual([0, 2.5, 3.75]);
  });

  it('returns empty for no scenes', () => {
    expect(startOffsets(null)).toEqual([]);
  });
});

describe('sceneDirs', () => {
  // 钉住"镜头先后顺序"这条规则只有一处实现。含 scene.json 才算镜头，其余目录与散落文件都要跳过。
  it('orders by directory name', () => {
    const root = tempDir();
    for (const name of ['scene-010', 'scene-002', 'scene-001']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'scene.json'), '{}');
    }
    fs.mkdirSync(path.join(root, 'not-a-scene'), { recursive: true });
    fs.writeFileSync(path.join(root, 'readme.txt'), 'x');
    expect(sceneDirs(root).map((dir) => path.basename(dir))).toEqual(['scene-001', 'scene-002', 'scene-010']);
  });
});

describe('renderWorkers', () => {
  it('splits CPU and memory across jobs', () => {
    const gib = 2 ** 30;
    const cases: [number, number, number, number][] = [
      [10, 0, 1, 0], // 单镜头：沿用上游 auto
      [10, 0, 3, 2], // (10-2)/3
      [16, 0, 3, 4], // (16-2)/3
      [4, 0, 3, 1], // 核不够分时至少 1
      [2, 0, 16, 1],
      [16, 16 * gib, 3, 1], // 一半内存 8GB 只够 5 个 Chrome，三镜头各 1 个
      [16, 64 * gib, 3, 4], // 内存充足时仍按 CPU 分
      [12, 32 * gib, 2, 5], // 内存 10 个 Chrome / 2 = 5，CPU (12-2)/2 = 5
      [32, 32 * gib, 2, 5], // 内存成为瓶颈
    ];
    for (const [cpus, memory, jobs, want] of cases) {
      expect(renderWorkers(cpus, memory, jobs), `renderWorkers(${cpus}, ${memory}, ${jobs})`).toBe(want);
    }
  });
});

describe('systemMemory', () => {
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('reads physical memory', () => {
    expect(systemMemory()).toBeGreaterThanOrEqual(2 ** 30);
  });
});
