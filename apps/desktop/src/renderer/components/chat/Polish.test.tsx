// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, type MockRequest } from '../../testing';
import { Chat } from '../Chat';
import type { PolishResult } from './Polish';

// 输入框的「润色」：结果显示在输入框上方，「用这版」只替换输入框、不发送，还能换回原话。
// 润色怎么调模型、必须保留的东西怎么核对由 packages/engine/src/promptopt/promptopt.test.ts 钉着。

/** 后端 /api/polish：草稿已经清楚时说不用改，否则返回保留了 @scene-001 的改写稿。 */
function polish(req: MockRequest): PolishResult {
  const message = String((req.body as { message: string }).message);
  if (message.includes('已经很清楚')) return { decision: 'skip', text: message, notes: [], tool: 'claude' };
  return { decision: 'rewrite', text: '@scene-001 画面元素太多、看不出重点：保留主物件，去掉次要的装饰，其余镜头不动。', notes: ['写明了改哪一方面、不动哪里'], tool: 'claude' };
}

function setup() {
  const api = mockApi({ 'POST /api/polish': polish });
  const noop = () => {};
  render(
    <Chat
      agents={null}
      choice={{ tool: 'claude', renderer: 'claude' }}
      onChoice={noop}
      sessions={[]}
      sessionId=""
      busy=""
      attachments={[]}
      projectPath="/tmp/demo"
      onSession={noop}
      onSessionsChanged={noop}
      onRemoveAttachment={noop}
      onClearAttachments={noop}
      onFilesChanged={noop}
      onTurnEnd={noop}
      onOpenFile={noop}
      onAddAttachments={noop}
      scenes={[]}
      outbox={null}
      view={{ page: '' }}
      onView={noop}
      tree={[]}
      run={vi.fn()}
      progress={null}
      jump={null}
      onProgress={noop}
    />,
  );
  return { api, prompt: screen.getByRole('combobox', { name: '消息' }) as HTMLTextAreaElement };
}

describe('润色', () => {
  it('润色结果放进输入框但不发送，能换回原话；已经清楚的话说不用改', async () => {
    const { api, prompt } = setup();
    await userEvent.type(prompt, '@scene-001 太乱了');
    await userEvent.click(screen.getByRole('button', { name: '润色' }));
    expect((await screen.findByText(/画面元素太多/, { selector: '#polish-text' })).textContent).toBe('@scene-001 画面元素太多、看不出重点：保留主物件，去掉次要的装饰，其余镜头不动。');
    expect(document.querySelector('#polish-card')!.textContent).toContain('写明了改哪一方面、不动哪里');
    expect(api.calls.find((c) => c.path === '/api/polish')?.body).toMatchObject({ message: '@scene-001 太乱了', tool: 'claude' });
    // 点之前输入框不动。
    expect(prompt.value).toBe('@scene-001 太乱了');
    await userEvent.click(screen.getByRole('button', { name: '用这版' }));
    expect(document.querySelector('#polish-card')).toBeNull();
    expect(prompt.value).toMatch(/^@scene-001 画面元素太多/);
    // 只替换，不发送：没有建会话、没有发出一轮。
    expect(api.calls.some((c) => c.path.startsWith('/api/sessions'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '换回原话' }));
    expect(prompt.value).toBe('@scene-001 太乱了');

    // 已经清楚的话：说不用改，没有「用这版」。
    await userEvent.clear(prompt);
    await userEvent.type(prompt, '这句已经很清楚了');
    await userEvent.click(screen.getByRole('button', { name: '润色' }));
    await screen.findByText(/不用改/);
    expect(screen.queryByRole('button', { name: '用这版' })).toBeNull();
    expect(api.count('POST /api/polish')).toBe(2);
  });
});
