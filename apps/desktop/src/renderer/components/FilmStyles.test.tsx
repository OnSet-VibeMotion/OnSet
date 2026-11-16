// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, type MockRequest } from '../testing';
import type { ProjectFilmStyle } from '../types';
import { filmStyles, inkWashStyle, manifest, watercolorStyle } from './filmStyleFixtures';
import { idleActivity, renderPreview, sceneRow } from './previewTesting';

// 一个项目装几种风格：风格页列出默认风格与其他风格、各有哪些镜头在用；镜头页显示本镜头的风格，
// 「换风格」不直接改文件，而是把要求写进输入框交给编排工具。/api/film-style 怎么从项目里读出这些由
// packages/engine/src/studio/filmstyle.test.ts 钉着。

const project: ProjectFilmStyle = {
  installed: true,
  manifest: manifest(watercolorStyle),
  style_file: '.agents/skills/onset-film-style/STYLE.md',
  default_scenes: ['scene-001'],
  extras: [{ manifest: manifest(inkWashStyle), style_file: '.agents/onset-film-styles/lemo-opuscar/ink-wash/STYLE.md', scenes: ['scene-002'] }],
  scenes: [{ id: 'scene-001' }, { id: 'scene-002', film_style: 'lemo-opuscar/ink-wash' }, { id: 'scene-003', film_style: 'none' }],
};

const scenes = [sceneRow('scene-001'), sceneRow('scene-002'), sceneRow('scene-003')];

function routes() {
  return mockApi({
    '/api/film-style': project,
    '/api/film-styles': filmStyles,
    '/api/raw': (req: MockRequest) => (req.query.get('path')!.includes('ink-wash') ? '# 中国水墨\n\n笔触与材质的不变量。\n' : '# 水彩笔刷\n\n笔触与材质的不变量。\n'),
    '/api/storyboard': { gate: null, plan_path: '', installed_styles: [], scenes: [] },
    '/api/scenes/scene-002/activity': idleActivity('scene-002'),
  });
}

describe('一个项目里的几种风格', () => {
  it('风格页列出默认风格与其他风格；镜头页的「换风格」写进输入框交给编排工具', async () => {
    const api = routes();
    const { container, props, show } = renderPreview('style', scenes);
    expect((await screen.findByText(/水彩笔刷/, { selector: '.style-intro.film h3' })).textContent).toContain('水彩笔刷');
    const ink = container.querySelector<HTMLElement>('.style-other[data-style="lemo-opuscar/ink-wash"]')!;
    expect(ink.textContent).toContain('中国水墨');
    expect([...ink.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['镜头 02']);
    const remove = within(ink).getByRole('button', { name: '去掉' }) as HTMLButtonElement;
    expect(remove.disabled, '还有镜头在用时不能去掉').toBe(true);
    await userEvent.click(within(ink).getByRole('button', { name: '看说明' }));
    await screen.findByText('中国水墨 的 STYLE.md');
    expect(container.querySelector('.style-doc')!.textContent).toContain('笔触与材质的不变量');

    // 点镜头编号去那个镜头。
    await userEvent.click(within(ink).getByRole('button', { name: '镜头 02' }));
    expect(props.onScene).toHaveBeenCalledWith('scene-002');
    show('scene', 'scene-002');
    const row = await screen.findByText('中国水墨', { selector: '.scene-style strong' });
    expect(row.closest('.scene-style')!.textContent).toContain('中国水墨');
    await userEvent.click(container.querySelector<HTMLElement>('#scene-style')!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('.fs-item[data-style="lemo-opuscar/ink-wash"] .fs-current')!.textContent).toBe('正在用');
    await userEvent.click(dialog.querySelector<HTMLElement>('.fs-item[data-special="@default"]')!);
    await userEvent.click(within(dialog).getByRole('button', { name: '写进对话' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const [text, attachments, draftOnly] = props.onQuick.mock.calls[0];
    expect(text).toMatch(/把镜头 02（scene-002）改回默认风格「水彩笔刷」.*风格交界/);
    expect(attachments).toEqual([]);
    expect(draftOnly).toBe(true);
    // 风格页与镜头页都只读：没有改风格的写任务。
    expect(props.run).not.toHaveBeenCalled();
    expect(api.unmatched).toEqual([]);
  });
});
