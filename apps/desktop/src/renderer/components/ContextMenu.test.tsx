// @vitest-environment jsdom
/*
 * 工作台的右键菜单（ContextMenu.tsx，挂在整个 App 里）：口播稿的一段、文件树的文件引用进对话，
 * 引用里是字幕文字、不带读法；输入框里保留系统菜单。原来在 e2e/content.spec.mjs。
 */
import { describe, expect, test } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStudio, findEl, lastTurnRequest, turnStart, userText } from './chat/studioHarness';
import type { ScriptResponse, TreeFile } from '../types';

// 后端 /api/script 对「# 开场\n\n第一段，<2025年|二零二五年>很贵。\n\n第二段。」的排版（align 的 view）。
const script: ScriptResponse = {
  gate: { id: 'gate-script' },
  path: 'production/script-final.md',
  content: '# 开场\n\n第一段，<2025年|二零二五年>很贵。\n\n第二段。\n',
  final: true,
  updated_at: '2026-11-17T00:00:00Z',
  blocks: [
    { kind: 'heading', level: 1, text: '开场' },
    { kind: 'para', nodes: [{ kind: 'text', text: '第一段，' }, { kind: 'alt', text: '2025年', spoken: '二零二五年' }, { kind: 'text', text: '很贵。' }] },
    { kind: 'para', nodes: [{ kind: 'text', text: '第二段。' }] },
  ],
  stats: { units: 13, paragraphs: 2, phrases: 0 },
  estimate_seconds: 3,
};

const tree: TreeFile[] = [
  { path: 'notes.md', size: 13, mtime: 1 },
  { path: 'production/script-final.md', size: 60, mtime: 2 },
  { path: 'scenes/scene-001/prompt.md', size: 7, mtime: 1 },
];

const menu = () => document.querySelector('.ctx-menu') as HTMLElement | null;
const quotes = () => document.querySelectorAll('#attachments .quote-card');

describe('ContextMenu', () => {
  test('right-click quotes script text and files into the chat', async () => {
    const studio = createStudio({
      tree,
      routes: {
        '/api/script': script,
        '/api/files': { path: 'notes.md', size: 13, binary: false, content: '项目笔记\n' },
      },
    });
    studio.render();
    await screen.findByText('说说要做什么');
    const user = userEvent.setup();
    await user.click(await findEl('[data-tab="script"]'));

    // 段落上右键：整段引用，引用里是字幕文字，不带读法。
    const para = await findEl('.script-body p');
    fireEvent.contextMenu(para);
    expect(menu()?.textContent).toContain('口播稿第 1 段');
    await user.click(within(menu()!).getByRole('menuitem', { name: '引用这一段到对话' }));
    expect(menu()).toBeNull();
    expect(quotes()[0].textContent).toContain('第一段，2025年很贵。');
    expect(quotes()[0].textContent).not.toContain('二零二五年');

    // 文件树上右键：引用文件。
    await user.click(document.getElementById('page-menu-trigger')!);
    await user.click(document.querySelector('.page-menu-list [data-tab="file"]') as HTMLElement);
    const file = await findEl('.tree-file', (el) => !!el.textContent?.includes('notes.md'));
    fireEvent.contextMenu(file);
    await user.click(within(menu()!).getByRole('menuitem', { name: '引用这个文件到对话' }));
    expect(quotes()).toHaveLength(2);
    // 文件树上左键：打开文件。
    await user.click(file);
    await waitFor(() => expect(document.getElementById('file-content')?.textContent).toContain('项目笔记'));

    // 输入框里保留系统自己的菜单：不拦截，也不弹我们的菜单。
    const prompt = document.getElementById('prompt')!;
    expect(fireEvent.contextMenu(prompt)).toBe(true);
    expect(menu()).toBeNull();
    await user.type(prompt, '这段太长');
    await user.click(document.getElementById('send')!);
    await waitFor(() => expect(lastTurnRequest(studio.api)).toBeDefined());
    const sent = lastTurnRequest(studio.api)!;
    expect(sent.attachments).toEqual([
      { quote: '第一段，2025年很贵。', label: '口播稿第 1 段', source: 'production/script-final.md' },
      { ref: true, source: 'notes.md' },
    ]);
    // 后端把引用写进用户消息，界面拆出来放在消息下面。
    await studio.emit(turnStart('t1', userText(sent.message, sent.attachments)));
    const extra = document.querySelector('.user-extra')!.textContent;
    expect(extra).toContain('口播稿第 1 段（production/script-final.md）');
    expect(extra).toContain('文件 notes.md');
    expect(studio.api.unmatched).toEqual([]);
  });
});
