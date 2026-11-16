import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, openProject, api, desktopDir, installPlugin } from './fixtures.mjs';

const fake = path.resolve(desktopDir, '..', '..', 'packages', 'engine', 'src', 'flow', 'testdata', 'fake-publisher');

// 成片页的播放器地址只随成片文件自己变：项目里别的东西变了、项目刷新了，正在看的成片不能重新加载。
test('the final film does not reload when only other project files change', async ({ page, project, sandbox }) => {
  const film = path.join(project.path, 'final.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=1', '-pix_fmt', 'yuv420p', film]);
  installPlugin(sandbox, fake);
  await openProject(page, project);
  await page.locator('[data-tab="final"]').click();
  const video = page.locator('#panel .final-tab video');
  await expect(video).toHaveCount(1);
  const before = await video.getAttribute('src');

  // 在设置里点一个会写别的文件的插件操作：客户端等任务跑完后整个刷新项目（以前每次刷新都让成片重新加载）。
  const refreshed = async () => {
    await page.locator('#settings-trigger').click();
    await page.locator('#settings-dialog').getByText('功能与插件').first().click();
    await page.locator('#settings-dialog li[data-station="fake-publisher"]').getByRole('button', { name: '详情与设置' }).click();
    const detail = page.getByRole('dialog', { name: '假发布 详情与设置' });
    await expect(detail.locator('.plugin-list[data-op="accounts"]')).toContainText('还没有。');
    const done = (await api(page, '/api/tasks')).body.tasks.filter((t) => t.status === 'succeeded').length;
    await detail.locator('.station-op[data-op="scribble"]').getByRole('button', { name: '顺手记一笔' }).click();
    // 等全部任务跑完（打开弹窗时自动刷新的账号列表也算一个），且成功的比点之前多。
    await expect.poll(async () => {
      const tasks = (await api(page, '/api/tasks')).body.tasks;
      return !tasks.some((t) => t.status === 'running' || t.status === 'queued') && tasks.filter((t) => t.status === 'succeeded').length > done;
    }, { timeout: 15000 }).toBe(true);
    await detail.getByRole('button', { name: '关闭' }).click();
    await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();
    // 任务结束后的那次刷新要先落下来：客户端每两秒查一次任务，看到结束就刷新项目。
    await page.waitForTimeout(4000);
  };
  await refreshed();
  expect(fs.existsSync(path.join(project.path, 'notes', 'scribble.txt'))).toBe(true);
  expect(await video.getAttribute('src')).toBe(before);

  // 成片真的换了：地址跟着变。
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(film, later, later);
  await refreshed();
  await expect.poll(() => video.getAttribute('src')).not.toBe(before);
});
