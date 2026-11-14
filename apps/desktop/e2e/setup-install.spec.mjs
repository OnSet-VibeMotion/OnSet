import { test, expect } from './fixtures.mjs';

async function missingVoice(page, fail = false) {
  await page.addInitScript(({ fail }) => {
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
        if (fail) return Response.json({ message: '测试下载失败，请重试' }, { status: 500 });
        task = { running: true, started: new Date().toISOString(), items: { 'tts:minimax': { state: 'running', stage: '安装配音工具' } }, log: 'test.log' };
        return Response.json({ running: true }, { status: 202 });
      }
      return original(input, init);
    };
  }, { fail });
  await page.reload();
  await page.locator('#setup-pill').click();
  return page.locator('#setup-dialog');
}

test('the missing voice tool has a direct install channel and clears the missing badge after completion', async ({ page }) => {
  const dialog = await missingVoice(page);
  const voice = dialog.locator('.crew-card').filter({ hasText: 'MiniMax' });
  const install = voice.getByRole('button', { name: '安装配音工具' });
  await expect(install).toBeVisible();
  await install.click();
  await expect.poll(() => page.evaluate(() => window.setupInstallRequests)).toEqual([{ only: ['tts:minimax'], proxy: '' }]);
  await expect(voice.getByRole('button', { name: '正在准备…' })).toBeDisabled();
  await page.evaluate(() => window.finishSetupInstall());
  await expect(dialog).toContainText('摄制组已全部就位');
  await expect(page.locator('#setup-pill')).toHaveCount(0);
});

test('a failed direct install shows the reason and keeps the voice install channel available', async ({ page }) => {
  const dialog = await missingVoice(page, true);
  const install = dialog.getByRole('button', { name: '安装配音工具' });
  await install.click();
  await expect(dialog.locator('.setup-error')).toContainText('测试下载失败');
  await expect(install).toBeEnabled();
});
