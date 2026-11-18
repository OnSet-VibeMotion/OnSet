// @vitest-environment jsdom
/*
 * 发布页的文案区：平台标题与平台专属话题（copy.platform_titles / platform_hashtags）按平台中文名列出，
 * 写了平台话题时通用的那一行叫「通用话题」。
 */
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { mockApi } from '../testing';
import { PublishTab } from './Publish';

function publishData(copy: Record<string, unknown>, platformNames?: Record<string, string>) {
  return {
    available: true,
    covers: [],
    platform_name: 'B 站',
    ...(platformNames ? { platform_names: platformNames } : {}),
    data: { publish_status: 'draft', platform: 'bilibili', copy },
  };
}

function field(label: string): string {
  const row = screen.getByText(label).closest('.publish-field');
  return row?.querySelector('.publish-field-value')?.textContent ?? '';
}

test('lists per-platform topics under the platform name', async () => {
  const api = mockApi({
    '/api/publish': publishData(
      {
        primary_title: '片场',
        hashtags: ['片场', 'AI视频'],
        platform_titles: { xiaohongshu: 'Demo｜片场' },
        platform_hashtags: { xiaohongshu: ['片场', 'AI视频', '小红书创作活动'], bilibili: [] },
      },
      { bilibili: 'B 站', xiaohongshu: '小红书' },
    ),
  });
  render(<PublishTab version={0} run={() => {}} />);
  expect(await screen.findByText('通用话题')).toBeTruthy();
  expect(field('通用话题')).toBe('片场 AI视频');
  expect(field('小红书 话题')).toBe('片场 AI视频 小红书创作活动');
  expect(field('B 站 话题')).toBe('（空）');
  expect(field('小红书 标题')).toBe('Demo｜片场');
  expect(api.unmatched).toEqual([]);
});

test('keeps a single topics row when no platform overrides them', async () => {
  mockApi({ '/api/publish': publishData({ primary_title: '片场', hashtags: ['片场'] }) });
  render(<PublishTab version={0} run={() => {}} />);
  expect(await screen.findByText('话题')).toBeTruthy();
  expect(screen.queryByText('通用话题')).toBeNull();
  expect(field('话题')).toBe('片场');
});
