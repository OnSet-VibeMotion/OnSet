// @vitest-environment jsdom
/*
 * 输入框的 @ 与 / 补全（Chat.tsx 的输入框，补全规则在 chat/complete.ts）：@ 选中后留在文字里、发送时变成引用；
 * / 命令在界面里直接执行，不发给编排工具。原来在 e2e/content.spec.mjs。
 */
import { describe, expect, test } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStudio, lastTurnRequest, turnStart, userText } from './studioHarness';
import type { MemoryState, RecallResponse, ScriptResponse } from '../../types';

/** 还没有任何经历的记忆库（/api/memory）。 */
const emptyMemory: MemoryState = {
  enabled: true,
  dir: '/Users/me/.local/share/onset/memory',
  pinned: 0,
  budget: 1200,
  renderer: 'claude',
  status: { snapshot: 0, counts: {}, drift: [], weak: [], retest: [], episodes: 0, pending_failures: 0 },
  memories: [],
  timeline: [],
  exams: [],
  snapshots: [],
  runs: [],
  labels: { checks: {}, events: {}, features: {} },
};
const emptyRecall: RecallResponse = {
  recall: { snapshot: 0, renderer: 'claude', features: [], budget: 1200, used: 0, max_lessons: 3, items: [] },
  reasons: [],
  section: '',
};

const prompt = () => document.getElementById('prompt') as HTMLTextAreaElement;
const completions = () => document.getElementById('completions');

describe('composer completions', () => {
  test('completes @ mentions and / commands in the input', async () => {
    const studio = createStudio({
      routes: {
        // 「/script」打开口播稿页、「/show 记忆」打开记忆页：两页自己要读的接口。
        '/api/script': { gate: null, path: 'production/script.md', content: '原稿', final: false } satisfies ScriptResponse,
        '/api/memory': emptyMemory,
        '/api/memory/recall': emptyRecall,
      },
    });
    studio.render();
    await screen.findByText('说说要做什么');
    const user = userEvent.setup();

    // @：列出镜头与文件，选中后留在文字里，发送时变成引用。
    await user.type(prompt(), '看看 @sce');
    await waitFor(() => expect(completions()?.textContent).toContain('scene-001'));
    await user.keyboard('{Enter}');
    expect(prompt().value).toBe('看看 @scene-001 ');
    await user.type(prompt(), '太快了');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(lastTurnRequest(studio.api)).toBeDefined());
    const sent = lastTurnRequest(studio.api)!;
    expect(sent.message).toBe('看看 @scene-001 太快了');
    expect(sent.attachments).toEqual([{ ref: true, scene_id: 'scene-001' }]);
    // 后端把引用写进用户消息，界面拆出来放在消息下面。
    await studio.emit(turnStart('t1', userText(sent.message, sent.attachments)));
    expect(document.querySelector('.user-extra')?.textContent).toContain('镜头 scene-001');

    // /：命令在界面里执行，不发给编排工具。
    await studio.emit({ kind: 'turn-end', turn_id: 't1', status: 'succeeded' });
    const turnsBefore = studio.api.count('POST /api/sessions/s1/turns');
    await user.type(prompt(), '/scr');
    await waitFor(() => expect(document.querySelector('#completions .completion')?.textContent).toContain('/script'));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.querySelector('[data-tab="script"]')?.className).toMatch(/\bon\b/));
    expect(prompt().value).toBe('');

    // 带参数的命令：先选命令，再选参数。
    await user.type(prompt(), '/sho');
    await user.keyboard('{Enter}');
    expect(prompt().value).toBe('/show ');
    await waitFor(() => expect(completions()?.textContent).toContain('记忆'));
    await user.type(prompt(), '记忆');
    await user.keyboard('{Enter}');
    const pageMenu = document.getElementById('page-menu-trigger')!;
    await waitFor(() => expect(pageMenu.className).toMatch(/\bon\b/));
    expect(pageMenu.textContent).toContain('记忆');
    expect(studio.api.count('POST /api/sessions/s1/turns')).toBe(turnsBefore);

    // Esc 收起补全。
    await user.clear(prompt());
    await user.type(prompt(), '@');
    await waitFor(() => expect(completions()).not.toBeNull());
    await user.keyboard('{Escape}');
    expect(completions()).toBeNull();
    expect(studio.api.unmatched).toEqual([]);
  });
});
