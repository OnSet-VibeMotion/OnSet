// @vitest-environment jsdom
/*
 * 输入框上方「要你批准」的卡片（Chat.tsx 的 PermissionStack）：「以后都不用问」打开全局的自动批准、放行眼前这条，
 * 之后的请求由后端直接放行，对话里只留一行「已自动允许」；设置页照实显示。原来在 e2e/permissions.spec.mjs。
 * 审批服务、收件目录与 AUTO_APPROVE 写进全局设置文件都在后端（studio/permissions.ts、settings.ts 有各自的测试），
 * 这里看界面发了什么、怎么显示。
 */
import { describe, expect, test } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStudio, turnDone, turnStart } from './studioHarness';
import type { PermissionAsk, SettingsResponse } from '../../types';

// 假 claude 经审批服务请求的那一条（fake-permission.mjs）。
const install: PermissionAsk = { id: 'req-1', tool_name: 'Bash', command: 'npm install three', description: '安装 three.js', suggestion: 'npm install', input: { command: 'npm install three', description: '安装 three.js' } };

/** /api/settings 里自动批准那一项（studio/settings.ts 的说法），global 跟着界面的写入变。 */
function settings(global: string): SettingsResponse {
  return {
    file: '/Users/me/.local/share/onset/settings.conf',
    has_project: true,
    machine: [],
    rows: [
      {
        key: 'AUTO_APPROVE',
        label: '执行操作前问我',
        hint: 'AI 有时要在你的电脑上执行不常见的操作。',
        options: [{ value: 'off', label: '每次都问我' }, { value: 'on', label: '不用问，直接做' }],
        default: 'off',
        global,
        project: '',
        effective: global || 'off',
        source: global ? 'global' : 'default',
      },
    ],
  };
}

const cards = () => document.querySelectorAll('.permission-card');
const lastReply = () => [...document.querySelectorAll('.message.assistant')].pop()?.textContent ?? '';

describe('PermissionStack', () => {
  test('"never ask again" turns on auto-approve for every later request', async () => {
    let autoApprove = '';
    const studio = createStudio({
      routes: {
        'POST /api/settings/global': (req: { body: unknown }) => {
          autoApprove = (req.body as { value: string }).value;
          return {};
        },
        'POST /api/sessions/s1/permissions/req-1': {},
        '/api/settings': () => settings(autoApprove),
      },
    });
    studio.render();
    await screen.findByText('说说要做什么');
    const user = userEvent.setup();
    await user.type(document.getElementById('prompt')!, '要批准：装一下 three');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(studio.api.count('POST /api/sessions/s1/turns')).toBe(1));
    await studio.emit([...turnStart('t1', '要批准：装一下 three'), { kind: 'permission', turn_id: 't1', permission: install }]);
    expect(cards()).toHaveLength(1);
    expect(cards()[0].querySelector('.permission-command')?.textContent).toBe('npm install three');

    await user.click(within(cards()[0] as HTMLElement).getByRole('button', { name: '以后都不用问' }));
    // 先打开全局的自动批准，再放行眼前这一条。
    await waitFor(() => expect(studio.api.count('POST /api/sessions/s1/permissions/req-1')).toBe(1));
    const posts = studio.api.calls.filter((c) => c.method === 'POST' && c.path !== '/api/sessions/s1/turns');
    expect(posts.map((c) => [c.path, c.body])).toEqual([
      ['/api/settings/global', { key: 'AUTO_APPROVE', value: 'on' }],
      ['/api/sessions/s1/permissions/req-1', { decision: 'allow' }],
    ]);
    await studio.emit([{ kind: 'permission-resolved', turn_id: 't1', permission: { id: 'req-1', decision: 'allow' } }, ...turnDone('t1', '审批结果：behavior:allow')]);
    expect(cards()).toHaveLength(0);
    expect(lastReply()).toContain('behavior:allow');

    // 之后的请求后端直接放行：不发 permission，只在这一轮里留一行 notice。
    await user.type(document.getElementById('prompt')!, '要批准：再装一次');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(studio.api.count('POST /api/sessions/s1/turns')).toBe(2));
    await studio.emit([
      ...turnStart('t2', '要批准：再装一次'),
      { kind: 'notice', turn_id: 't2', text: '已自动允许：npm install three' },
      ...turnDone('t2', '审批结果：behavior:allow'),
    ]);
    expect(lastReply()).toContain('behavior:allow');
    expect(cards()).toHaveLength(0);
    expect(document.getElementById('messages')?.textContent).toContain('已自动允许：npm install three');

    expect(studio.api.unmatched).toEqual([]);

    // 设置页里能看到、也能关掉（设置页别的几块——模型服务、皮肤——不在这里看，它们的接口没登记）。
    await user.click(document.getElementById('settings-trigger')!);
    const select = await screen.findByLabelText('全局执行操作前问我');
    expect((select as HTMLSelectElement).value).toBe('on');
  });
});
