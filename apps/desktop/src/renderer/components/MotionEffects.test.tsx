// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { mockApi, reply } from '../testing';
import { Preview, visibleTabs } from './Preview';
import { renderPreview, sceneRow } from './previewTesting';

it('finds identical local ids by source, previews and puts a qualified motion reference in the draft', async () => {
  const api = mockApi({
    '/api/motion-effects': {
      sources: [
        {
          id: 'motion-prompt', name: 'Motion Prompt', version: 'pinned',
          effects: [{ id: '005', name: '遮罩显现', category: '动效', summary: '从遮罩后显现', aliases: ['Mask Reveal'], preview: '/preview/motion/005' }],
        },
        {
          id: 'other-motion', name: '另一套动效', version: '2.0.0',
          effects: [{ id: '005', name: '上浮', category: '动效', summary: '向上显现', renderer_skill: 'float' }],
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
  expect(props.onQuick).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/scene-003.*other-motion:005.*2\.0\.0[\s\S]*other-motion\/float/), [], true, true);
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
  mockApi({ '/api/motion-effects': {
    sources: [{ id: 'motion-prompt', name: 'Motion Prompt', version: 'pinned',
      effects: [{ id: '005', name: '遮罩显现', category: '动效', summary: '从遮罩后显现' }] }],
  } });
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
