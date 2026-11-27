import { expect, openProject, petPage, test } from './fixtures.mjs';

// 编排工具（假 claude）在执行过程中通过 onset studio tools-mcp 调用 studio_ask 弹出多题卡片，
// 用户完成单选 + 多选 + 「其他」自定义输入并提交后，Agent 在同一轮内拿到结构化答案继续回复，
// 刷新页面后对话流完整回显历史问答摘要。
test('asks structured multi-question card mid-turn, continues in the same turn, and persists summary across reload', async ({
  page,
  project,
  electronApp,
}) => {
  await openProject(page, project);
  const card = page.locator('.question-card');

  await page.locator('#prompt').fill('弹一张多题问卷：开工前确认规格');
  await page.locator('#prompt').press('Enter');

  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('开工前确认 2 项规格');
  await expect(card).toContainText('推荐');
  await expect(card).toContainText('3 秒直入对比结论');

  // 桌宠同步进入 waiting 状态，并提示回片场作答。
  const pet = await petPage(electronApp);
  await expect(pet.locator('#crew')).toHaveAttribute('data-mood', 'waiting');
  await expect(pet.locator('.pet-desk[data-desk="questions"]')).toBeVisible();

  // 第 1 题单选 + 第 2 题多选与自定义「其他」组合勾选。
  await card.getByRole('radio', { name: /直接抛核心数据/ }).click();
  await card.getByRole('checkbox', { name: /架构原理/ }).click();
  await card.getByRole('checkbox', { name: /性能对比/ }).click();
  await card.getByRole('checkbox', { name: /其他（自定义填写）/ }).click();
  await card.getByLabel('重点章节自定义回答').fill('补充一页结论对比');
  await expect(card).toContainText('已答 2/2 题');

  await card.getByRole('button', { name: /提交全部回答/ }).click();
  await expect(card).toHaveCount(0);

  // 编排在同一轮里收到全部答案并继续完成回复。
  const reply = page.locator('.message.assistant').last();
  await expect(reply).toContainText('已收到你的选择，同轮继续完成', { timeout: 10_000 });
  await expect(reply).toContainText('直接抛核心数据');
  await expect(reply).toContainText('架构原理');
  await expect(reply).toContainText('性能对比');
  await expect(reply).toContainText('补充一页结论对比');

  // 历史摘要卡就地回显，且刷新页面后依然完好无损。
  const summary = page.locator('.question-summary').last();
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('已确认 2 项');
  await page.reload();
  await expect(page.locator('.question-summary').last()).toContainText('已确认 2 项', { timeout: 10_000 });
  await page.locator('.question-summary').last().getByRole('button', { name: '查看原题' }).click();
  await expect(page.locator('.question-summary').last()).toContainText('前 15 秒希望用哪种开场钩子？');
});
