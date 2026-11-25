// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { type MockRequest, mockApi, reply } from '../testing';
import { Preview, visibleTabs } from './Preview';
import { renderPreview, sceneRow } from './previewTesting';

it('finds identical local ids by source, previews and puts a qualified motion reference in the draft', async () => {
  const api = mockApi({
    '/api/motion-effects': {
      sources: [
        {
          id: 'motion-prompt',
          name: 'Motion Prompt',
          version: 'pinned',
          effects: [
            {
              id: '005',
              name: '遮罩显现',
              category: '动效',
              summary: '从遮罩后显现',
              aliases: ['Mask Reveal'],
              preview: '/preview/motion/005',
            },
          ],
        },
        {
          id: 'other-motion',
          name: '另一套动效',
          version: '2.0.0',
          effects: [
            {
              id: '005',
              name: '上浮',
              category: '动效',
              summary: '向上显现',
              spec: ['LONG ENGLISH SPEC LINE'],
              renderer_skill: 'float',
            },
          ],
        },
      ],
    },
  });
  const { props } = renderPreview('motion', [sceneRow('scene-003')]);
  expect(visibleTabs([])).toContainEqual(['motion', '动效']);
  await screen.findByRole('heading', { name: '遮罩显现' });
  expect(screen.getByTitle('遮罩显现预览').getAttribute('sandbox')).toBe('allow-scripts');

  const user = userEvent.setup();
  await user.type(screen.getByRole('searchbox'), 'Mask Reveal');
  expect(screen.queryByRole('button', { name: /上浮/ })).toBeNull();
  await user.clear(screen.getByRole('searchbox'));
  await user.type(screen.getByRole('searchbox'), '#005');
  await user.selectOptions(screen.getByLabelText('来源'), 'other-motion');
  await user.click(screen.getByRole('button', { name: '写进对话' }));
  expect(props.onQuick).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/scene-003.*other-motion:005.*2\.0\.0[\s\S]*motion_effects[\s\S]*other-motion\/float/),
    [],
    true,
    true,
  );
  // 草稿不再把大段英文 spec 塞进聊天框。
  expect(props.onQuick.mock.calls[0][0]).not.toContain('LONG ENGLISH SPEC LINE');
  expect(props.run).not.toHaveBeenCalled();
  expect(api.unmatched).toEqual([]);
});

it('shows a recoverable catalog error and an empty search result', async () => {
  const api = mockApi({ '/api/motion-effects': reply(500, { message: '读取失败' }) });
  renderPreview('motion', []);
  expect((await screen.findByRole('alert')).textContent).toContain('读取失败');
  api.set('/api/motion-effects', { sources: [] });
  await userEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByText('没有找到匹配的动效。');
});

it('starts with the current project scene when switching projects that share scene ids', async () => {
  mockApi({
    '/api/motion-effects': {
      sources: [
        {
          id: 'motion-prompt',
          name: 'Motion Prompt',
          version: 'pinned',
          effects: [{ id: '005', name: '遮罩显现', category: '动效', summary: '从遮罩后显现' }],
        },
      ],
    },
  });
  const scenes = ['scene-001', 'scene-003'].map((id) => sceneRow(id));
  const view = renderPreview('motion', scenes);
  const withProject = (id: string) => ({
    project: { id, name: id, path: '/' + id },
    metadata: {},
    scenes: { total: scenes.length, completed: 0, stale: 0 },
  });
  view.rerender(<Preview {...view.props} state={withProject('first')} />);
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText('目标镜头'), 'scene-003');

  view.rerender(<Preview {...view.props} state={withProject('second')} />);
  await user.click(await screen.findByRole('button', { name: '写进对话' }));
  expect(view.props.onQuick).toHaveBeenCalledWith(expect.stringContaining('镜头 scene-001'), [], true, true);
});

it('toggles a motion effect in bound series defaults.motion_effects', async () => {
  const puts: Record<string, unknown>[] = [];
  let seriesMotions: string[] = [];
  mockApi({
    '/api/motion-effects': {
      sources: [
        {
          id: 'motion-prompt',
          name: 'Motion Prompt',
          version: 'pinned',
          effects: [{ id: '005', name: '遮罩显现', category: '动态图形', summary: '从遮罩后显现' }],
        },
      ],
    },
    '/api/series/ai-lab': () => ({
      series: {
        schema: 1,
        id: 'ai-lab',
        name: 'AI 实验室',
        next_episode: 2,
        defaults: { canvas: 'landscape-16x9', motion_effects: seriesMotions },
        brief: '',
        project_count: 1,
        created_at: '',
        updated_at: '',
      },
      projects: [],
    }),
    'PUT /api/series/ai-lab': (req: MockRequest) => {
      const body = req.body as { defaults: { motion_effects: string[] } };
      puts.push(body);
      seriesMotions = body.defaults.motion_effects;
      return {
        schema: 1,
        id: 'ai-lab',
        name: 'AI 实验室',
        next_episode: 2,
        defaults: body.defaults,
        brief: '',
        project_count: 1,
        created_at: '',
        updated_at: '',
      };
    },
  });

  const view = renderPreview('motion', [sceneRow('scene-001')]);
  view.rerender(
    <Preview
      {...view.props}
      state={{
        project: { id: 'p1', name: 'EP01', path: '/ep01', series_id: 'ai-lab', episode: 1 },
        metadata: {},
        scenes: { total: 1, completed: 0, stale: 0 },
      }}
    />,
  );

  const user = userEvent.setup();
  const addBtn = await screen.findByRole('button', { name: '加入本专栏常用' });
  await user.click(addBtn);
  await screen.findByRole('button', { name: '已在专栏常用' });
  expect(puts[0]).toEqual({
    defaults: { canvas: 'landscape-16x9', motion_effects: ['motion-prompt:005'] },
  });

  await user.click(screen.getByRole('button', { name: '已在专栏常用' }));
  await screen.findByRole('button', { name: '加入本专栏常用' });
  expect(puts[1]).toEqual({
    defaults: { canvas: 'landscape-16x9', motion_effects: [] },
  });
});
