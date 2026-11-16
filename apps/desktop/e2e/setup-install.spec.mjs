import { test, expect } from './fixtures.mjs';

async function missingVoice(page, failures = 0) {
  await page.addInitScript(({ failures }) => {
    const original = window.fetch.bind(window);
    const items = [
      ['skills', 'skills'], ['cli', 'cli'], ['browser', 'browser'], ['ffmpeg', 'ffmpeg'], ['tts:minimax', 'tts'], ['align:funasr', 'align'],
    ].map(([id, group]) => ({ id, group, name: id === 'tts:minimax' ? '配音 MiniMax' : id, ready: id !== 'tts:minimax', required: !['tts', 'align'].includes(group), location: '' }));
    let task;
    window.setupInstallRequests = [];
    window.finishSetupInstall = () => {
      items.find(item => item.id === 'tts:minimax').ready = true;
      task = { ...task, running: false, items: { 'tts:minimax': { state: 'done', stage: '' } } };
    };
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/setup') return Response.json({ ready: true, items, task, command: '' });
      if (url.pathname === '/api/setup/run') {
        window.setupInstallRequests.push(JSON.parse(init.body));
        if (window.setupInstallRequests.length <= failures) return Response.json({ message: '测试下载失败，请重试' }, { status: 500 });
        task = { running: true, started: new Date().toISOString(), items: { 'tts:minimax': { state: 'running', stage: '安装配音工具' } }, log: 'test.log' };
        return Response.json({ running: true }, { status: 202 });
      }
      return original(input, init);
    };
  }, { failures });
  await page.reload();
  await page.locator('#setup-pill').click();
  return page.locator('#setup-dialog');
}

test('the missing voice tool has a direct install channel that survives a failure and clears the missing badge after completion', async ({ page }) => {
  // 第一次下载失败：照实说原因，入口还在；再点一次装上。
  const dialog = await missingVoice(page, 1);
  const voice = dialog.locator('.crew-card').filter({ hasText: 'MiniMax' });
  const install = voice.getByRole('button', { name: '安装配音工具' });
  await expect(install).toBeVisible();
  await install.click();
  await expect(dialog.locator('.setup-error')).toContainText('测试下载失败');
  await expect(install).toBeEnabled();
  await install.click();
  await expect.poll(() => page.evaluate(() => window.setupInstallRequests)).toEqual([{ only: ['tts:minimax'], proxy: '' }, { only: ['tts:minimax'], proxy: '' }]);
  await expect(voice.getByRole('button', { name: '正在准备…' })).toBeDisabled();
  await page.evaluate(() => window.finishSetupInstall());
  await expect(dialog).toContainText('摄制组已全部就位');
  await expect(page.locator('#setup-pill')).toHaveCount(0);
});
