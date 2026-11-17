// 试镜：假的渲染工具代替画面从哪来，冻结、各自渲染、按选手换模型、评判与采用都是真的在跑。只在非 Windows 上跑。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as audition from '@onset/engine/audition';
import * as hyperframes from '@onset/engine/hyperframes';
import { fakeCLI } from '@onset/engine/hyperframes/hftest';
import * as scene from '@onset/engine/scene';
import { allOps } from './ops/op';
import { Buffer, hasFfmpeg, lookPath, makeClip, run, setenv, tempDir } from './testutil';

const skip = !hasFfmpeg || process.platform === 'win32';

/** 假 claude：把命令行记进 argv.log（看得出用了哪个模型），模型名带 broken 时不出片。 */
function fakeClaude(binDir: string, clip: string): void {
  const script = `#!/bin/sh
model=""; prev=""; last=""
for a; do if [ "$prev" = "--model" ]; then model="$a"; fi; prev="$a"; last="$a"; done
printf '{"type":"system","subtype":"init","session_id":"s","model":"%s"}\\n' "$model"
# 整理者（向老师学）：工作目录里有 brief.md，写一份草稿就结束。
if [ -f brief.md ]; then
  printf -- '---\\nname: layer-depth-first\\ndescription: 先立住前后层次再加动效\\nstatus: trial\\nchecked_by: [audition.judged]\\n---\\n\\n先把前景、中景、背景分开摆好。\\n\\n反例：\\n    全放一层\\n\\n正例：\\n    三层分开\\n' > drafts/lessons/layer-depth-first.md
  exit 0
fi
printf '%s\\n' "$*" > argv.log
case "$last" in *写设计稿*) printf '设计：%s\\n' "$model" > design.md; printf '%s\\n' "$model" > designer.log; exit 0 ;; esac
case "$model" in *broken*) printf '{"type":"assistant","message":{"content":[{"type":"text","text":"不会"}]}}\\n'; exit 1 ;; esac
design=""; if [ -f design.md ]; then design="+$(/bin/cat design.md)"; fi
printf '<html>%s%s</html>' "$model" "$design" > index.html
/bin/cp '${clip}' out.mp4
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"[[USER_MESSAGE]]完成"}]}}\\n'
`;
  fs.writeFileSync(path.join(binDir, 'claude'), script, { mode: 0o755 });
}

function setup(): { root: string; scene: string } {
  const root = fs.realpathSync(tempDir());
  const clip = path.join(tempDir(), 'clip.mp4');
  makeClip(clip, 'testsrc=size=320x240:rate=30:duration=1');
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
  fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=claude\nRENDERER=codex\n');
  const dir = path.join(root, 'scenes', 'scene-001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"内容"}');
  const binDir = tempDir();
  fakeClaude(binDir, clip);
  const cli = tempDir();
  fakeCLI(cli);
  setenv(hyperframes.CLIDirEnv, cli);
  process.chdir(root);
  setenv('PATH', binDir + path.delimiter + path.dirname(lookPath('ffmpeg')) + path.delimiter + '/usr/bin:/bin');
  setenv('HOME', tempDir());
  return { root, scene: dir };
}

async function onset(...args: string[]): Promise<{ code: number; out: string }> {
  const out = new Buffer();
  const code = await run(args, out, out);
  return { code, out: out.text };
}

describe('audition ops', () => {
  it('are for people only, not the orchestrator', () => {
    for (const name of ['scene_audition', 'scene_audition_retry', 'scene_audition_vote', 'scene_audition_adopt']) {
      expect(allOps().find((op) => op.name === name)?.scopes).toEqual(['cli']);
    }
  });
});

describe.skipIf(skip)('scene audition', () => {
  it.runIf(scene.sandboxAvailable())('isolates contestants even with unsafe rendering enabled', async () => {
    const { root, scene: dir } = setup();
    const binary = lookPath('claude');
    const probe = `
if /bin/cat ../../../../../scenes/scene-001/scene.json >/dev/null 2>&1; then printf original > leaked-original; fi
case "$PWD" in */A) peer=B ;; *) peer=A ;; esac
if /bin/cat "../$peer/scene.json" >/dev/null 2>&1; then printf peer > leaked-peer; fi
`;
    fs.writeFileSync(binary, fs.readFileSync(binary, 'utf8').replace('model=""; prev="";', probe + '\nmodel=""; prev="";'));
    const ran = await onset('--unsafe', 'scene', 'audition', dir, '--contestants', 'claude:one,claude:two');
    expect(ran.code, ran.out).toBe(0);
    const [a] = audition.list(root);
    for (const c of a.contestants) {
      expect(c.outcome, c.error).toBe('succeeded');
      expect(fs.existsSync(path.join(root, c.workdir, 'leaked-original'))).toBe(false);
      expect(fs.existsSync(path.join(root, c.workdir, 'leaked-peer'))).toBe(false);
      expect(fs.readFileSync(path.join(root, c.workdir, 'argv.log'), 'utf8')).toContain('禁止读取其他选手');
    }
  });

  it('recovers a dead contestant, rejects overlapping retries, and records another failure', async () => {
    const { root, scene: dir } = setup();
    const a = audition.create(root, scene.load(dir), [{ renderer: 'claude', model: 'good' }, { renderer: 'claude', model: 'broken' }], { withMemory: false, shuffle: entries => entries });
    a.contestants[0].status = 'running';
    audition.save(root, a);
    scene.writeLive(path.join(root, a.contestants[0].workdir), a.scene_id, { pid: 2147483647, renderer: 'claude', started_at: '' });
    const release = audition.acquireRun(root, a);
    try {
      expect((await onset('scene', 'audition-retry', a.id, '--slot', 'A')).code).not.toBe(0);
    } finally { release(); }
    const retry = await onset('scene', 'audition-retry', a.id, '--slot', 'A');
    expect(retry.code, retry.out).toBe(0);
    expect(audition.load(root, a.id).contestants.map(c => c.status)).toEqual(['done', 'pending']);
    expect((await onset('scene', 'audition-retry', a.id, '--slot', 'B')).code).not.toBe(0);
    expect(audition.load(root, a.id).contestants[1]).toMatchObject({ status: 'done', outcome: 'failed' });
    expect(audition.isRunning(root, a)).toBe(false);
  });

  it('retries only the failed contestant using its frozen input and original two-stage configuration', async () => {
    const { root, scene: dir } = setup();
    expect((await onset('scene', 'audition', dir, '--contestants', 'claude:good,claude:broken<claude:teacher', '--with-memory=false')).code).toBe(0);
    const [a] = audition.list(root);
    const failed = a.contestants.find(c => c.model === 'broken')!;
    const good = a.contestants.find(c => c.model === 'good')!;
    const goodLog = path.join(root, good.workdir, 'argv.log');
    const before = fs.statSync(goodLog).mtimeMs;
    // 修复假的工具故障；项目镜头同时发生变化，重试仍要用原来冻结的输入。
    const executable = lookPath('claude');
    fs.writeFileSync(executable, fs.readFileSync(executable, 'utf8').replace('*broken*)', '*never-broken*)'));
    fs.writeFileSync(path.join(dir, 'scene.json'), 'invalid newer source');
    const retry = await onset('scene', 'audition-retry', a.id, '--slot', failed.slot);
    expect(retry.code, retry.out).toBe(0);
    const after = audition.load(root, a.id);
    expect(after.contestants.find(c => c.slot === failed.slot)).toMatchObject({ model: 'broken', designer_model: 'teacher', outcome: 'succeeded', status: 'done' });
    expect(after.contestants.find(c => c.slot === good.slot)).toEqual(good);
    expect(fs.statSync(goodLog).mtimeMs).toBe(before);
    expect(fs.readFileSync(path.join(root, failed.workdir, 'index.html'), 'utf8')).toBe('<html>broken+设计：teacher</html>');
    expect(after.with_memory).toBe(false);
    expect(after.verdict).toBeNull();
    expect(fs.readdirSync(path.join(root, failed.workdir, 'attempts')).length).toBeGreaterThan(0);
    expect((await onset('scene', 'audition-retry', a.id, '--slot', failed.slot)).code).not.toBe(0);
  });

  it('renders every contestant with its own model, then votes and adopts the winner', async () => {
    const { root, scene: dir } = setup();
    const ran = await onset('scene', 'audition', 'scenes/scene-001', '--contestants', 'claude:opus-x,claude:sonnet-y,claude:broken-z');
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain('2/3 份出了合格的产物');
    const [a] = audition.list(root);
    expect(a.contestants.every((c) => c.status === 'done')).toBe(true);
    for (const c of a.contestants) {
      // 每位选手在自己的目录里、用自己的模型渲染。
      expect(fs.readFileSync(path.join(root, c.workdir, 'argv.log'), 'utf8')).toContain('--model ' + c.model);
      expect(c.outcome === 'succeeded').toBe(!c.model.includes('broken'));
    }
    // 项目里的镜头没被动过，镜头列表也看不到这些副本。
    expect(fs.existsSync(path.join(dir, 'out.mp4'))).toBe(false);

    const winner = a.contestants.find((c) => c.model === 'sonnet-y')!;
    const voted = await onset('scene', 'audition-vote', a.id, '--kind', 'winner', '--winner', winner.slot);
    expect(voted.code, voted.out).toBe(0);
    expect(voted.out).toContain('★ ' + winner.slot);

    const adopted = await onset('scene', 'audition-adopt', a.id, '--slot', winner.slot);
    expect(adopted.code, adopted.out).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe('<html>sonnet-y</html>');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8')).renderer).toBe('claude');
    // 渲染记录按项目里的镜头重写：重渲染全部时这一镜按「已有合格产物」跳过，不是 Stale。
    expect(scene.loadRecord(scene.load(dir))).not.toBeNull();
    const all = await onset('scene', 'run-all', 'scenes', '--retries', '0');
    expect(all.code, all.out).toBe(0);
    expect(all.out).toContain('跳过 1  过期 0');
  });

  it('runs the whole learning loop: two-stage design, relation, learning, and a human-judged exam', async () => {
    const { root, scene: dir } = setup();
    const mem = process.env.ONSET_MEMORY_DIR!;
    // 两段式：同一位学生自己做，对比照老师的设计稿做。
    const ran = await onset('scene', 'audition', 'scenes/scene-001', '--contestants', 'claude:student,claude:student<claude:teacher');
    expect(ran.code, ran.out).toBe(0);
    let [a] = audition.list(root);
    const assisted = a.contestants.find((c) => c.designer !== '')!;
    expect(fs.readFileSync(path.join(root, assisted.workdir, 'designer.log'), 'utf8').trim()).toBe('teacher');
    expect(fs.readFileSync(path.join(root, assisted.workdir, 'index.html'), 'utf8')).toBe('<html>student+设计：teacher</html>');
    expect(fs.existsSync(path.join(root, assisted.workdir, 'design-scene-001.stream.jsonl'))).toBe(true);
    expect(audition.contestantKey(assisted)).toBe('claude/student<claude/teacher');

    // 采用照设计稿做的那份：设计稿跟着换进镜头，成了镜头的输入，渲染记录照样对得上。
    expect((await onset('scene', 'audition-vote', a.id, '--kind', 'winner', '--winner', assisted.slot)).code).toBe(0);
    const adopted = await onset('scene', 'audition-adopt', a.id, '--slot', assisted.slot);
    expect(adopted.out).toContain('设计稿 design.md 也一起换进去了');
    expect(fs.readFileSync(path.join(dir, 'design.md'), 'utf8')).toBe('设计：teacher\n');
    expect((await onset('scene', 'run-all', 'scenes', '--retries', '0')).out).toContain('跳过 1  过期 0');

    // 老师与学生正面比一场，老师赢；人确认学习关系。
    fs.rmSync(path.join(dir, 'design.md'));
    expect((await onset('scene', 'audition', 'scenes/scene-001', '--contestants', 'claude:teacher,claude:student')).code).toBe(0);
    [a] = audition.list(root);
    const teacher = a.contestants.find((c) => c.model === 'teacher')!;
    expect((await onset('scene', 'audition-vote', a.id, '--kind', 'winner', '--winner', teacher.slot, '--note', '层次清楚')).code).toBe(0);
    expect(audition.listExemplars(mem).map((e) => e.key)).toContain('claude/teacher');
    const proposal = audition.proposals(audition.readVerdicts(mem), audition.loadLearning(mem)).find((x) => x.teacher === 'claude/teacher')!;
    expect(proposal).toMatchObject({ student: 'claude/student', teacher: 'claude/teacher' });
    const relation = audition.confirmRelation(mem, { student: proposal.student, teacher: proposal.teacher });

    // 向老师学：整理者写出草稿，进入试用，范围限定学生。
    const learned = await onset('audition', 'learn', relation.id);
    expect(learned.code, learned.out).toBe(0);
    expect(learned.out).toContain('进入试用：layer-depth-first');

    // 人评考试：学生带与不带经验各一份、老师作参照；学生渲染时带上了老师的范例。
    const exam = await onset('scene', 'audition', 'scenes/scene-001', '--exam', relation.id);
    expect(exam.code, exam.out).toBe(0);
    [a] = audition.list(root);
    expect(a.exam?.lessons).toEqual(['layer-depth-first']);
    const trial = a.contestants.find((c) => c.role === 'trial')!;
    const control = a.contestants.find((c) => c.role === 'control')!;
    const trialPrompt = fs.readFileSync(path.join(root, trial.workdir, 'argv.log'), 'utf8');
    expect(trialPrompt).toContain('先把前景、中景、背景分开摆好');
    expect(fs.readFileSync(path.join(root, control.workdir, 'argv.log'), 'utf8')).not.toContain('先把前景、中景、背景分开摆好');
    // 同一个镜头不给自己的范例（那等于抄答案）。
    expect(trialPrompt).not.toContain('参考范例');
    audition.applyAttempt(root, trial, null, 'fixture: interrupted');
    audition.save(root, a);
    const retried = await onset('scene', 'audition-retry', a.id, '--slot', trial.slot);
    expect(retried.code, retried.out).toBe(0);
    expect(fs.readFileSync(path.join(root, trial.workdir, 'argv.log'), 'utf8')).toContain('先把前景、中景、背景分开摆好');
    expect(audition.load(root, a.id).exam).toEqual(a.exam);
    const voted = await onset('scene', 'audition-vote', a.id, '--kind', 'winner', '--winner', trial.slot);
    expect(voted.out).toContain('layer-depth-first 生效');
    const p = audition.progress(audition.readVerdicts(mem), relation);
    expect(p.points.map((x) => x.result)).toEqual(['loss']);
    expect(p.exams.map((x) => x.result)).toEqual(['trial']);
  });
});
