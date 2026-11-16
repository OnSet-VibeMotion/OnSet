// @vitest-environment jsdom
/*
 * 回复里的风格推荐（Chat.tsx 的 StylePicks）：```film-styles 代码块画成海报卡片，标出全片默认或只用在某一段；
 * 点了把选择作为下一条消息发出，答过之后收起。原来在 e2e/content.spec.mjs。
 */
import { describe, expect, test } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStudio, lastTurnRequest, turnDone, turnStart } from './studioHarness';
import type { FilmStyle, FilmStylesResponse } from '../../types';

/** /api/film-styles 里 LemoLab 风格库的三种（studio/filmstyle.ts 的 styleJSON）。 */
const lemo = (slug: string, order: string, cn: string, en: string, category_cn: string, category_en: string, summary: string): FilmStyle => ({
  source: 'lemo-opuscar', slug, order, cn, en, category_cn, category_en, uses: [], summary,
});
const filmStyles: FilmStylesResponse = {
  sources: [{ id: 'lemo-opuscar', name: 'LemoLab 风格库', categories: ['手绘与绘画', '东方传统'], ready: true }],
  styles: [
    lemo('ink-wash', '03', '中国水墨', 'Chinese Ink Wash', '手绘与绘画', 'Hand-drawn & Painting', '侠客踏水过江，一剑断流。'),
    lemo('impasto', '04', '油画厚涂', 'Impasto Oil Painting', '手绘与绘画', 'Hand-drawn & Painting', '灰色雨中广场，第一把红伞撑开。'),
    lemo('ukiyoe', '08', '浮世绘', 'Ukiyo-e', '东方传统', 'East Asian Traditions', '旅人走向远山，每个镜头都是一幅版画。'),
  ],
};

// 假 claude「挑几张海报」的回复：film-styles 代码块与 choices 代码块。
const recommendation = [
  '推荐两种：',
  '```film-styles',
  'lemo-opuscar/impasto 厚涂有分量',
  'lemo-opuscar/ukiyoe 版画感强',
  'lemo-opuscar/ink-wash [回忆段，镜头 04–06] 留白像记忆',
  '```',
  '```choices',
  '不用整片风格',
  '```',
].join('\n');

describe('StylePicks', () => {
  test('shows posters for film styles the orchestrator recommends', async () => {
    const studio = createStudio({ filmStyles });
    studio.seed([...turnStart('t1', '挑几张海报'), ...turnDone('t1', recommendation)]);
    studio.render();
    await waitFor(() => expect(document.querySelectorAll('.style-picks .style-pick')).toHaveLength(3));
    const picks = [...document.querySelectorAll<HTMLElement>('.style-picks .style-pick')];
    expect(picks[0].textContent).toContain('油画厚涂');
    expect(picks[0].textContent).toContain('厚涂有分量');
    expect(picks[0].textContent).toContain('全片默认风格');
    expect(picks[1].textContent).toContain('浮世绘');
    // 海报走风格目录的缩略图。
    expect(picks[0].querySelector('img')?.getAttribute('src')).toBe('/api/film-styles/lemo-opuscar/impasto/poster.jpg');
    expect(document.querySelector('.message.assistant')?.textContent).not.toContain('film-styles');
    expect(document.querySelector('.choices')?.textContent).toContain('不用整片风格');
    // 只推荐给一段的风格：标出用在哪，按钮与发出的话都不说成整片风格。
    const scoped = document.querySelectorAll<HTMLElement>('.style-pick.scoped');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].textContent).toContain('只用在：回忆段，镜头 04–06');
    expect(within(scoped[0]).getByRole('button').textContent).toBe('用在这一段');
    expect(within(picks[0]).getByRole('button').textContent).toBe('设为整片风格');

    // 点全片默认的那张：把选择作为下一条消息发出。
    await userEvent.setup().click(within(picks[0]).getByRole('button', { name: '设为整片风格' }));
    await waitFor(() => expect(lastTurnRequest(studio.api)?.message).toBe('整片风格用「油画厚涂」（lemo-opuscar/impasto）'));
    await studio.emit(turnStart('t2', lastTurnRequest(studio.api)!.message));
    expect([...document.querySelectorAll('.message.user')].pop()?.textContent).toContain('整片风格用「油画厚涂」（lemo-opuscar/impasto）');
    // 选过之后海报与其他选项收起，只留选中的风格名。
    expect(document.querySelector('.choice-picked')?.textContent).toContain('油画厚涂');
    expect(document.querySelector('.style-picks')).toBeNull();
    expect(screen.queryByRole('button', { name: '不用整片风格' })).toBeNull();
    expect(studio.api.unmatched).toEqual([]);
  });
});
