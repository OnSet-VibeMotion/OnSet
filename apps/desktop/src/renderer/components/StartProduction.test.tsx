// @vitest-environment jsdom
/*
 * 渲染工具没装时「开始制作」不能点（原 e2e/onboarding.spec.mjs「start production stays off while the renderer is not installed」）。
 * 只看对话顶上的按钮、提示与输入框下方的渲染工具选择；对话本身的行为由 Chat 的测试负责。
 * 项目配置里渲染工具是 Qoder，这台（假）电脑上没有它。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { mockApi } from '../testing';
import type { AgentChoice, AgentInfo, AgentsResponse } from '../types';
import { Chat } from './Chat';

const agents: AgentsResponse = {
  agents: (
    [
      ['claude', 'Claude Code', true],
      ['codex', 'Codex', true],
      ['qoder', 'Qoder', false],
      ['opencode', 'OpenCode', true],
    ] as const
  ).map(([id, label, installed]): AgentInfo => ({ id, label, command: id, installed, renderer: true })),
  orchestrator: 'claude',
  renderer: 'qoder',
  orchestrator_model: '',
  renderer_model: '',
  global_renderer: 'qoder',
};

/** 和 app.tsx 一样：新对话还没建会话时，选的工具留在外面这层。 */
function Harness() {
  const [choice, setChoice] = useState<AgentChoice>({ tool: 'claude', renderer: 'qoder' });
  return (
    <Chat
      agents={agents}
      choice={choice}
      onChoice={setChoice}
      sessions={[]}
      sessionId=""
      busy=""
      attachments={[]}
      projectPath="/tmp/项目"
      onSession={() => {}}
      onSessionsChanged={() => {}}
      onRemoveAttachment={() => {}}
      onClearAttachments={() => {}}
      onFilesChanged={() => {}}
      onTurnEnd={() => {}}
      onOpenFile={() => {}}
      onAddAttachments={() => {}}
      scenes={[]}
      outbox={null}
      view={{ page: '' }}
      onView={() => {}}
      tree={[]}
      run={() => {}}
      progress={null}
      jump={null}
      onProgress={() => {}}
    />
  );
}

test('start production stays off while the renderer is not installed', async () => {
  const user = userEvent.setup();
  mockApi({
    '/api/agents/claude/models': { tool: 'claude', models: [] },
    '/api/agents/qoder/models': { tool: 'qoder', models: [] },
  });
  const { container } = render(<Harness />);
  const start = container.querySelector('#start-production') as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  expect(start.title).toContain('Qoder');
  expect(screen.getByRole('alert').id).toBe('renderer-missing');
  expect(container.querySelector('#renderer-missing')?.textContent).toContain('Qoder');
  // 没装的那家在下拉框里照样显示（选着的），但不能再选回来。
  const renderer = container.querySelector('#agent-renderer') as HTMLSelectElement;
  expect((renderer.querySelector('option[value="qoder"]') as HTMLOptionElement).textContent).toContain('（未安装）');

  // 在输入框下方换一家装好的，就能开工。
  await user.selectOptions(renderer, 'claude');
  await waitFor(() => expect(start.disabled).toBe(false));
  expect(container.querySelector('#renderer-missing')).toBeNull();
});
