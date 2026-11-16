import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, petPage } from './fixtures.mjs';

// 桌宠（main/pet.ts、Pet.tsx）：主窗口从会话事件推出小人在做什么，经主进程转给桌宠窗口；
// 后台运行（测试）时桌宠窗口照样建、照样收状态，只是不显示。

// 桌宠不只是看：批准、选项、说一句、停下与「点人打开那一页」都能在桌宠上做，动作经主进程交回主窗口。
// 后台运行时桌宠不显示，按钮用 force 点。

// 小人在哪个部门、气泡怎么说在 chat/crew.test.mjs；这里只走一遍主窗口 → 主进程 → 桌宠窗口的转发。
test('approvals, choices and a quick message can be sent from the pet, which mirrors the orchestrator', async ({ page, project, electronApp, sandbox }) => {
  // 进行中标记指向一个活着的进程（测试进程自己）：scene-001 在渲染（镜头列表 → 主窗口 → 桌宠这一路）。
  const sceneDir = path.join(project.path, 'scenes', 'scene-001');
  fs.writeFileSync(path.join(sceneDir, 'render-scene-001.stream.jsonl'), '');
  fs.writeFileSync(
    path.join(sceneDir, 'render-scene-001.live.json'),
    JSON.stringify({ pid: process.pid, renderer: 'claude', started_at: new Date().toISOString() }),
  );
  const pet = await petPage(electronApp);
  const crew = pet.locator('#crew');
  // 没有进行中的一轮：坐在制作人椅上待命；没打开项目时工作室也知道还没有项目（主进程据此不显示桌宠）。
  await expect(crew).toHaveAttribute('data-mood', 'idle');
  await expect(crew.locator('.pet-line')).toHaveText('待命');
  await expect(crew).toHaveAttribute('data-project', 'none');
  await openProject(page, project);
  await expect(crew).toHaveAttribute('data-project', 'open');
  // 摄影从沙发走到机位，脚下挂着镜头号（每个镜头一位、面板与菜单在 Pet.test.tsx）。
  await expect(pet.locator('[data-who="op1"]')).toHaveAttribute('data-active', 'true');
  await expect(pet.locator('[data-tag="op1"]')).toHaveText('001');
  // 渲染结束：一轮也没在跑时镜头列表照样刷新，摄影回沙发。（只删标记不行：没有标记时按渲染日志三分钟内有没有写入判断，日志也一并拿掉。）
  fs.rmSync(path.join(sceneDir, 'render-scene-001.live.json'));
  fs.rmSync(path.join(sceneDir, 'render-scene-001.stream.jsonl'));
  await expect(pet.locator('[data-who="op1"]')).toHaveAttribute('data-active', 'false', { timeout: 15_000 });

  // 读文件的调用还没有结果：走到书架前读，气泡写文件名，卡片底下写项目名；停下后是「停下」。
  await page.locator('#prompt').fill('看看稿子');
  await page.locator('#send').click();
  await expect(crew).toHaveAttribute('data-mood', 'reading');
  await expect(crew.locator('.pet-line')).toHaveText('读取 script-final.md');
  await expect(crew.locator('.pet-project')).toHaveText(project.name);
  await page.locator('#cancel-turn').click();
  await expect(page.locator('#cancel-turn')).toHaveCount(0);
  await expect(crew).toHaveAttribute('data-mood', 'stopped');

  // 批准：桌宠上点「允许」，主窗口的审批卡片随之答掉。
  await page.locator('#prompt').fill('要批准：装一下 three');
  await page.locator('#prompt').press('Enter');
  const desk = pet.locator('.pet-desk[data-desk="ask"]');
  await expect(desk.locator('.pet-desk-cmd')).toHaveText('npm install three');
  await desk.locator('button', { hasText: '允许' }).first().click({ force: true });
  await expect(page.locator('.permission-card')).toHaveCount(0);
  await expect(page.locator('.message.assistant').last()).toContainText('behavior:allow');
  await expect(desk).toHaveCount(0);
  // 「允许」只放行这一次，不记前缀。
  expect(fs.existsSync(path.join(project.path, 'production', 'studio', 'permissions.json'))).toBe(false);

  await page.locator('#prompt').fill('给我选项');
  await page.locator('#send').click();
  const choices = pet.locator('.pet-desk[data-desk="choices"]');
  await expect(choices.locator('.pet-desk-q')).toHaveText('选一个风格：');
  await choices.locator('button', { hasText: '白板手绘风' }).click({ force: true });
  await expect(page.locator('.message.user').last()).toContainText('白板手绘风');
  await expect(page.locator('.choice-picked')).toContainText('白板手绘风');

  // 说一句：打开输入框，回车发出；这一轮还在跑时给「停下」。
  await expect(pet.locator('.pet-act[data-act="stop"]')).toHaveCount(0);
  await pet.locator('.pet-act[data-act="say"]').click({ force: true });
  await pet.locator('.pet-input').fill('慢慢来');
  await pet.locator('.pet-input').press('Enter');
  await expect(page.locator('.message.user').last()).toContainText('慢慢来');
  await expect(pet.locator('.pet-desk[data-desk="sent"]')).toBeVisible();
  await pet.locator('.pet-act[data-act="stop"]').click({ force: true });
  await expect(pet.locator('#crew')).toHaveAttribute('data-mood', 'stopped');
  await expect(pet.locator('.pet-act[data-act="stop"]')).toHaveCount(0);

  // 点物件切页：主进程把主窗口叫到前面再交给界面切过去。
  await pet.locator('.pet-spot[data-spot="storyboard"]').click({ force: true });
  await expect(page.locator('[data-tab="storyboard"]')).toHaveAttribute('aria-current', 'page');

  // 窗口缺省 640×500；拖把手的那一套在主进程里跟着鼠标改，这里只看结束时记下大小。
  const size = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isResizable())?.getSize());
  expect(size).toEqual([640, 500]);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isResizable())?.setSize(700, 520));
  await pet.evaluate(() => {
    window.onset.pet({ kind: 'resize', phase: 'start' });
    window.onset.pet({ kind: 'resize', phase: 'end' });
  });
  const prefs = path.join(sandbox.userData, 'pet.json');
  const saved = () => (fs.existsSync(prefs) ? JSON.parse(fs.readFileSync(prefs, 'utf8')) : {});
  await expect.poll(saved).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });

  // 卡片上的 × 收起桌宠，并记住。
  await pet.locator('#crew .pet-close').click({ force: true });
  await expect.poll(() => saved().visible).toBe(false);
});
