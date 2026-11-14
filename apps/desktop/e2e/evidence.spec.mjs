import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, openPage } from './fixtures.mjs';

// 进化页：一场考过的试排成「同一个镜头带与不带一条经验」的两段画面、这条经验本身与考试结果。

function seedExam(sandbox, project) {
  const lessons = path.join(sandbox.memory, 'lessons');
  fs.mkdirSync(lessons, { recursive: true });
  fs.writeFileSync(
    path.join(lessons, 'hold-readable.md'),
    [
      '---',
      'name: hold-readable',
      'description: 画面上的字要停够时间再换',
      'status: active',
      'checked_by:',
      '  - reads.duration',
      'from_episodes:',
      '  - ep-x',
      'verified_by:',
      '  - exam-0001',
      '---',
      '',
      '每段文字停稳后至少留够读完的时间。',
      '',
      '反例：',
      '    停 10 帧就换',
      '',
      '正例：',
      '    停到读完',
      '',
    ].join('\n'),
  );
  const cell = (arm, passed) => {
    const workdir = path.join(project.path, 'production', 'memory-exams', 'exam-0001', 'q1', `claude-${arm}-1`);
    fs.mkdirSync(workdir, { recursive: true });
    // 产物名取自考场里的 scene.json：真实镜头不叫 out.mp4。
    fs.writeFileSync(path.join(workdir, 'scene.json'), JSON.stringify({ id: 'scene-001', duration_seconds: 1, output: 'scene-001.mp4', transcript: 'voice.srt', text: 'hello' }));
    fs.writeFileSync(path.join(workdir, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
    fs.writeFileSync(path.join(workdir, 'scene-001.mp4'), 'video');
    return {
      question: 'q1',
      holdout: false,
      renderer: 'claude',
      arm,
      repeat: 1,
      outcome: passed ? 'succeeded' : 'verification_failed',
      passed,
      problems: passed ? 0 : 2,
      checks: passed ? undefined : ['reads.duration', 'reads.duration'],
      seconds: 60,
      workdir,
    };
  };
  const dir = path.join(sandbox.memory, 'exams', 'exam-0001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'result.json'),
    JSON.stringify({
      id: 'exam-0001',
      created_at: '2026-11-12T07:17:11Z',
      trials: ['hold-readable'],
      renderers: ['claude'],
      questions: [{ id: 'q1', holdout: false, scene_id: 'scene-001', input: '' }],
      cells: [cell('control', false), cell('trial', true)],
      verdict: { pass: true, invalid: false, needs_human: false, control_score: -2, trial_score: 10, reasons: [] },
      snapshot_before: 0,
      applied: 'promoted',
      snapshot: 1,
    }),
  );
}

test('the evidence page puts both arms of an exam side by side', async ({ page, project, sandbox }) => {
  seedExam(sandbox, project);
  await openProject(page, project);
  await openPage(page, 'evidence');
  const figures = page.locator('.evidence-figures li');
  // 带上经验之前 2 处问题，之后 0 处；这条经验考过试、正在用。
  await expect(figures.nth(0).locator('strong')).toHaveText(/2\s*→\s*0/);
  await expect(figures.nth(1)).toContainText('考试通过');
  await expect(figures.nth(1)).toContainText('1 个镜头 × 每组 1 次');
  await expect(figures.nth(2).locator('strong')).toHaveText('1');
  // 两段画面都读得到：路径来自考场里 scene.json 的 output。
  const control = page.locator('.evidence-side.control');
  const trial = page.locator('.evidence-side.trial');
  await expect(control.locator('video')).toHaveAttribute('src', /claude-control-1%2Fscene-001\.mp4/);
  await expect(trial.locator('video')).toHaveAttribute('src', /claude-trial-1%2Fscene-001\.mp4/);
  // 问题用大白话说，不露出校验器的编号。
  await expect(control).toContainText('查出 2 处问题');
  await expect(control).toContainText('文字停留太短，读不完 · 2 处');
  await expect(control).not.toContainText('reads.duration');
  await expect(trial).toContainText('没有查出问题');
  await expect(page.locator('.evidence-lesson')).toContainText('画面上的字要停够时间再换');
  await expect(page.locator('.evidence-lesson .evidence-chip')).toHaveText('正在用');
});

test('the evidence page says what to do before any exam', async ({ page, project }) => {
  await openProject(page, project);
  await openPage(page, 'evidence');
  await expect(page.locator('.evidence-empty')).toContainText('还没有考过试的经验');
  await page.locator('.evidence-empty button').click();
  await expect(page.locator('.memory-tab')).toBeVisible();
});

test('live exam questions and both arms update without reopening memory or evolution', async ({ page, project, sandbox, electronApp }) => {
  const examDir = path.join(sandbox.memory, 'exams', 'exam-0001');
  fs.mkdirSync(examDir, { recursive: true });
  const pid = await electronApp.evaluate(() => process.pid);
  const progress = {
    id: 'exam-0001', pid, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    workspace: path.join(project.path, 'production', 'memory-exams'), status: 'running',
    trials: [{ name: 'hold-readable', description: '画面上的字要停够时间再换', checks: ['reads.duration'] }],
    questions: [{ id: 'q1', scene_id: 'scene-001', holdout: false, text: '这道题考字幕阅读时间', input: '' }],
    cells: ['control', 'trial'].map((arm) => ({ question: 'q1', renderer: 'claude', arm, repeat: 1, status: arm === 'control' ? 'running' : 'queued' })),
  };
  const file = path.join(examDir, 'progress.json');
  fs.writeFileSync(file, JSON.stringify(progress));
  await openProject(page, project);
  await openPage(page, 'memory');
  const panel = page.getByRole('region', { name: '考试进度' });
  await expect(panel).toContainText('已完成 0 / 2 组');
  await expect(panel).toContainText('这道题考字幕阅读时间');
  await expect(panel).toContainText('画面上的字要停够时间再换');
  await expect(panel).toContainText('等待空位');
  progress.cells[0].status = 'completed';
  progress.cells[0].result = { passed: true, problems: 0 };
  progress.cells[1].status = 'running';
  fs.writeFileSync(file, JSON.stringify(progress));
  await expect(panel).toContainText('已完成 1 / 2 组');
  await openPage(page, 'evidence');
  await expect(page.getByRole('region', { name: '考试进度' })).toContainText('已完成 1 / 2 组');
  seedExam(sandbox, project);
  progress.status = 'completed';
  fs.writeFileSync(file, JSON.stringify(progress));
  await expect(page.getByRole('region', { name: '考试进度' })).toHaveCount(0);
  await expect(page.locator('.evidence-figures')).toContainText('考试通过');
  await openPage(page, 'memory');
  const recent = page.getByRole('region', { name: '最近考试结果' });
  await expect(recent).toBeVisible();
  await expect(recent).toContainText('画面上的字要停够时间再换');
  await expect(recent.locator('video[controls]')).toHaveCount(2);
  await recent.getByText('第 1 次 · 查看问题', { exact: true }).click();
  await expect(recent).toContainText('实际带入：无');
});

test('evolution can inspect each repeated pair and exposes invalid exams', async ({ page, project, sandbox }) => {
  seedExam(sandbox, project);
  const file = path.join(sandbox.memory, 'exams', 'exam-0001', 'result.json');
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  result.cells.push(...result.cells.map((c) => ({ ...c, repeat: 2, passed: true, problems: 0, checks: [] })));
  fs.writeFileSync(file, JSON.stringify(result));
  const invalid = path.join(sandbox.memory, 'exams', 'exam-0002');
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, 'result.json'), JSON.stringify({ ...result, id: 'exam-0002', applied: 'none',
    cells: result.cells.map((c) => ({ ...c, invalid: true, error: '作答工具崩溃' })),
    verdict: { pass: false, invalid: true, needs_human: false, control_score: 0, trial_score: 0, reasons: ['作答无效，不计成绩'] } }));
  await openProject(page, project);
  await openPage(page, 'evidence');
  await expect(page.locator('.evidence')).toContainText('exam-0002 · 考试无效');
  await expect(page.locator('.evidence')).toContainText('作答工具崩溃');
  await expect(page.locator('.evidence-side.control')).toContainText('查出 2 处问题');
  await page.getByRole('combobox', { name: '第几次重复' }).selectOption('2');
  await expect(page.locator('.evidence-side.control')).toContainText('没有查出问题');
  await expect(page.locator('.evidence')).toContainText('不能证明每条经验单独有效');
});
