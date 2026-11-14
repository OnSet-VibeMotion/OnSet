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
  await expect(page.locator('.evidence-scope')).toContainText('本场没有留出镜头');
  await expect(page.locator('.evidence-scope')).toContainText('画面是否更好，要看人的对照评价');
});

test('missing evidence is not presented as fewer video problems', async ({ page, project, sandbox }) => {
  seedExam(sandbox, project);
  const file=path.join(sandbox.memory,'exams','exam-0001','result.json');
  const exam=JSON.parse(fs.readFileSync(file,'utf8'));
  exam.cells[0].incomplete=true;
  fs.writeFileSync(file,JSON.stringify(exam));
  await openProject(page,project);
  await openPage(page,'evidence');
  await expect(page.locator('.evidence-figures')).toContainText('暂不能比较');
  await expect(page.locator('.evidence-figures')).toContainText('检查依据不完整');
  await expect(page.locator('.evidence-side.control')).not.toContainText('文字停留太短，读不完');
  await openPage(page,'memory');
  const recent=page.getByRole('region',{name:'最近考试结果'});
  await expect(recent).toContainText('本题结果不完整，不能比较');
  await expect(recent).not.toContainText('带上后少了');
});

test('the evidence page says what to do before any exam', async ({ page, project }) => {
  await openProject(page, project);
  await openPage(page, 'evidence');
  await expect(page.locator('.evidence-empty')).toContainText('还没有考过试的经验');
  await page.locator('.evidence-empty button').click();
  await expect(page.locator('.memory-tab')).toBeVisible();
});

test('a perfect tie explains the missing improvement evidence', async ({ page, project, sandbox }) => {
  seedExam(sandbox, project);
  const file = path.join(sandbox.memory, 'exams', 'exam-0001', 'result.json');
  const exam = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const cell of exam.cells) Object.assign(cell, { passed: true, outcome: 'succeeded', problems: 0, checks: [] });
  Object.assign(exam, { applied: 'retest-failed' });
  Object.assign(exam.verdict, { pass: false, control_score: 10, trial_score: 10, reasons: ['总分没有提高：对照 10.0，试用 10.0'] });
  fs.writeFileSync(file, JSON.stringify(exam));
  await openProject(page, project);
  await openPage(page, 'evidence');
  await expect(page.locator('.evidence-figures')).toContainText('未发现额外改善');
  await expect(page.getByText('两组都通过了本场检查，尚未证明经验带来额外改善。', { exact: false })).toBeVisible();
  await openPage(page, 'memory');
  const latest = page.getByRole('region', { name: '最近考试结果' });
  await expect(latest.locator('.exam-review-heading')).toContainText('未发现额外改善');
  await expect(latest.locator('.exam-no-gain')).toContainText('重复相同满分题不能增加改善证据');
});

test('memory recall keeps the last count during slow polling and temporary errors', async ({ page, project }) => {
  await openProject(page, project);
  await page.evaluate(() => {
    const original = window.fetch;
    window.__recallCalls = 0;
    window.__recallRelease = null;
    window.fetch = (input, init) => {
      if (typeof input === 'string' && input.startsWith('/api/memory/recall?')) {
        window.__recallCalls++;
        const body = { recall: { items: [{ name: 'one-rule', kind: 'lesson', description: '会带上的提醒' }], omitted: [] }, reasons: [], section: '' };
        if (window.__recallCalls === 1) return Promise.resolve(new Response(JSON.stringify(body)));
        return new Promise((resolve) => { window.__recallRelease = () => resolve(new Response('{"message":"暂时不可用"}', { status: 503 })); });
      }
      return original.call(window, input, init);
    };
  });
  await openPage(page, 'memory');
  const count = page.locator('.memory-flow li').nth(2);
  await expect(count.locator('strong')).toHaveText('1');
  await expect.poll(() => page.evaluate(() => window.__recallCalls)).toBeGreaterThanOrEqual(2);
  await expect(count.locator('strong')).toHaveText('1');
  await page.waitForTimeout(600);
  await expect(count.locator('strong')).toHaveText('1');
  await page.evaluate(() => window.__recallRelease());
  await expect(count).toContainText('上次结果，暂未更新');
  await expect(count.locator('strong')).toHaveText('1');
});

test('a stopped lesson finds applicable scenes and can request a retest without being enabled', async ({ page, project, sandbox }) => {
  seedExam(sandbox, project);
  const file = path.join(sandbox.memory, 'lessons', 'hold-readable.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: active', 'status: dormant'));
  fs.writeFileSync(path.join(project.path, 'scenes', 'scene-001', 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
  await openProject(page, project);
  await openPage(page, 'memory');
  await page.getByRole('region', { name: '重考入口' }).getByRole('button', { name: '查看并重考', exact: true }).click();
  await expect(page.locator('.memory-retired')).toHaveJSProperty('open', true);
  const card = page.locator('.memory-retired .memory-card');
  await expect(card.getByRole('button', { name: '重新考试', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '查找适用镜头', exact: true }).click();
  await expect(card.locator('.memory-application-results')).toContainText('scene-001');
  await expect(card.locator('.memory-application-results')).toContainText('试用时能召回');
  expect(fs.readFileSync(file, 'utf8')).toContain('status: dormant');
  await page.evaluate(() => {
    const original = window.fetch;
    window.__examRequests = [];
    window.fetch = (input, init) => {
      if (input === '/api/memory/actions/exam') {
        window.__examRequests.push(JSON.parse(init.body));
        return Promise.resolve(new Response('{"task_id":"stopped-retest"}', { status: 202 }));
      }
      return original.call(window, input, init);
    };
  });
  await card.getByRole('button', { name: '用所选 1 个镜头重新考试', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__examRequests)).toEqual([{ renderers: ['claude'], scenes: ['scene-001'], name: 'hold-readable' }]);
  expect(fs.readFileSync(file, 'utf8')).toContain('status: dormant');
});

test('migration testing excludes source scenes and submits only selected new scenes', async ({ page, project, sandbox }) => {
  seedExam(sandbox, project);
  const file = path.join(sandbox.memory, 'lessons', 'hold-readable.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: active', 'status: dormant'));
  await openProject(page, project);
  await page.evaluate(() => {
    const original = window.fetch;
    window.__migrationRequests = [];
    window.fetch = (input, init) => {
      if (typeof input === 'string' && input.startsWith('/api/memory/applications?')) return Promise.resolve(new Response(JSON.stringify({
        name: 'hold-readable', enabled: true, scanned: 2, unreadable: 0, matches: [true, false].map((source, i) => ({
          scene_id: `scene-00${i + 1}`, text: source ? '来源镜头' : '新的镜头', renderer: 'claude', model: '', selected: true,
          features: [], keywords: [], global: true, omit_reason: '', source_scene: source,
        })),
      })));
      if (input === '/api/memory/actions/exam') {
        window.__migrationRequests.push(JSON.parse(init.body));
        return Promise.resolve(new Response('{"task_id":"migration"}', { status: 202 }));
      }
      return original.call(window, input, init);
    };
  });
  await openPage(page, 'memory');
  await page.getByRole('region', { name: '重考入口' }).getByRole('button', { name: '查看并重考', exact: true }).click();
  const card = page.locator('.memory-retired .memory-card');
  await card.getByRole('button', { name: '查找适用镜头', exact: true }).click();
  await card.getByRole('checkbox', { name: '仅验证所选新镜头', exact: true }).check();
  const rows = card.locator('.memory-application-results li');
  await expect(rows.nth(0).locator('input')).toBeDisabled();
  await expect(rows.nth(1).locator('input')).toBeChecked();
  await card.getByRole('button', { name: '用所选 1 个镜头重新考试', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__migrationRequests)).toEqual([
    { renderers: ['claude'], scenes: ['scene-002'], holdout_only: true, name: 'hold-readable' },
  ]);
});

for (const status of ['rejected', 'trial']) {
  test(`evolution exposes a visible exam entry for a ${status} lesson`, async ({ page, project, sandbox }) => {
    seedExam(sandbox, project);
    const file = path.join(sandbox.memory, 'lessons', 'hold-readable.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: active', `status: ${status}`));
    await openProject(page, project);
    await openPage(page, 'evidence');
    const entry = page.getByRole('region', { name: '重考入口' }).getByRole('button', { name: '查看并重考', exact: true });
    await expect(entry).toBeInViewport();
    await entry.click();
    const button = page.getByRole('region', { name: '本场经验与重考' }).getByRole('button', { name: status === 'trial' ? '只考这条' : '重新考试', exact: true });
    await expect(button).toBeInViewport();
    await page.evaluate(() => {
      const original = window.fetch;
      window.__examRequests = [];
      window.fetch = (input, init) => {
        if (input === '/api/memory/actions/exam') {
          window.__examRequests.push(JSON.parse(init.body));
          return Promise.resolve(new Response('{"task_id":"evolution-exam-entry"}', { status: 202 }));
        }
        return original.call(window, input, init);
      };
    });
    await button.click();
    await expect.poll(() => page.evaluate(() => window.__examRequests)).toEqual([{ renderers: ['claude'], ...(status === 'trial' ? { trial: 'hold-readable' } : { name: 'hold-readable' }) }]);
    expect(fs.readFileSync(file, 'utf8')).toContain(`status: ${status}`);
  });
}

test('memory exam videos are large, playable together and share a seek control', async ({ page, project, sandbox }) => {
  seedExam(sandbox, project);
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const draw = (x) => { ctx.fillStyle = '#162933'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#f2dfb2'; ctx.font = '36px sans-serif'; ctx.fillText('Readable motion example', 40, 100); ctx.fillRect(x, 180, 80, 80); };
    draw(40);
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    const done = new Promise((resolve) => { recorder.ondataavailable = (e) => chunks.push(e.data); recorder.onstop = () => resolve(new Blob(chunks)); });
    recorder.start();
    let x = 40;
    const interval = setInterval(() => { x = (x + 12) % 520; draw(x); }, 80);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    clearInterval(interval); recorder.stop();
    const blob = await done; stream.getTracks().forEach((t) => t.stop());
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const resultFile = path.join(sandbox.memory, 'exams', 'exam-0001', 'result.json');
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  for (const cell of result.cells) {
    const sceneFile = path.join(cell.workdir, 'scene.json');
    const scene = JSON.parse(fs.readFileSync(sceneFile, 'utf8')); scene.output = 'comparison.webm';
    fs.writeFileSync(sceneFile, JSON.stringify(scene));
    fs.writeFileSync(path.join(cell.workdir, scene.output), Buffer.from(bytes));
  }
  result.verdict = { ...result.verdict, pass: false, control_score: 10, trial_score: -1, reasons: ['带上后多了一处阅读时间问题'] };
  result.cells[0].passed = true; result.cells[0].problems = 0; result.cells[0].checks = [];
  result.cells[1].passed = false; result.cells[1].problems = 1; result.cells[1].checks = ['reads.duration'];
  result.applied = 'none';
  fs.writeFileSync(resultFile, JSON.stringify(result));
  await openProject(page, project);
  await openPage(page, 'memory');
  const recent = page.getByRole('region', { name: '最近考试结果' });
  await expect(recent).toContainText('带上后多了 1 处问题');
  await expect(page.locator('.memory-flow li').nth(2)).toContainText('暂时无法读取');
  await expect.poll(() => recent.locator('video').evaluateAll((vs) => vs.every((v) => v.readyState >= 2))).toBe(true);
  // MediaRecorder 的 WebM 没写总时长；读到末尾后 Chromium 才知道时长。
  await recent.locator('video').evaluateAll((vs) => vs.forEach((v) => { if (!Number.isFinite(v.duration)) v.currentTime = 1e6; }));
  await expect.poll(() => recent.locator('video').evaluateAll((vs) => vs.every((v) => Number.isFinite(v.duration)))).toBe(true);
  await recent.getByRole('button', { name: '回到开头', exact: true }).click();
  const size = await recent.locator('video').first().boundingBox();
  expect(size.width).toBeGreaterThan(260); expect(size.height).toBeGreaterThanOrEqual(240);
  await recent.getByRole('button', { name: '两边一起播放', exact: true }).click();
  await expect.poll(() => recent.locator('video').evaluateAll((vs) => vs.every((v) => !v.paused))).toBe(true);
  await recent.getByRole('button', { name: '暂停', exact: true }).click();
  await recent.getByRole('slider', { name: '对照视频时间' }).evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '1');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => recent.locator('video').evaluateAll((vs) => vs.every((v) => Math.abs(v.currentTime - 1) < 0.15))).toBe(true);
  await page.screenshot({ path: test.info().outputPath('memory-exam-comparison.png'), fullPage: true });
  await recent.locator('.evidence-controls').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: test.info().outputPath('memory-exam-players.png'), fullPage: true });
  await page.locator('.memory-tab').evaluate((el) => { el.style.width = '360px'; el.style.maxWidth = '100%'; });
  const boxes = await recent.locator('video').evaluateAll((vs) => vs.map((v) => { const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }));
  expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
  expect(Math.abs(boxes[1].x - boxes[0].x)).toBeLessThan(2);
});

test('a trial lesson can be examined on its own from its memory card', async ({ page, project, sandbox }) => {
  seedExam(sandbox, project);
  const lessonFile = path.join(sandbox.memory, 'lessons', 'hold-readable.md');
  fs.writeFileSync(lessonFile, fs.readFileSync(lessonFile, 'utf8').replace('status: active', 'status: trial'));
  await openProject(page, project);
  await openPage(page, 'memory');
  // onset:// 是 Electron 的自定义协议，不经过 Playwright 的 HTTP route 拦截。
  await page.evaluate(() => {
    const original = window.fetch;
    window.__examRequests = [];
    window.fetch = (input, init) => {
      if (input === '/api/memory/actions/exam') {
        window.__examRequests.push(JSON.parse(init.body));
        return Promise.resolve(new Response('{"task_id":"selected-trial"}', { status: 202 }));
      }
      return original.call(window, input, init);
    };
  });
  await page.getByRole('button', { name: '只考这条', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__examRequests)).toEqual([{ renderers: ['claude'], trial: 'hold-readable' }]);
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
