import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, openPage } from './fixtures.mjs';

// 进化页：一场考过的试排成「同一个镜头带与不带一条经验」的两段画面、这条经验本身与考试结果。
// 页面怎么说、点了发什么在组件测试里（src/renderer/components/Evidence.test.tsx、Memory.test.tsx、ExamPlayer.test.tsx）；
// 这里只留要真实排版的：长结论不溢出自己的格子、窄面板里竖排。

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
});
