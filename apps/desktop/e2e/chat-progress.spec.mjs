import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

test('automatic compaction reaches the persistent status and survives a page reload', async ({ page, project }, testInfo) => {
  await openProject(page, project);
  await page.locator('#prompt').fill('压缩状态回归');
  await page.locator('#send').click();
  const progress = page.getByRole('region', { name: '当前 AI 进度' });
  await expect(progress).toContainText('正在压缩上下文');
  await expect(progress).toContainText('正在整理历史对话');
  await page.reload();
  await expect(progress).toContainText('正在压缩上下文');
  await page.clock.install();
  await page.clock.setSystemTime(Date.now() + 90000);
  await expect(progress).toContainText('无新消息');
  await expect(progress).toContainText('正在压缩上下文');
  await expect(progress).not.toContainText('等待模型回复');
  await page.screenshot({ path: testInfo.outputPath('compacting-progress.png') });
  await fs.writeFile(path.join(project.path, 'production/studio/compact-done'), '');
  await expect(progress).toContainText('上下文压缩完成，等待模型回复');
  await expect(progress).toContainText('150,000 → 20,000');
  await fs.writeFile(path.join(project.path, 'production/studio/compact-resume'), '');
  await expect(progress).toContainText('正在执行操作');
  await expect(progress).not.toContainText('正在压缩上下文');
  // 停下这一轮：常驻的进度条随之消失。
  await page.locator('#cancel-turn').click();
  await expect(progress).toHaveCount(0);
});

test('current progress stays above the composer while waiting, survives reload and clears on completion', async ({ page, project, electronApp }, testInfo) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('/sessions/')) window.progressSource = this;
      }
    };
  });
  await openProject(page, project);
  await page.locator('#prompt').fill('进度状态回归');
  await page.locator('#send').click();
  const progress = page.getByRole('region', { name: '当前 AI 进度' });
  await expect(progress).toContainText('正在执行操作');
  await expect(progress).toContainText('scenes/scene-010/prompt.md');
  await fs.writeFile(path.join(project.path, 'production/studio/progress-read-done'), '');
  await expect(progress).toContainText('等待模型回复');
  await expect(progress).toContainText('已完成 2 项操作');
  await expect(progress).toContainText('最近完成：读取');
  await expect(progress).toBeInViewport();
  await page.locator('.shell > summary').click();
  await expect(progress).toBeInViewport();
  await page.reload();
  await expect(progress).toContainText('等待模型回复');
  await page.clock.install();
  await page.clock.setSystemTime(Date.now() + 90000);
  await expect(progress).toContainText('无新消息');
  // 这一轮已经执行过操作：安静是正常的，不劝用户停止。
  await expect(progress).not.toContainText('点击输入框右下角停止');
  await page.screenshot({ path: testInfo.outputPath('waiting-progress.png') });
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isResizable()).setSize(1000, 700));
  await page.locator('#messages').evaluate(element => { element.scrollTop = 0; });
  await expect(progress).toBeInViewport();
  expect(await progress.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('waiting-progress-narrow.png') });
  // 原生 EventSource 的断线 / 重连通知不能被展示成模型正在思考。
  await page.evaluate(() => window.progressSource.dispatchEvent(new Event('error')));
  await expect(progress).toContainText('进度连接中断，正在重连');
  await page.evaluate(() => window.progressSource.dispatchEvent(new Event('open')));
  await expect(progress).toContainText('等待模型回复');
  await fs.writeFile(path.join(project.path, 'production/studio/progress-finish'), '');
  await expect(progress).toHaveCount(0);
  await expect(page.locator('.done-line')).toBeVisible();
});
