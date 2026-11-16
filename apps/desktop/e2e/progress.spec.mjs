import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 制作路线：按产物列出每一站做没做、现在在哪，「接下来」卡片说清下一步；关卡记下用户的确认；每一轮归到它动过的站上。

async function write(root, rel, body) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
}

test('the production map shows what was done and where the project is', async ({ page, project }) => {
  await write(project.path, 'production/script-final.md', '# 标题\n\n猫推开了门。\n');
  await write(project.path, 'production/audio/voice.wav', 'RIFF');
  await write(project.path, 'production/audio/voice.srt', '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  await write(project.path, 'production/scene-plan.json', JSON.stringify({ schema: 1, scenes: [{ id: 'scene-001', dir: 'scenes/scene-001', chapter: '开场' }] }));
  await openProject(page, project);

  // 对话顶上一行：现在在分镜审核，等你确认。顶栏「分镜」是当前一步。
  await expect(page.locator('#progress-strip')).toContainText('现在 · 分镜审核');
  await expect(page.locator('#progress-strip')).toContainText('等你确认');
  await expect(page.locator('#progress-strip')).toHaveClass(/waiting/);
  await expect(page.locator('[data-tab="storyboard"]')).toHaveClass(/current/);

  // 「接下来」卡片说清现在做什么：「看分镜」打开分镜页；「我要改」只是把一句话填进输入框。
  const card = page.locator('#next-step');
  await expect(card).toContainText('分镜审核');
  await expect(card).toContainText('渲染前先看一遍');
  await card.getByRole('button', { name: '看分镜' }).click();
  await expect(page.locator('#storyboard')).toBeVisible();
  await card.getByRole('button', { name: '我要改' }).click();
  await expect(page.locator('#prompt')).toHaveValue(/分镜这几处要改/);

  // 点开制作路线。
  await page.locator('#progress-strip').click();
  const map = page.locator('#progress-page');
  await expect(map).toBeVisible();
  await expect(map.locator('.pg-group-title')).toHaveText([/口播稿/, /分镜/, /镜头/, /成片/, /发布/]);
  await expect(map.locator('[data-station="script"]')).toContainText('约 5 字');
  await expect(map.locator('[data-station="intake"]')).toContainText('没留下产物');
  await expect(map.locator('[data-station="gate-script"]')).toContainText('已经过了');
  await expect(map.locator('[data-station="timeline"]')).toContainText('1 条字幕');
  await expect(map.locator('[data-station="gate-storyboard"]')).toHaveClass(/current/);
  await expect(map.locator('[data-station="render"]')).toContainText('0 / 1 个镜头出片');

  // 改一次镜头提示词：这一轮归到「拆分镜头」，对话里这一轮结尾标出来。
  await page.locator('#prompt').fill('把镜头提示词改成 after');
  await page.locator('#send').click();
  await expect(page.locator('.done-line').last()).toContainText('→ 拆分镜头');
  const plan = map.locator('[data-station="plan"]');
  await plan.locator('.pg-toggle').click();
  await expect(plan.locator('.pg-turn')).toContainText('把镜头提示词改成 after');
  // 点那一轮：对话滚到那里并闪一下。
  await plan.locator('.pg-turn').click();
  await expect(page.locator('.assistant-flow.jump-flash')).toHaveCount(1);

  // 在路线上确认分镜：记下确认、把话交给对话，下一站变成渲染镜头。
  await map.locator('[data-station="gate-storyboard"] button.primary').click();
  await expect(page.locator('.message.user').last()).toContainText('分镜我看过了，没问题，开始渲染。');
  await expect(map.locator('[data-station="gate-storyboard"]')).toContainText('你在');
  await expect(map.locator('[data-station="render"]')).toHaveClass(/current/);
  const gates = JSON.parse(await fs.readFile(path.join(project.path, 'production', 'studio', 'gates.json'), 'utf8'));
  expect(Object.keys(gates.gates)).toEqual(['gate-storyboard']);

  // 确认之后分镜又改了：关卡变成「改过」，要重新看。
  await write(project.path, 'production/scene-plan.json', JSON.stringify({ schema: 1, scenes: [{ id: 'scene-001', dir: 'scenes/scene-001', chapter: '改过的开场' }] }));
  await page.locator('#prompt').fill('排版测试');
  await page.locator('#send').click();
  await expect(page.locator('.done-line').last()).toContainText('已完成');
  await expect(map.locator('[data-station="gate-storyboard"]')).toContainText('确认后又改过');
  await expect(page.locator('#progress-strip')).toContainText('改过了，等你再看一遍');
});
