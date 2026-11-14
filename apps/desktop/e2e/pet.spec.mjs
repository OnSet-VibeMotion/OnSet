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

  // 调 onset 渲染镜头：走到摄影机旁。假编排工具不真的起渲染，没有镜头在渲染时气泡写工具在做什么。
  await page.locator('#prompt').fill('拍一下');
  await page.locator('#send').click();
  await expect(crew).toHaveAttribute('data-mood', 'filming');
  await expect(crew.locator('.pet-line')).toHaveText('渲染镜头 scene-001');
  await page.locator('#cancel-turn').click();

  // 导演（内置编排工具）调 onset 的操作不带前缀：照样认得是在拍，气泡也写成人话。
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

// 桌宠不只是看：批准、选项、说一句、停下与「点人打开那一页」都能在桌宠上做，动作经主进程交回主窗口。
// 后台运行时桌宠不显示，按钮用 force 点（与收起桌宠同理）。

test('approvals can be answered from the pet', async ({ page, project, electronApp }) => {
  const pet = await petPage(electronApp);
  await openProject(page, project);
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
});

test('choices and a quick message can be sent from the pet', async ({ page, project, electronApp }) => {
  const pet = await petPage(electronApp);
  await openProject(page, project);
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
});

test('clicking someone selects them, shows their state and queue, and offers a ring of real actions', async ({ page, project, electronApp }) => {
  const pet = await petPage(electronApp);
  await openProject(page, project);
  // 一轮带待办清单：导演的动作队列就是它。
  await page.locator('#prompt').fill('给我选项');
  await page.locator('#send').click();
  await expect(page.locator('.choice').first()).toBeVisible();

  await pet.locator('.pet-spot[data-spot="director"]').click({ force: true });
  await expect(pet.locator('.pet-spot[data-spot="director"]')).toHaveAttribute('data-selected', 'true');
  const panel = pet.locator('.pet-panel[data-who="director"]');
  await expect(panel.locator('strong')).toHaveText('导演');
  await expect(panel.locator('.pet-queue li')).toHaveText(['读稿子', '正在定风格']);
  await expect(panel.locator('.pet-queue li').first()).toHaveAttribute('data-state', 'completed');
  await expect(panel.locator('.pet-needs')).toContainText('进度');
  await expect(panel.locator('.pet-needs')).toContainText('1 / 2');
  // 刚做完一轮：心情是满意或舒心（收工后回到待命）。
  await expect(panel.locator('.pet-mood')).toHaveText(/满意|舒心/);

  // 环形菜单：点「看制作路线」，主窗口切过去，菜单收起，选中留着。
  const pie = pet.locator('.pet-pie[data-who="director"]');
  await expect(pie.locator('.pet-pie-item')).toContainText(['看制作路线', '对他说一句', '回到对话']);
  await pie.getByRole('menuitem', { name: '看制作路线' }).click({ force: true });
  await expect(page.locator('#progress-open')).toHaveAttribute('aria-current', 'page');
  await expect(pie).toHaveCount(0);
  await expect(panel).toBeVisible();

  // 换选摄影：闲着的摄影只给「看镜头」，面板写他在做什么闲事。
  await pet.locator('.pet-spot[data-spot="op1"]').click({ force: true });
  await expect(pet.locator('.pet-panel[data-who="op1"] strong')).toHaveText('摄影 1');
  await expect(pet.locator('.pet-pie[data-who="op1"] .pet-pie-item')).toHaveText(['看镜头']);
  await pet.locator('.pet-pie-item', { hasText: '看镜头' }).click({ force: true });
  await expect(page.locator('[data-tab="scene"]')).toHaveAttribute('aria-current', 'page');

  // 物件不弹菜单：分镜板直接打开分镜。
  await pet.locator('.pet-spot[data-spot="storyboard"]').click({ force: true });
  await expect(page.locator('[data-tab="storyboard"]')).toHaveAttribute('aria-current', 'page');

  // 取消选中。
  await pet.locator('.pet-panel-close').click({ force: true });
  await expect(pet.locator('.pet-panel')).toHaveCount(0);
});

test('the camera zooms and pans the studio, and the light follows the clock', async ({ electronApp, page, project }) => {
  const pet = await petPage(electronApp);
  await openProject(page, project);
  const stage = pet.locator('.pet-stage');
  const scaleOf = async () => Number((await stage.evaluate((el) => getComputedStyle(el).transform)).match(/matrix\(([^,]+)/)?.[1] ?? '1');
  const before = await scaleOf();
  await pet.locator('.pet-cam button[aria-label="放大"]').click({ force: true });
  await expect.poll(scaleOf).toBeGreaterThan(before * 1.2);
  await pet.locator('.pet-cam button[data-cam="reset"]').click({ force: true });
  await expect.poll(scaleOf).toBeCloseTo(before, 3);
  // 昼夜：按这台电脑的时间给出一个时段。
  await expect(pet.locator('#crew')).toHaveAttribute('data-daypart', /^(night|dawn|day|dusk|evening)$/);
  await expect(pet.locator('.pet-clock')).toHaveText(/^(夜|清晨|白天|傍晚|晚上) \d\d:\d\d$/);
});

test('the pet window is bigger by default and its size is remembered', async ({ electronApp, sandbox }) => {
  const pet = await petPage(electronApp);
  const size = await electronApp.evaluate(({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find((w) => !w.isResizable());
    return pet?.getSize();
  });
  expect(size).toEqual([640, 500]);
  // 拖把手的那一套在主进程里跟着鼠标改；这里只看结束时记下大小。
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isResizable())?.setSize(700, 520));
  await pet.evaluate(() => {
    window.onset.pet({ kind: 'resize', phase: 'start' });
    window.onset.pet({ kind: 'resize', phase: 'end' });
  });
  const prefs = path.join(sandbox.userData, 'pet.json');
  await expect.poll(() => (fs.existsSync(prefs) ? JSON.parse(fs.readFileSync(prefs, 'utf8')) : {})).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
});
