// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { mockApi, reply } from '../testing';
import type { PrereqStatus, SetupStatus, SetupTask } from '../types';
import { SetupGuide, useSetup } from './SetupGuide';

// 顶栏「前置资源」弹窗里的安装页：与 app.tsx 一样用 useSetup 读状态、交给 SetupGuide。
// 缺项计数照 app.tsx 顶栏药丸的算法（还有没就绪的项才显示药丸）。
function Dialog() {
  const setup = useSetup();
  if (!setup.status) return null;
  const missing = setup.status.items.filter((item) => !item.ready).length;
  return (
    <section id="setup-dialog">
      <output aria-label="缺几项">{missing}</output>
      <SetupGuide setup={setup} compact />
    </section>
  );
}

test('the missing voice tool has a direct install channel that survives a failure and clears the missing badge after completion', async () => {
  const items: PrereqStatus[] = [
    ['skills', 'skills'], ['cli', 'cli'], ['browser', 'browser'], ['ffmpeg', 'ffmpeg'], ['tts:minimax', 'tts'], ['align:funasr', 'align'],
  ].map(([id, group]) => ({ id, group, name: id === 'tts:minimax' ? '配音 MiniMax' : id, ready: id !== 'tts:minimax', required: !['tts', 'align'].includes(group), location: '' }));
  let task: SetupTask | undefined;
  let attempts = 0;
  const backend = mockApi({
    '/api/setup': (): SetupStatus => ({ ready: true, items, task, command: '' }),
    'POST /api/setup/run': () => {
      // 第一次下载失败：照实说原因，入口还在；再点一次装上。
      if (++attempts === 1) return reply(500, { message: '测试下载失败，请重试' });
      task = { running: true, started: new Date().toISOString(), items: { 'tts:minimax': { state: 'running', stage: '安装配音工具' } }, log: 'test.log' };
      return reply(202, { running: true });
    },
  });
  const user = userEvent.setup();
  render(<Dialog />);

  await waitFor(() => expect(document.querySelector('#setup-dialog .crew-card')).not.toBeNull());
  const dialog = document.querySelector<HTMLElement>('#setup-dialog')!;
  const voice = [...dialog.querySelectorAll<HTMLElement>('.crew-card')].find((card) => card.textContent?.includes('MiniMax'))!;
  expect(voice).toBeTruthy();
  expect(screen.getByLabelText('缺几项').textContent).toBe('1');
  const install = within(voice).getByRole('button', { name: '安装配音工具' });
  await user.click(install);
  await waitFor(() => expect(dialog.querySelector('.setup-error')?.textContent).toContain('测试下载失败'));
  expect((install as HTMLButtonElement).disabled).toBe(false);
  await user.click(install);
  // 两次都只装这一项，代理没填。
  expect(backend.calls.filter((c) => c.method === 'POST' && c.path === '/api/setup/run').map((c) => c.body)).toEqual([
    { only: ['tts:minimax'], proxy: '' },
    { only: ['tts:minimax'], proxy: '' },
  ]);
  await waitFor(() => expect((within(voice).getByRole('button', { name: '正在准备…' }) as HTMLButtonElement).disabled).toBe(true));

  // 装完：后端报这一项就绪，安装中每秒一次的轮询把它接上，缺项清零。
  items.find((item) => item.id === 'tts:minimax')!.ready = true;
  task = { ...task!, running: false, items: { 'tts:minimax': { state: 'done', stage: '' } } };
  await waitFor(() => expect(dialog.textContent).toContain('摄制组已全部就位'), { timeout: 3000 });
  expect(screen.getByLabelText('缺几项').textContent).toBe('0');
  expect(backend.unmatched).toEqual([]);
});
