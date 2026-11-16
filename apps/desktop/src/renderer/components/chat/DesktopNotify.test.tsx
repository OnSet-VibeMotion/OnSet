// @vitest-environment jsdom
/*
 * 界面经 preload（window.onset）交给主进程的完成通知与 Dock 角标（app.tsx）：一轮对话结束、写任务跑完时通知，
 * 角标是正在跑的任务数。原来在 e2e/desktop.spec.mjs。
 * 只看界面这一侧发了什么；「窗口在前台时不弹」是主进程（main.ts 的 onset:notify）判断的，这里不覆盖。
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStudio, findEl, project, scenePageRoutes, turnDone, turnStart } from './studioHarness';
import type { Task } from '../../types';

function stubBridge() {
  const bridge = { desktop: true, platform: 'darwin', notify: vi.fn(), setBadge: vi.fn() };
  window.onset = bridge;
  return bridge;
}

const task = (status: Task['status'], message: string): Task => ({
  task_id: 'task-1', type: 'scene.validate', status, progress: status === 'running' ? 0.5 : 1, message,
  created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:01Z',
});

describe('desktop notifications', () => {
  afterEach(() => {
    delete window.onset;
  });

  test('notifies when a turn ends', async () => {
    const bridge = stubBridge();
    const studio = createStudio();
    studio.render();
    await screen.findByText('说说要做什么');
    const user = userEvent.setup();
    for (const turn of ['t1', 't2']) {
      await user.type(document.getElementById('prompt')!, '把镜头提示词改成 after');
      await user.click(document.getElementById('send')!);
      await studio.emit([...turnStart(turn, '把镜头提示词改成 after'), { kind: 'text', turn_id: turn, text: '改好了' }]);
      expect(bridge.notify).not.toHaveBeenCalled();
      await studio.emit(turnDone(turn, '已把镜头提示词改好').slice(1));
      expect(bridge.notify).toHaveBeenCalledTimes(1);
      expect(bridge.notify).toHaveBeenCalledWith('这一轮做完了', project.name);
      bridge.notify.mockClear();
    }
    expect(document.querySelectorAll('.done-line')).toHaveLength(2);
  });

  // 打开一个有历史的会话：重放的旧「一轮结束」不算刚做完，不能每轮弹一次通知（以前两轮历史弹两次）。
  test('does not notify for turns that ended before the session was opened', async () => {
    const bridge = stubBridge();
    const studio = createStudio();
    studio.seed([...turnStart('old1', '第一句'), ...turnDone('old1', '好了').slice(1), ...turnStart('old2', '第二句'), ...turnDone('old2', '也好了').slice(1)]);
    studio.render();
    await waitFor(() => expect(document.querySelectorAll('.done-line')).toHaveLength(2));
    expect(bridge.notify).not.toHaveBeenCalled();
  });

  test('shows running tasks on the Dock badge and notifies when they finish', async () => {
    const bridge = stubBridge();
    const studio = createStudio({
      routes: {
        ...scenePageRoutes,
        // 镜头页「⋯」里的「校验」：一个写任务，后台起任务后返回任务号。
        'POST /api/commands/scene.validate': () => {
          studio.setTasks([task('running', '正在校验镜头')]);
          return { task_id: 'task-1' };
        },
      },
    });
    studio.render();
    await screen.findByText('说说要做什么');
    await waitFor(() => expect(bridge.setBadge).toHaveBeenLastCalledWith(0));
    const user = userEvent.setup();
    await user.click(await findEl('[data-tab="scene"]'));
    await user.click(await findEl('.scene-menu summary'));
    const menu = await findEl('.scene-menu-body');
    await user.click(within(menu).getByRole('button', { name: '校验' }));
    expect(studio.api.calls.find((c) => c.path === '/api/commands/scene.validate')?.body).toEqual({ scene_id: 'scene-001' });
    await waitFor(() => expect(bridge.setBadge).toHaveBeenLastCalledWith(1));
    expect(bridge.notify).not.toHaveBeenCalled();
    // 任务在跑时每两秒查一次：查到跑完就通知、角标清零。
    studio.setTasks([task('succeeded', '镜头 scene-001 校验通过')]);
    await waitFor(() => expect(bridge.notify).toHaveBeenCalledWith('任务完成', '镜头 scene-001 校验通过'), { timeout: 4000 });
    expect(bridge.setBadge).toHaveBeenLastCalledWith(0);
    expect(studio.api.unmatched).toEqual([]);
  });
});
