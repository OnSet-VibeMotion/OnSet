import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, openProject, petPage, installPlugin } from './fixtures.mjs';

// 界面皮肤（studio/skins.ts、renderer/skin.ts）：设置页「外观」一点，主窗口与桌宠一起换；选择记在用户级的项目登记里。

const cssVar = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('a skin repaints the client and the pet, and is remembered for the user', async ({ page, project, sandbox, electronApp }) => {
  await openProject(page, project);
  const pet = await petPage(electronApp);
  expect(await cssVar(page, '--bg')).toBe('#0b0a09');

  await page.locator('#settings-trigger').click();
  const skins = page.locator('#settings-dialog .skins');
  await expect(skins.locator('.skin-card')).toHaveCount(3);
  await expect(skins.locator('.skin-card[data-skin="default"]')).toHaveAttribute('aria-checked', 'true');
  await skins.locator('.skin-card[data-skin="skins/daylight"]').click();
  await expect(skins.locator('.skin-card[data-skin="skins/daylight"]')).toHaveAttribute('aria-checked', 'true');

  await expect.poll(() => cssVar(page, '--bg')).toBe('#f4f1ea');
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'light');
  // 桌宠经主进程收到「换了」，自己再取一次。
  await expect(pet.locator('html')).toHaveAttribute('data-skin', 'skins/daylight');
  await expect.poll(() => cssVar(pet, '--accent')).toBe('#9a5b1c');
  await expect.poll(() => JSON.parse(fs.readFileSync(sandbox.registry, 'utf8')).skin).toBe('skins/daylight');

  // 换回放映室：内联的变量全部清掉，回到 styles.css 的默认值。
  await skins.locator('.skin-card[data-skin="default"]').click();
  await expect.poll(() => cssVar(page, '--bg')).toBe('#0b0a09');
  await expect(pet.locator('html')).toHaveAttribute('data-skin', 'default');

  // 插件皮肤用自己的页面换掉桌宠：页面经 /station-ui 在沙箱里真的加载，拿到状态与皮肤颜色，发回的动作经主进程交给主窗口。
  // 宿主一侧的桥（状态怎么发、哪些动作照转）与「换了桌宠」的卡片在 Skins.test.tsx。
  const dir = path.join(sandbox.home, 'cat-skins');
  fs.mkdirSync(path.join(dir, 'skins'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'onset-station.json'),
    JSON.stringify({ id: 'cat-skins', version: '1', name: '猫咪皮肤', skins: ['skins/cat.json'], pages: [{ id: 'cat', label: '猫咪小窝', entry: 'ui/cat.html' }] }),
  );
  fs.writeFileSync(path.join(dir, 'skins', 'cat.json'), JSON.stringify({ id: 'cat', name: '猫咪', tokens: { accent: '#e07a5f' }, pet: { page: 'cat' } }));
  // 页面收到状态就写出来；第一次收到时请客户端打开制作路线。
  fs.writeFileSync(path.join(dir, 'ui', 'cat.html'), `<!doctype html><meta charset="utf-8"><body><p id="mood">…</p><script src="cat.js"></script></body>`);
  fs.writeFileSync(
    path.join(dir, 'ui', 'cat.js'),
    `let asked = false;
window.addEventListener('message', (e) => {
  if (!e.data || e.data.onset !== 'pet') return;
  document.getElementById('mood').textContent = e.data.signal.mood + ' ' + e.data.skin.tokens.accent;
  if (!asked) { asked = true; parent.postMessage({ onset: 'pet-command', command: { kind: 'open', page: 'progress' } }, '*'); }
});`,
  );
  installPlugin(sandbox, dir, 'cat-skins');
  // 关掉再打开设置：重读皮肤列表。
  await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await page.locator('#settings-trigger').click();
  await page.locator('#settings-dialog .skin-card[data-skin="cat-skins/cat"]').click();
  await expect(pet.locator('.pet-frame')).toBeAttached();
  await expect(pet.locator('.pet-room')).toHaveCount(0);
  await expect(pet.frameLocator('.pet-frame').locator('#mood')).toHaveText('idle #e07a5f');
  // 页面请客户端打开制作路线：主窗口切过去。
  await page.keyboard.press('Escape');
  await expect(page.locator('#progress-page')).toBeVisible();
  // 拿去当桌宠的页面不进插件菜单。
  await expect(page.getByText('猫咪小窝')).toHaveCount(0);

  // 沙箱里的页面拿不到窗口的拖动区域：宿主插进去的脚本在空白处按住挪动时报「开始」「结束」，宿主转给主进程挪窗口。
  await pet.evaluate(() => {
    window.__drags = [];
    window.addEventListener('message', (e) => {
      if (e.data && e.data.onset === 'pet-drag') window.__drags.push(e.data.phase);
    });
  });
  const box = await pet.locator('.pet-frame').boundingBox();
  await pet.mouse.move(box.x + 200, box.y + 200);
  await pet.mouse.down();
  await pet.mouse.move(box.x + 230, box.y + 220, { steps: 4 });
  await pet.mouse.up();
  await expect.poll(() => pet.evaluate(() => window.__drags)).toEqual(['start', 'end']);
  // 按下就松开（没挪）不算拖。
  await pet.mouse.down();
  await pet.mouse.up();
  expect(await pet.evaluate(() => window.__drags)).toEqual(['start', 'end']);
});

// 上次选了浅色皮肤：重开客户端时窗口底色与第一帧就是它（主进程同步给界面，画完才显示窗口），不先闪一下黑底。
const remembered = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-skin-registry-')), 'projects.json');
fs.writeFileSync(remembered, JSON.stringify({ schema: 1, projects: null, skin: 'skins/daylight' }) + '\n');
test.describe('with a remembered skin', () => {
  test.use({ appEnv: { ONSET_STUDIO_CONFIG: remembered } });
  test('starts in the remembered skin from the first frame', async ({ page, electronApp }) => {
    // 不经接口：skinNow 在 React 画第一帧之前就写上了。
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'skins/daylight');
    expect(await cssVar(page, '--bg')).toBe('#f4f1ea');
    const bg = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isResizable())?.getBackgroundColor());
    expect(bg?.toLowerCase()).toBe('#f4f1ea');
  });
});
