import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, openPage } from './fixtures.mjs';

// 试镜页：两位选手拍完的一场试镜，评判之前只看得到 A、B，选完才揭晓是谁，并记进记忆库的评判记录。

function seedAudition(project, exam = null) {
  const id = exam ? 'audition-20261114-160000' : 'audition-20261114-153012';
  const dir = path.join(project.path, 'production', 'studio', 'auditions', id);
  const contestant = (slot, renderer, model, role = '') => {
    const workdir = path.join(dir, slot);
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, 'scene.json'), JSON.stringify({ id: 'scene-001', duration_seconds: 1, output: 'out.mp4', transcript: 'voice.srt', text: 'hello' }));
    fs.writeFileSync(path.join(workdir, 'out.mp4'), 'video');
    return {
      slot,
      renderer,
      model,
      actual_model: model,
      workdir: `production/studio/auditions/${id}/${slot}`,
      status: 'done',
      outcome: 'succeeded',
      output: `production/studio/auditions/${id}/${slot}/out.mp4`,
      seconds: 42,
      usage: { input_tokens: 120000, output_tokens: 8000 },
      problems: null,
      checks: null,
      error: '',
      designer: '',
      designer_model: '',
      role,
    };
  };
  fs.writeFileSync(
    path.join(dir, 'audition.json'),
    JSON.stringify({
      id,
      created_at: '2026-11-14T07:30:12Z',
      scene_id: 'scene-001',
      scene_dir: 'scenes/scene-001',
      features: [],
      with_memory: true,
      input_digest: 'x',
      contestants: exam
        ? [contestant('A', 'codex', 'student', 'control'), contestant('B', 'codex', 'student', 'trial'), contestant('R', 'claude', 'teacher', 'reference')]
        : [contestant('A', 'claude', 'secret-model-one'), contestant('B', 'codex', 'secret-model-two')],
      verdict: null,
      adopted: null,
      exam,
    }),
  );
  return { id, dir };
}

test('an audition stays blind until judged, then reveals and records the verdict', async ({ page, project, sandbox }) => {
  const { dir } = seedAudition(project);
  await openProject(page, project);
  await page.locator('.rail-scene[title="scene-001"]').click();
  await page.locator('.scene-menu > summary').click();
  await page.locator('#audition-scene').click();

  const cards = page.locator('.audition-card');
  await expect(cards).toHaveCount(2);
  await expect(page.locator('.audition')).not.toContainText('secret-model');
  await expect(page.locator('.audition')).not.toContainText('codex');
  // 还没评判，不能采用。
  await expect(page.locator('.audition-card button', { hasText: '换进镜头' })).toHaveCount(0);

  await page.locator('.audition-judge input').fill('节奏更稳');
  await page.locator('.audition-card[data-slot="B"] button', { hasText: '选它' }).click();

  await expect(page.locator('.audition-card[data-slot="B"] .audition-who')).toHaveText('codex · secret-model-two');
  await expect(page.locator('.audition-card[data-slot="B"] .audition-chip.on')).toHaveText('你选的');
  await expect(page.locator('.audition-verdict')).toContainText('节奏更稳');
  await expect(page.locator('.audition-card[data-slot="B"] button', { hasText: '换进镜头' })).toBeVisible();

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'audition.json'), 'utf8'));
  expect(saved.verdict).toMatchObject({ kind: 'winner', winner: 'B', note: '节奏更稳' });
  const log = fs.readFileSync(path.join(sandbox.memory, 'auditions.jsonl'), 'utf8');
  expect(log).toContain('"winner":"codex/secret-model-two"');
});

test('a human-judged exam shows the teacher openly, hides which student had the lessons, and settles them', async ({ page, project, sandbox }) => {
  const lessons = path.join(sandbox.memory, 'lessons');
  fs.mkdirSync(lessons, { recursive: true });
  fs.writeFileSync(
    path.join(lessons, 'layer-depth-first.md'),
    '---\nname: layer-depth-first\ndescription: 先立住前后层次再加动效\nstatus: trial\napplies_when:\n  renderers: [codex]\n  models: [student]\nchecked_by: [audition.judged]\nlearned_from: [claude/teacher]\n---\n\n先分层。\n\n反例：\n    一层\n\n正例：\n    三层\n',
  );
  seedAudition(project, { relation: 'rel-1', student: 'codex/student', teacher: 'claude/teacher', lessons: ['layer-depth-first'], applied: '' });
  await openProject(page, project);
  await page.locator('.rail-scene[title="scene-001"]').click();
  await page.locator('.scene-menu > summary').click();
  await page.locator('#audition-scene').click();

  await expect(page.locator('.audition-exam')).toContainText('向 claude · teacher 学的 1 条经验');
  await expect(page.locator('.audition-card[data-slot="R"] .audition-who')).toHaveText('claude · teacher');
  await expect(page.locator('.audition-card[data-slot="A"] .audition-who')).toHaveCount(0);
  await expect(page.locator('.audition-card[data-slot="R"] button', { hasText: '选它' })).toHaveCount(0);
  await page.locator('.audition-card[data-slot="B"] button', { hasText: '选它' }).click();

  await expect(page.locator('.audition-verdict')).toContainText('这些经验生效');
  await expect(page.locator('.audition-card[data-slot="B"] .audition-chip', { hasText: '带经验' })).toBeVisible();
  await expect(page.locator('.audition-verdict button', { hasText: '改判' })).toHaveCount(0);
  await expect(page.locator('.audition-card button', { hasText: '换进镜头' })).toHaveCount(0);
  expect(fs.readFileSync(path.join(lessons, 'layer-depth-first.md'), 'utf8')).toContain('status: active');
});

test('the evidence page proposes who should learn from whom, and the relation can be confirmed', async ({ page, project, sandbox }) => {
  fs.mkdirSync(sandbox.memory, { recursive: true });
  const row = (i, winner) =>
    JSON.stringify({
      at: `2026-11-1${i}T00:00:00Z`,
      project: 'p',
      project_dir: '',
      purpose: '',
      audition: `audition-2026111${i}-000000`,
      scene_id: 'scene-001',
      features: [],
      with_memory: true,
      kind: 'winner',
      winner,
      winner_slot: winner === 'claude/teacher' ? 'A' : 'B',
      note: '',
      contestants: [
        { slot: 'A', key: 'claude/teacher', renderer: 'claude', model: 'teacher', designer: '', outcome: 'succeeded', problems: 0, role: '' },
        { slot: 'B', key: 'codex/student', renderer: 'codex', model: 'student', designer: '', outcome: 'succeeded', problems: 0, role: '' },
      ],
    });
  // 还没有考过试时，进化页先说该做什么，按钮带去记忆页。
  await openProject(page, project);
  await openPage(page, 'evidence');
  await expect(page.locator('.evidence-empty')).toContainText('还没有考过试的经验');
  await page.locator('.evidence-empty button').click();
  await expect(page.locator('.memory-tab')).toBeVisible();
  fs.writeFileSync(path.join(sandbox.memory, 'auditions.jsonl'), [row(1, 'claude/teacher'), row(2, 'claude/teacher'), row(3, 'codex/student'), row(4, 'claude/teacher')].join('\n') + '\n');
  await page.reload();
  await openPage(page, 'evidence');
  const proposal = page.locator('.learning-proposal');
  await expect(proposal).toContainText('codex · student 在 4 场里输给 claude · teacher 3 场');
  await proposal.locator('button', { hasText: '让它学' }).click();
  const relation = page.locator('.learning-relation');
  await expect(relation).toContainText('codex · student');
  await expect(relation).toContainText('正面比了 4 场');
  await expect(relation.locator('.learning-curve circle.pt')).toHaveCount(4);
  await expect(page.locator('.learning-proposal')).toHaveCount(0);
  const saved = JSON.parse(fs.readFileSync(path.join(sandbox.memory, 'learning.json'), 'utf8'));
  expect(saved.relations[0]).toMatchObject({ student: 'codex/student', teacher: 'claude/teacher' });
});
