import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  await expect(control.locator('video')).toHaveAttribute('src', /\/api\/memory\/exams\/exam-0001\/video\?.*arm=control/);
  await expect(trial.locator('video')).toHaveAttribute('src', /\/api\/memory\/exams\/exam-0001\/video\?.*arm=trial/);
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

test('human acceptance persists, shows evolution complete, and retains incomplete machine remarks', async ({ page, project, sandbox }) => {
  seedExam(sandbox, project);
  const file = path.join(sandbox.memory, 'exams', 'exam-0001', 'result.json');
  const exam = JSON.parse(fs.readFileSync(file, 'utf8'));
  exam.cells[0].incomplete = true;
  Object.assign(exam.verdict, {pass: false, needs_human: true, reasons: ['检查依据不完整，原始备注保留']});
  fs.writeFileSync(file, JSON.stringify(exam));
  const machine = fs.readFileSync(file);
  const cli = fileURLToPath(new URL('../../../packages/cli/dist/onset.cjs', import.meta.url));
  execFileSync(process.execPath, [cli, 'memory', 'accept-exam', '--exam', 'exam-0001', '--name', 'hold-readable', '--questions', 'q1', '--note', '用户认可该镜头的观看效果', '--statement', '我认为这个已经属于进化完成了'], {
    cwd: project.path, env: {...process.env, ONSET_MEMORY_DIR: sandbox.memory, ONSET_SETTINGS_FILE: sandbox.settings, HOME: sandbox.home}, encoding: 'utf8',
  });
  const later = path.join(sandbox.memory, 'exams', 'exam-0002');
  fs.mkdirSync(later, {recursive: true});
  fs.writeFileSync(path.join(later, 'result.json'), JSON.stringify({...exam, id: 'exam-0002'}));
  await openProject(page, project);
  await openPage(page, 'evidence');
  await expect(page.locator('.evidence-figures')).toContainText('进化完成');
  await expect(page.locator('.evidence-figures')).toContainText('检查依据不完整');
  const accepted = page.getByRole('region', {name: '人工验收结论'});
  await expect(accepted).toContainText('exam-0001 · q1 · scene-001');
  await expect(accepted).toContainText('后续渲染符合适用条件的镜头会继续带上');
  await expect(page.locator('.evidence')).toContainText('检查依据不完整，原始备注保留');
  await page.reload();
  await openPage(page, 'evidence');
  await expect(page.getByRole('region', {name: '人工验收结论'})).toContainText('进化完成');
  await openPage(page, 'memory');
  await expect(page.getByRole('region', {name: '人工验收结论'})).toContainText('人工验收通过');
  await expect(page.locator('.memory-tab')).toContainText('检查依据不完整');
  expect(fs.readFileSync(file)).toEqual(machine);
});

test('long exam conclusions remain inside their columns and stack in a narrow panel', async ({ page, project, sandbox, electronApp }) => {
  seedExam(sandbox, project);
  const file = path.join(sandbox.memory, 'exams', 'exam-0001', 'result.json');
  const exam = JSON.parse(fs.readFileSync(file, 'utf8')); exam.cells[0].incomplete = true;
  fs.writeFileSync(file, JSON.stringify(exam));
  await openProject(page, project);
  await openPage(page, 'evidence');
  const evidence = page.locator('.evidence'), summary = evidence.locator('.evidence-figures');
  await expect(summary).toContainText('检查依据不完整');
  for (const zoom of [1, 1.25]) {
    await electronApp.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows().find(w => w.isResizable()).webContents.setZoomFactor(value), zoom);
    for (const width of [840, 680, 420, 320]) {
      await evidence.evaluate((el, value) => { el.style.width = `${value}px`; el.style.maxWidth = 'none'; }, width);
      const layout = await summary.evaluate(el => [...el.children].map(cell => {
        const box = cell.getBoundingClientRect();
        const text = [...cell.children].flatMap(child => {
          const range = document.createRange(); range.selectNodeContents(child);
          return [...range.getClientRects()].map(rect => ({left: rect.left, right: rect.right, bottom: rect.bottom}));
        });
        return {top: box.top, bottom: box.bottom, left: box.left, right: box.right,
          contained: text.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.bottom <= box.bottom + 1)};
      }));
      expect(layout.every(cell => cell.contained), `width=${width}, zoom=${zoom}`).toBe(true);
      if (width <= 684) expect(layout[1].top).toBeGreaterThanOrEqual(layout[0].bottom - 1);
      else expect(layout[1].top).toBeCloseTo(layout[0].top, 0);
    }
  }
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.isResizable()).webContents.setZoomFactor(1));
  await evidence.evaluate(el => { el.style.width = '840px'; });
  await summary.screenshot({path: test.info().outputPath('exam-conclusions-no-overlap.png')});
  // 依据不完整时不当成「问题更少」：概要说暂不能比较，对照组也不列出问题。
  await expect(summary).toContainText('暂不能比较');
  await expect(page.locator('.evidence-side.control')).not.toContainText('文字停留太短，读不完');
  await openPage(page, 'memory');
  const recent = page.getByRole('region', {name: '最近考试结果'});
  await expect(recent).toContainText('本题结果不完整，不能比较');
  await expect(recent).not.toContainText('带上后少了');
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

  // 迁移验证：来源镜头不能选，只交所选的新镜头。重新载入后换上假的适用镜头列表。
  await page.reload();
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
  const migration = page.locator('.memory-retired .memory-card');
  await migration.getByRole('button', { name: '查找适用镜头', exact: true }).click();
  await migration.getByRole('checkbox', { name: '仅验证所选新镜头', exact: true }).check();
  const rows = migration.locator('.memory-application-results li');
  await expect(rows.nth(0).locator('input')).toBeDisabled();
  await expect(rows.nth(1).locator('input')).toBeChecked();
  await migration.getByRole('button', { name: '用所选 1 个镜头重新考试', exact: true }).click();
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
    if (status !== 'trial') return;
    // 试用经验在记忆页自己的卡片上也能单独考。onset:// 是 Electron 的自定义协议，不经过 Playwright 的 HTTP route 拦截。
    await page.reload();
    await openPage(page, 'memory');
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
}

test('memory exam videos play historical source narration and share a seek control', async ({ page, project, sandbox }) => {
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
  // 无声镜头按冻结时间合同叠加项目口播：音频含非零信号，起点为全片 0.5 秒。
  const voiceDir = path.join(project.path, 'production/audio'); fs.mkdirSync(voiceDir, { recursive: true });
  const rate = 24000, samples = rate * 5, wave = Buffer.alloc(44 + samples * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 2, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wave.writeInt16LE(Math.round(Math.sin(i / rate * 440 * Math.PI * 2) * 3000), 44 + i * 2);
  fs.writeFileSync(path.join(voiceDir, 'voice.wav'), wave);
  const timing = { fps: 30, start_frame: 15, end_frame_exclusive: 105, plan: 'a'.repeat(64), phrases: 'phrases.json' };
  const phrases = { schema: 1, fps: 30, phrases: [{ phrase_id: 'hello', source_text: 'hello', semantic_order: 1, start_frame: 15, end_frame_exclusive: 95 }] };
  const originalDir = path.join(project.path, 'scenes/scene-001');
  const originalScene = JSON.parse(fs.readFileSync(path.join(originalDir, 'scene.json'), 'utf8'));
  fs.writeFileSync(path.join(originalDir, 'scene.json'), JSON.stringify({ ...originalScene, duration_seconds: 3, timing }));
  fs.writeFileSync(path.join(originalDir, 'phrases.json'), JSON.stringify(phrases));
  fs.writeFileSync(path.join(project.path, 'frame.md'), '---\ncanvas: {width_px: 640, height_px: 360, fps: 30}\n---\n');
  // 同编号、同文字的当前项目也有音频，但它是静音；必须沿旧题来源读取另一个项目的有声 WAV。
  const prior = path.join(sandbox.home, 'earlier-video-project'), priorScene = path.join(prior, 'scenes/scene-001');
  fs.cpSync(originalDir, priorScene, {recursive: true});
  fs.copyFileSync(path.join(project.path, 'onset.conf'), path.join(prior, 'onset.conf'));
  fs.copyFileSync(path.join(project.path, 'onset.flow.json'), path.join(prior, 'onset.flow.json'));
  fs.copyFileSync(path.join(project.path, 'frame.md'), path.join(prior, 'frame.md'));
  fs.mkdirSync(path.join(prior, 'production/audio'), {recursive: true});
  fs.writeFileSync(path.join(prior, 'production/audio/voice.wav'), wave);
  const silent = Buffer.from(wave); silent.fill(0, 44); fs.writeFileSync(path.join(voiceDir, 'voice.wav'), silent);
  const episodeDir = path.join(sandbox.memory, 'episodes/2026-11/ep-historical'); fs.mkdirSync(episodeDir, {recursive: true});
  fs.writeFileSync(path.join(episodeDir, 'episode.json'), JSON.stringify({schema: 1, id: 'ep-historical', source: 'check', created_at: '2026-11-12T07:00:00Z',
    project: 'earlier-video-project', scene_dir: priorScene, scene_id: 'scene-001', text: 'hello'}));
  result.questions[0].episode = 'ep-historical';
  for (const cell of result.cells) {
    const sceneFile = path.join(cell.workdir, 'scene.json');
    const scene = JSON.parse(fs.readFileSync(sceneFile, 'utf8')); scene.output = 'comparison.webm'; scene.duration_seconds = 3; scene.timing = timing;
    fs.writeFileSync(sceneFile, JSON.stringify(scene));
    fs.writeFileSync(path.join(cell.workdir, 'phrases.json'), JSON.stringify(phrases));
    fs.writeFileSync(path.join(cell.workdir, scene.output), Buffer.from(bytes));
  }
  // 考场与音频都留在原项目；切到新项目后仍须能载入两段视频并同步播放原配音。
  fs.renameSync(path.join(project.path, 'production/memory-exams'), path.join(prior, 'production/memory-exams'));
  for (const cell of result.cells) cell.workdir = path.join(prior, path.relative(project.path, cell.workdir));
  result.verdict = { ...result.verdict, pass: false, control_score: 10, trial_score: -1, reasons: ['带上后多了一处阅读时间问题'] };
  result.cells[0].passed = true; result.cells[0].problems = 0; result.cells[0].checks = [];
  result.cells[1].passed = false; result.cells[1].problems = 1; result.cells[1].checks = ['reads.duration'];
  result.applied = 'none';
  fs.writeFileSync(resultFile, JSON.stringify(result));
  expect(await page.evaluate(async prior => (await fetch('/api/projects/open', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path: prior})})).status, prior)).toBe(200);
  await openProject(page, project);
  await openPage(page, 'memory');
  const recent = page.getByRole('region', { name: '最近考试结果' });
  await expect(recent).toContainText('带上后多了 1 处问题');
  await expect(page.locator('.memory-flow li').nth(2)).toContainText('scene-001');
  await expect.poll(() => recent.locator('video').evaluateAll((vs) => vs.every((v) => v.readyState >= 2))).toBe(true);
  // MediaRecorder 的 WebM 没写总时长；读到末尾后 Chromium 才知道时长。
  await recent.locator('video').evaluateAll((vs) => vs.forEach((v) => { if (!Number.isFinite(v.duration)) v.currentTime = 1e6; }));
  await expect.poll(() => recent.locator('video').evaluateAll((vs) => vs.every((v) => Number.isFinite(v.duration)))).toBe(true);
  await recent.getByRole('button', { name: '回到开头', exact: true }).click();
  const size = await recent.locator('video').first().boundingBox();
  expect(size.width).toBeGreaterThan(260); expect(size.height).toBeGreaterThanOrEqual(240);
  await recent.getByRole('button', { name: '两边一起播放', exact: true }).click();
  await expect.poll(() => recent.locator('video').evaluateAll((vs) => vs.every((v) => !v.paused))).toBe(true);
  const sound = recent.locator('.exam-player > audio');
  await expect(recent.getByRole('button', { name: '配音已开启' })).toBeVisible();
  await expect(recent.locator('.exam-audio-controls')).toContainText('earlier-video-project');
  await expect.poll(() => sound.evaluate(a => !a.paused && !a.muted && a.volume > 0 && a.currentTime > 0.5)).toBe(true);
  await expect.poll(() => recent.locator('.exam-player').evaluate(el => Math.abs(el.querySelector('audio').currentTime - el.querySelector('video').currentTime - 0.5) < 0.2)).toBe(true);
  await expect(sound).toHaveCount(1);
  const peak = await sound.evaluate(async a => {
    const context = new AudioContext(), analyser = context.createAnalyser();
    context.createMediaElementSource(a).connect(analyser); analyser.connect(context.destination);
    await context.resume();
    const signal = new Float32Array(analyser.fftSize);
    let peak = 0;
    for (let i = 0; i < 15 && peak <= 0.01; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      analyser.getFloatTimeDomainData(signal);
      peak = Math.max(...signal.map(Math.abs));
    }
    window.__examAudioContext = context;
    return { peak, state: context.state, paused: a.paused, muted: a.muted, volume: a.volume, time: a.currentTime, ready: a.readyState };
  });
  expect(peak.peak, JSON.stringify(peak)).toBeGreaterThan(0.01);
  await recent.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(() => sound.evaluate(a => a.paused)).toBe(true);
  await recent.getByRole('slider', { name: '对照视频时间' }).evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '1');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => recent.locator('video').evaluateAll((vs) => vs.every((v) => Math.abs(v.currentTime - 1) < 0.15))).toBe(true);
  await expect.poll(() => sound.evaluate(a => Math.abs(a.currentTime - 1.5) < 0.15 && a.paused)).toBe(true);
  // 原生单侧播放也要带口播；切到另一侧只保留一份声音，拖动后重新对齐。
  await recent.locator('video').last().evaluate(v => {
    const playing = v.play();
    // 模拟拖动后先前一侧迟到的 play 事件，不能把新播放的一侧停掉。
    v.closest('.exam-player').querySelector('video').dispatchEvent(new Event('play'));
    return playing;
  });
  await expect.poll(() => sound.evaluate(a => !a.paused)).toBe(true);
  await expect.poll(() => recent.locator('video').first().evaluate(v => v.paused)).toBe(true);
  await recent.locator('video').last().evaluate(v => { v.currentTime = 0.8; });
  await expect.poll(() => recent.locator('.exam-player').evaluate(el => Math.abs(el.querySelector('audio').currentTime - el.querySelectorAll('video')[1].currentTime - 0.5) < 0.2)).toBe(true);
  await recent.locator('video').last().evaluate(v => v.pause());
  await expect.poll(() => sound.evaluate(a => a.paused)).toBe(true);
  await recent.getByRole('button', { name: '配音已开启' }).click();
  await expect.poll(() => sound.evaluate(a => a.muted)).toBe(true);
  await recent.getByRole('button', { name: '配音已静音' }).click();
  await expect.poll(() => sound.evaluate(a => !a.muted)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('memory-exam-comparison.png'), fullPage: true });
  await recent.locator('.evidence-controls').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: test.info().outputPath('memory-exam-players.png'), fullPage: true });
  await page.locator('.memory-tab').evaluate((el) => { el.style.width = '360px'; el.style.maxWidth = '100%'; });
  const boxes = await recent.locator('video').evaluateAll((vs) => vs.map((v) => { const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }));
  expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
  expect(Math.abs(boxes[1].x - boxes[0].x)).toBeLessThan(2);
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
