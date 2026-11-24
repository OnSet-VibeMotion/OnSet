// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type MockRequest, mockApi } from '../testing';
import type { AgentsResponse, Project, SeriesItem, StylesResponse } from '../types';
import { Home } from './Home';
import { SeriesAssetsPanel } from './series/SeriesAssetsPanel';

const agents: AgentsResponse = {
  agents: [{ id: 'claude', label: 'Claude Code', command: 'claude', installed: true, renderer: true }],
  orchestrator: 'claude',
  renderer: 'claude',
  orchestrator_model: '',
  renderer_model: '',
  global_renderer: 'claude',
};

const styles: StylesResponse = {
  canvases: [
    { id: 'vertical-3x4', label: '3:4 竖屏', width: 1080, height: 1440, orientation: 'portrait' },
    { id: 'landscape-16x9', label: '16:9 横屏', width: 1920, height: 1080, orientation: 'landscape' },
  ],
  default_canvas: 'vertical-3x4',
  modes: [{ id: 'speech', label: '口播讲解', hint: '配音 + 动画，最常用', delivery: 'speech', narration: 'solo' }],
};

const sampleSeries: SeriesItem = {
  schema: 1,
  id: 'ai-explainer',
  name: 'AI 硬核拆解',
  description: '每周一条底层原理解析',
  parent_dir: '/home/u/Videos/ai-explainer',
  naming_pattern: 'EP{nn}-{title}',
  next_episode: 3,
  defaults: { canvas: 'landscape-16x9', delivery: 'speech', narration: 'solo', tts_voice: '主理人' },
  brief: '开头三秒抛结论。',
  project_count: 1,
  created_at: '2026-11-24T00:00:00.000Z',
  updated_at: '2026-11-24T00:00:00.000Z',
};

const projects: Project[] = [
  {
    id: 'p1',
    name: 'EP01-Transformer',
    path: '/home/u/Videos/ai-explainer/EP01-Transformer',
    last_opened_at: '2026-11-24T01:00:00Z',
    series_id: 'ai-explainer',
    episode: 1,
  },
  {
    id: 'p2',
    name: '独立随笔',
    path: '/home/u/Videos/独立随笔',
    last_opened_at: '2026-11-24T02:00:00Z',
  },
];

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));
});
afterEach(() => vi.restoreAllMocks());

test('home groups projects by series and creates next episode with series preset', async () => {
  let createdBody: Record<string, unknown> | null = null;
  mockApi({
    '/api/styles': styles,
    '/api/setup': { ready: true, items: [], command: '' },
    '/api/skills': { status: { installed: true, installing: false } },
    '/api/series': { dir: '/tmp/series', series: [sampleSeries] },
    '/api/voices': { voices: [{ name: '主理人' }] },
    'POST /api/projects/name': { name: '注意机制', naming: 'n1' },
    'POST /api/projects/create': (req: MockRequest) => {
      createdBody = req.body as Record<string, unknown>;
      return {
        project: {
          id: 'p3',
          name: String(createdBody.name),
          path: `/home/u/Videos/ai-explainer/${String(createdBody.name)}`,
          series_id: 'ai-explainer',
          episode: 3,
        },
      };
    },
    'POST /api/production/start': { session_id: 's3' },
  });

  const onStarted = vi.fn(async () => {});
  const user = userEvent.setup();
  render(
    <Home
      projects={projects}
      summaries={{}}
      defaultParent="/home/u/Videos"
      currentId=""
      agents={agents}
      onOpen={async () => {}}
      onRemove={async () => {}}
      onBrowse={() => {}}
      onStarted={onStarted}
    />,
  );

  // 左侧栏显示专栏分组与 EP01 徽章，以及独立项目分区。
  const nav = screen.getByRole('navigation', { name: '项目' });
  expect(await within(nav).findByText('AI 硬核拆解')).toBeTruthy();
  expect(within(nav).getByText('EP01')).toBeTruthy();
  expect(within(nav).getByText('独立项目')).toBeTruthy();

  // 点击「在专栏新建下一期」：上下文条出现且带入第 3 期与横屏画幅。
  await user.click(within(nav).getByRole('button', { name: '在「AI 硬核拆解」新建下一期' }));
  const ctxBar = await screen.findByRole('region', { name: '当前专栏' });
  expect(ctxBar.textContent).toContain('AI 硬核拆解');
  expect((within(ctxBar).getByLabelText('本期期号') as HTMLInputElement).value).toBe('3');

  // 输入选题并发送，检查 create 请求自动带上专栏 ID、期号、横屏画幅、专栏父目录与 EP03- 命名。
  await user.type(screen.getByLabelText('想做什么视频'), '讲清自注意力机制');
  await user.click(screen.getByRole('button', { name: '开始制作' }));

  await waitFor(() => expect(onStarted).toHaveBeenCalledWith('p3', 's3'));
  expect(createdBody).toMatchObject({
    parent: '/home/u/Videos/ai-explainer',
    name: 'EP03-注意机制',
    canvas: 'landscape-16x9',
    series_id: 'ai-explainer',
    episode: 3,
  });
});

test('binds an existing standalone project to a series in place', async () => {
  let bindPayload: Record<string, unknown> | null = null;
  mockApi({
    '/api/styles': styles,
    '/api/setup': { ready: true, items: [], command: '' },
    '/api/series': { dir: '/tmp/series', series: [sampleSeries] },
    'POST /api/series/ai-explainer/bind': (req: MockRequest) => {
      bindPayload = req.body as Record<string, unknown>;
      return { project: { ...projects[1], series_id: 'ai-explainer', episode: 2 } };
    },
  });

  const onProjectsChanged = vi.fn(async () => {});
  const user = userEvent.setup();
  render(
    <Home
      projects={projects}
      summaries={{}}
      defaultParent="/home/u/Videos"
      currentId=""
      agents={agents}
      onOpen={async () => {}}
      onRemove={async () => {}}
      onProjectsChanged={onProjectsChanged}
      onBrowse={() => {}}
      onStarted={async () => {}}
    />,
  );

  await screen.findByText('AI 硬核拆解');
  await user.click(screen.getByRole('button', { name: '设置 独立随笔 的专栏归属' }));
  const dialog = await screen.findByRole('dialog', { name: '设置专栏归属：独立随笔' });
  await user.type(within(dialog).getByLabelText(/期号/), '2');
  await user.click(within(dialog).getByRole('button', { name: '确定' }));

  await waitFor(() => expect(onProjectsChanged).toHaveBeenCalled());
  expect(bindPayload).toEqual({ project_id: 'p2', episode: 2 });
});

test('SeriesAssetsPanel syncs series updates, promotes candidates, and saves publish template', async () => {
  let syncBody: Record<string, unknown> | null = null;
  let promoteBody: Record<string, unknown> | null = null;
  let tplBody: Record<string, unknown> | null = null;
  mockApi({
    '/api/series/ai-explainer/assets': {
      series_id: 'ai-explainer',
      assets: [],
      publish_template: { schema: 1, title_pattern: '【EP{nn}】{title}', default_hashtags: ['#科普'], updated_at: '' },
      current_project_bound: true,
      sync_status: [
        {
          key: 'bumper:intro',
          kind: 'bumper',
          name: 'intro',
          target_path: 'assets/series/bumpers/intro',
          digest: 'abc',
          files: 1,
          bytes: 1024,
          bumper_mode: 'template',
          status: 'update_available',
          local_digest: 'old',
          synced_digest: 'old',
        },
      ],
      project_candidates: [{ kind: 'shared', name: 'brand-badge', from: 'production/shared/brand-badge' }],
    },
    'POST /api/series/project/sync': (req: MockRequest) => {
      syncBody = req.body as Record<string, unknown>;
      return { result: { key: 'bumper:intro', unchanged: false } };
    },
    'POST /api/series/project/promote': (req: MockRequest) => {
      promoteBody = req.body as Record<string, unknown>;
      return { result: { key: 'shared:brand-badge', replaced: false } };
    },
    'PUT /api/series/ai-explainer/publish-template': (req: MockRequest) => {
      tplBody = req.body as Record<string, unknown>;
      return { series_id: 'ai-explainer', publish_template: tplBody };
    },
  });

  const onSynced = vi.fn();
  const user = userEvent.setup();
  render(
    <SeriesAssetsPanel
      seriesId="ai-explainer"
      seriesName="AI 硬核拆解"
      episode="3"
      onSynced={onSynced}
      onClose={() => {}}
    />,
  );

  // 拉取片头模板更新
  expect(await screen.findByText('HTML 模板')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '拉取' }));
  await waitFor(() => expect(onSynced).toHaveBeenCalled());
  expect(syncBody).toEqual({ kind: 'bumper', name: 'intro', replace: false });

  // 切到「沉淀回专栏」一键沉淀候选组件
  await user.click(screen.getByRole('tab', { name: '沉淀回专栏' }));
  await user.click(screen.getByRole('button', { name: '沉淀到专栏' }));
  await waitFor(() => expect(promoteBody).not.toBeNull());
  expect(promoteBody).toEqual({
    kind: 'shared',
    name: 'brand-badge',
    from: 'production/shared/brand-badge',
    replace: false,
  });

  // 切到「发布模板」保存
  await user.click(screen.getByRole('tab', { name: '发布模板' }));
  await user.click(screen.getByRole('button', { name: '保存发布模板' }));
  await waitFor(() => expect(tplBody).not.toBeNull());
  expect(tplBody).toMatchObject({ title_pattern: '【EP{nn}】{title}', default_hashtags: ['#科普'] });
});
