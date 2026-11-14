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
  // 没打开项目时主进程不显示桌宠（main/pet.ts 的 syncVisibility），工作室也知道还没有项目。
  await expect(crew).toHaveAttribute('data-project', 'none');

  await openProject(page, project);
  await expect(crew).toHaveAttribute('data-project', 'open');
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

  // 导演（内置编排工具）调 am 的操作不带前缀：照样认得是在拍，气泡也写成人话。
  await page.locator('#prompt').fill('导演开机');
  await page.locator('#send').click();
  await expect(crew).toHaveAttribute('data-mood', 'filming');
  await expect(crew.locator('.pet-line')).toHaveText('渲染镜头 scene-001');
  await page.locator('#cancel-turn').click();

  // 改分镜计划：导演走到左墙的分镜板前。
  await page.locator('#prompt').fill('排分镜');
  await page.locator('#send').click();
  await expect(crew).toHaveAttribute('data-mood', 'storyboarding');
  await expect(crew.locator('.pet-line')).toHaveText('编辑 scene-plan.json');
  await page.locator('#cancel-turn').click();

  // 拼接：交给剪辑师，导演站到他身后。
  await page.locator('#prompt').fill('拼一下');
  await page.locator('#send').click();
  await expect(crew).toHaveAttribute('data-mood', 'editing');
  await expect(pet.locator('[data-who="editor"]')).toHaveAttribute('data-active', 'true');
  await expect(pet.locator('[data-tag="editor"]')).toHaveText('剪辑');
  await page.locator('#cancel-turn').click();
  await expect(pet.locator('[data-who="editor"]')).toHaveAttribute('data-active', 'false');

  // 正常做完：收工，过一会儿回到待命。
  await page.locator('#prompt').fill('把镜头提示词改成 after');
  await page.locator('#send').click();
  await expect(crew).toHaveAttribute('data-mood', 'done');
  await expect(crew).toHaveAttribute('data-mood', 'idle', { timeout: 10_000 });
});

test('a camera operator goes to work for each scene that is rendering', async ({ page, project, electronApp }) => {
  // 进行中标记指向一个活着的进程（测试进程自己）：scene-001 在渲染。
  const sceneDir = path.join(project.path, 'scenes', 'scene-001');
  fs.writeFileSync(path.join(sceneDir, 'render-scene-001.stream.jsonl'), '');
  fs.writeFileSync(
    path.join(sceneDir, 'render-scene-001.live.json'),
    JSON.stringify({ pid: process.pid, renderer: 'claude', started_at: new Date().toISOString() }),
  );
  const pet = await petPage(electronApp);
  await openProject(page, project);
  // 没有对话在跑，导演仍在待命；摄影从沙发走到机位，脚下挂着镜头号。
  await expect(pet.locator('#crew')).toHaveAttribute('data-mood', 'idle');
  await expect(pet.locator('[data-who="op1"]')).toHaveAttribute('data-active', 'true');
  await expect(pet.locator('[data-who="op2"]')).toHaveAttribute('data-active', 'false');
  await expect(pet.locator('[data-tag="op1"]')).toHaveText('001');
  await expect(pet.locator('.pet-legend')).toHaveText('1 个镜头在拍');

  // 渲染结束：回沙发。（只删标记不行：没有标记时按渲染日志三分钟内有没有写入判断，日志也一并拿掉。）
  fs.rmSync(path.join(sceneDir, 'render-scene-001.live.json'));
  fs.rmSync(path.join(sceneDir, 'render-scene-001.stream.jsonl'));
  await expect(pet.locator('[data-who="op1"]')).toHaveAttribute('data-active', 'false', { timeout: 15_000 });
});

test('the pet can be put away and remembers it', async ({ electronApp, sandbox }) => {
  const pet = await petPage(electronApp);
  await pet.locator('#crew .pet-close').click({ force: true });
  const prefs = path.join(sandbox.userData, 'pet.json');
  await expect.poll(() => fs.existsSync(prefs) && JSON.parse(fs.readFileSync(prefs, 'utf8')).visible).toBe(false);
});
