// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, reply } from '../testing';
import type { PromptCheck, StoryboardResponse, StoryboardScene, Task } from '../types';
import { StoryboardTab } from './Storyboard';

// 分镜页的「检查画面描述」：检查只出草稿、不动 prompt.md；检查之后 prompt.md 改过时照实说过期、不给采用；
// 采用要用户点了才发。草稿怎么存、过期怎么判、接口回 409 由 packages/engine/src/studio/promptchecks.test.ts 钉着。

const check: PromptCheck = {
  scene: 'scene-001',
  dir: 'scenes/scene-001',
  base_sha256: 'a'.repeat(64),
  checked_at: '2026-11-15T00:00:00Z',
  tool: 'claude',
  model: '',
  scores: { intent: 82, concreteness: 48, pacing: 75, continuity: 90, ambiguity: 66 },
  issues: ['没写主体在画面里的位置：写明门在画面中央'],
  decision: 'minor',
  prompt: 'before\n门在画面中央，缓缓推开。\n',
  outdated: false,
};

function board(over: Partial<StoryboardScene> = {}): StoryboardResponse {
  return {
    gate: null,
    plan_path: '',
    installed_styles: [],
    scenes: [
      {
        id: 'scene-001',
        dir: 'scenes/scene-001',
        style: { key: '', kind: 'free', cn: '自主定视觉' },
        text: 'hello',
        seconds: 1,
        prompt: { path: 'scenes/scene-001/prompt.md', content: 'before\n' },
        created: true,
        rendered: false,
        ...over,
      },
    ],
  };
}

const task = (id: string): Task => ({ task_id: id, type: 'prompt-check', status: 'succeeded', progress: 1, message: '', created_at: '', updated_at: '' });

function setup() {
  const api = mockApi({
    '/api/storyboard': board(),
    'POST /api/prompt-checks': () => {
      api.set('/api/storyboard', board({ prompt_check: check }));
      return reply(202, { task_id: 'check-1' });
    },
    '/api/tasks/check-1': task('check-1'),
    '/api/tasks/apply-1': task('apply-1'),
  });
  const props = { busy: '', onQuick: vi.fn(), onFile: vi.fn(), onScene: vi.fn() };
  const view = render(<StoryboardTab version={1} {...props} />);
  const reopen = (version: number) => view.rerender(<StoryboardTab version={version} {...props} />);
  return { api, reopen, ...view };
}

const result = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-check-result="scene-001"]');
const applyButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('[data-apply="scene-001"]');

describe('检查画面描述', () => {
  it('检查只出草稿，过期时不给采用，采用要点了才写', async () => {
    const { api, reopen, container } = setup();
    await userEvent.click(await screen.findByRole('button', { name: '检查画面描述' }));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/prompt-checks')?.body).toEqual({ scene: 'scenes/scene-001' });
    await screen.findByText('建议小改');
    const card = result(container)!;
    expect(card.textContent).toContain('没写主体在画面里的位置');
    expect(card.querySelectorAll('.pc-scores li')).toHaveLength(5);
    // 检查只出草稿：没有任何写 prompt.md 的请求。
    expect(api.calls.some((c) => c.path.endsWith('/apply'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '看改写稿' }));
    expect(card.querySelector('.pc-diff .add')!.textContent).toContain('门在画面中央');

    // 检查之后有人改了 prompt.md：重新读分镜后照实说结果过期了，不给「采用」。
    api.set('/api/storyboard', board({ prompt: { path: 'scenes/scene-001/prompt.md', content: '手改过\n' }, prompt_check: { ...check, outdated: true } }));
    reopen(2);
    await screen.findByText(/检查之后改过了/);
    expect(applyButton(container)).toBeNull();
    // 改回检查时的样子，草稿又能采用。
    api.set('/api/storyboard', board({ prompt_check: check }));
    reopen(3);
    await screen.findByRole('button', { name: '采用改写稿' });
    expect(result(container)!.textContent).not.toContain('检查之后改过了');

    api.set('POST /api/prompt-checks/scene-001/apply', () => {
      api.set('/api/storyboard', board({ prompt: { path: 'scenes/scene-001/prompt.md', content: 'before\n门在画面中央，缓缓推开。\n' } }));
      return reply(202, { task_id: 'apply-1' });
    });
    await userEvent.click(applyButton(container)!);
    // 采用后草稿删掉，卡片回到「检查画面描述」。
    await screen.findByRole('button', { name: '检查画面描述' });
    expect(api.count('POST /api/prompt-checks/scene-001/apply')).toBe(1);
    expect(api.unmatched).toEqual([]);
  });

  it('采用时后端发现 prompt.md 已经改过（409），照实报出来，不当成写好了', async () => {
    const api = mockApi({
      '/api/storyboard': board({ prompt_check: check }),
      'POST /api/prompt-checks/scene-001/apply': reply(409, { code: 'outdated', message: 'scene-001 的 prompt.md 在检查之后改过了，请重新检查' }),
    });
    const { container } = render(<StoryboardTab version={1} busy="" onQuick={vi.fn()} onFile={vi.fn()} onScene={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: '采用改写稿' }));
    await screen.findByText('scene-001 的 prompt.md 在检查之后改过了，请重新检查');
    expect(container.querySelector('.pc-error')).toBeTruthy();
    expect(api.calls.some((c) => c.path.startsWith('/api/tasks/'))).toBe(false);
  });
});
