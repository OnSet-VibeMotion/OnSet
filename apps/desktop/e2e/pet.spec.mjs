import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, petPage } from './fixtures.mjs';

// 桌宠（main/pet.ts、Pet.tsx）：主窗口从会话事件推出小人在做什么，经主进程转给桌宠窗口；
// 后台运行（测试）时桌宠窗口照样建、照样收状态，只是不显示。

test('the desktop pet mirrors what the orchestrator is doing', async ({ page, project, electronApp }) => {
  const pet = await petPage(electronApp);
  const crew = pet.locator('#crew');
  // 没有进行中的一轮：坐在导演椅上待命。
  await expect(crew).toHaveAttribute('data-mood', 'idle');
  await expect(crew.locator('.pet-line')).toHaveText('待命');

  await openProject(page, project);
  // 读文件的调用还没有结果：走到书架前读，气泡只写文件名，卡片底下写项目名。
  await page.locator('#prompt').fill('看看稿子');
  await page.locator('#send').click();
  await expect(crew).toHaveAttribute('data-mood', 'reading');
  await expect(crew.locator('.pet-line')).toHaveText('读取 script-final.md');
  await expect(crew.locator('.pet-project')).toHaveText(project.name);
  await expect(crew).toHaveAttribute('data-walking', 'false');
  await page.locator('#cancel-turn').click();
  await expect(crew).toHaveAttribute('data-mood', 'stopped');

  // 调 am 渲染镜头：走到摄影机旁。假编排工具不真的起渲染，没有镜头在渲染时气泡写工具在做什么。
  await page.locator('#prompt').fill('拍一下');
  await page.locator('#send').click();
  await expect(crew).toHaveAttribute('data-mood', 'filming');
  await expect(crew.locator('.pet-line')).toHaveText('渲染镜头 scene-001');
  await page.locator('#cancel-turn').click();

  // 正常做完：收工，过一会儿回到待命。
  await page.locator('#prompt').fill('把镜头提示词改成 after');
  await page.locator('#send').click();
  await expect(crew).toHaveAttribute('data-mood', 'done');
  await expect(crew).toHaveAttribute('data-mood', 'idle', { timeout: 10_000 });
});

test('the pet can be put away and remembers it', async ({ electronApp, sandbox }) => {
  const pet = await petPage(electronApp);
  await pet.locator('#crew .pet-close').click({ force: true });
  const prefs = path.join(sandbox.userData, 'pet.json');
  await expect.poll(() => fs.existsSync(prefs) && JSON.parse(fs.readFileSync(prefs, 'utf8')).visible).toBe(false);
});
