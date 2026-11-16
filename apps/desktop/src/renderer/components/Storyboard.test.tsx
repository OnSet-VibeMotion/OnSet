// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi } from '../testing';
import type { StoryboardResponse, StoryboardScene } from '../types';
import { StoryboardTab } from './Storyboard';
import { filmStyles } from './filmStyleFixtures';

// 分镜页的画风：每个镜头实际用的风格（后端按默认风格解析，packages/engine/src/studio/storyboard.test.ts 钉着）、
// 风格交界与过渡手法；「换风格」不改文件，把要求写进输入框交给编排工具。

const watercolor = { key: 'lemo-opuscar/watercolor', kind: 'default' as const, cn: '水彩笔刷', category_cn: '绘画' };
const ink = { key: 'lemo-opuscar/ink-wash', kind: 'named' as const, cn: '中国水墨', category_cn: '绘画' };

const scene = (id: string, over: Partial<StoryboardScene>): StoryboardScene => ({
  id,
  dir: `scenes/${id}`,
  style: watercolor,
  text: 'hello',
  seconds: 1,
  created: true,
  rendered: false,
  ...over,
});

const board: StoryboardResponse = {
  gate: null,
  plan_path: 'production/scene-plan.json',
  default_style: { key: watercolor.key, cn: watercolor.cn, category_cn: watercolor.category_cn },
  installed_styles: [watercolor.key, ink.key],
  scenes: [
    scene('scene-001', { summary: '开场' }),
    scene('scene-002', {
      summary: '回忆',
      anchor: '第 2 条字幕',
      film_style: 'lemo-opuscar/ink-wash',
      style: ink,
      handoff: { device: 'carry', device_label: '带过去', bridge: '一滴墨晕开', style_shift: 'morph', style_shift_label: '画法渐变' },
    }),
    scene('scene-003', { summary: '回到现在', anchor: '第 3 条字幕' }),
  ],
};

describe('分镜页的画风', () => {
  it('列出全片几种画风、每个镜头的画风与风格交界，换风格写进输入框', async () => {
    const api = mockApi({ '/api/storyboard': board, '/api/film-styles': filmStyles });
    const onQuick = vi.fn();
    const { container } = render(<StoryboardTab version={1} busy="" onQuick={onQuick} onFile={vi.fn()} onScene={vi.fn()} />);
    const styles = await screen.findByRole('region', { name: '画风' });
    expect(styles.textContent).toContain('2 种画风 · 2 处风格交界');
    expect([...styles.querySelectorAll('.sb-style-group')].map((g) => g.textContent)).toEqual([
      expect.stringMatching(/水彩笔刷默认.*2 个镜头 · 01、03/),
      expect.stringMatching(/中国水墨.*1 个镜头 · 02/),
    ]);

    const card = (id: string) => container.querySelector<HTMLElement>(`#storyboard .sb-scene[data-scene="${id}"]`)!;
    expect(card('scene-001').querySelector('.sb-style')!.textContent).toContain('水彩笔刷（默认）');
    expect(card('scene-002').querySelector('.sb-style')!.textContent).toContain('中国水墨');
    expect(card('scene-002').classList.contains('off-default')).toBe(true);

    // 两处风格交界：写了过渡手法的显示手法，没写的照实标出（scene_cues 会拒绝它）。
    const shifts = container.querySelectorAll('#storyboard .sb-handoff.style-shift');
    expect(shifts).toHaveLength(2);
    expect(shifts[0].textContent).toContain('水彩笔刷→中国水墨');
    expect(shifts[0].textContent).toContain('画法渐变');
    expect(container.querySelector('#storyboard .sb-handoff.unplanned')!.textContent).toContain('还没写画风怎么换过去');

    // 换风格：不改文件，写进输入框交给编排工具。
    await userEvent.click(within(card('scene-003').querySelector<HTMLElement>('.sb-style')!).getByRole('button', { name: '换风格' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(dialog.querySelector<HTMLElement>('.fs-item[data-style="lemo-opuscar/ink-wash"]')!);
    await userEvent.click(within(dialog).getByRole('button', { name: '写进对话' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onQuick).toHaveBeenCalledTimes(1);
    const [text, attachments, draftOnly] = onQuick.mock.calls[0];
    expect(text).toMatch(/把镜头 03（scene-003）换成「中国水墨」风格（lemo-opuscar\/ink-wash）。.*scene_cues\(\)/);
    expect(attachments).toEqual([]);
    expect(draftOnly).toBe(true);
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(api.unmatched).toEqual([]);
  });
});
