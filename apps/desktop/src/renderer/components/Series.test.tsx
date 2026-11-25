// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type MockRequest, mockApi, reply } from '../testing';
import type { AgentsResponse, Project, SeriesItem, StylesResponse } from '../types';
import { Home } from './Home';
import { SeriesAssetsPanel } from './series/SeriesAssetsPanel';
import { SeriesModal } from './series/SeriesModal';

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

test('SeriesModal AI assist generates draft, refines, fills & undoes, and submits publish_template', async () => {
  const assistCalls: Record<string, unknown>[] = [];
  let createdPayload: Record<string, unknown> | null = null;
  mockApi({
    '/api/voices': { voices: [{ name: '沉稳男声' }, { name: '主理人' }] },
    '/api/film-styles': {
      sources: [],
      styles: [
        {
          source: 'lemo',
          slug: 'cyber-grid',
          order: 1,
          cn: '赛博网格',
          en: 'Cyber Grid',
          category_cn: '科技',
          category_en: 'Tech',
          uses: [],
          summary: '暗色网格',
        },
      ],
    },
    'POST /api/series/assist': (req: MockRequest) => {
      const body = req.body as Record<string, unknown>;
      assistCalls.push(body);
      if (body.mode === 'draft') {
        return {
          mode: 'draft',
          name: '架构硬核拆解',
          description: '每周一条 3 分钟原理动画科普',
          naming_pattern: 'EP{nn}-{title}',
          defaults: {
            canvas: 'landscape-16x9',
            delivery: 'speech',
            narration: 'solo',
            film_style: 'lemo/cyber-grid',
            tts_voice: '沉稳男声',
          },
          brief: '## 口播\n- 开头 3 秒抛结论',
          publish_template: {
            title_pattern: '【EP{nn}】{title}',
            default_hashtags: ['#架构科普', '#硬核拆解'],
            cover_guidelines: '暗色网格 + 左上角期号角标',
            description_footer: '订阅专栏每周更新',
          },
          rationale: '16:9 横屏配合赛博网格适合展示技术原理图。',
          followups: ['改竖屏短视频', '更口语轻松'],
          warnings: [],
          tool: 'claude',
          model: 'haiku',
        };
      }
      return {
        mode: 'refine',
        name: '轻松讲原理',
        description: '更口语轻松的 B 站横屏科普',
        naming_pattern: 'EP{nn}-{title}',
        defaults: {
          canvas: 'landscape-16x9',
          delivery: 'speech',
          narration: 'solo',
          film_style: 'lemo/cyber-grid',
          tts_voice: '主理人',
        },
        brief: '## 口播\n- 像聊天一样讲清技术原理',
        publish_template: {
          title_pattern: '【EP{nn}】{title}',
          default_hashtags: ['#轻松科普'],
          cover_guidelines: '大字主标题 + 柔和渐变底',
          description_footer: '欢迎评论区点题',
        },
        rationale: '按要求调松口吻并换用主理人音色。',
        followups: ['加结尾彩蛋'],
        warnings: [],
        tool: 'claude',
        model: 'haiku',
      };
    },
    'POST /api/series': (req: MockRequest) => {
      createdPayload = req.body as Record<string, unknown>;
      return { ...sampleSeries, id: 'new-series', name: String(createdPayload.name) };
    },
  });

  const onSaved = vi.fn(async () => {});
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <SeriesModal
      initial={null}
      styles={styles}
      modes={styles.modes}
      defaultParent="/home/u/Videos"
      projects={[]}
      summaries={{}}
      onSaved={onSaved}
      onDeleted={async () => {}}
      onClose={onClose}
    />,
  );

  // 先手动输入一个原专栏名，验证后续「撤回 AI 填充」能完整恢复
  const nameInput = screen.getByLabelText('专栏名称') as HTMLInputElement;
  await user.type(nameInput, '手写原名');

  // 输入一句话并点击「AI 生成草案」
  await user.type(screen.getByLabelText('用一句话描述你想做的专栏'), 'B 站横屏技术原理科普');
  await user.click(screen.getByRole('button', { name: 'AI 生成草案' }));

  const preview = await screen.findByRole('region', { name: 'AI 草案预览' });
  expect(preview.textContent).toContain('架构硬核拆解');
  expect(preview.textContent).toContain('16:9 横屏配合赛博网格适合展示技术原理图。');
  expect(assistCalls[0]).toMatchObject({ mode: 'draft', idea: 'B 站横屏技术原理科普' });

  // 点击快捷建议 chip 触发第二轮润色
  await user.click(within(preview).getByRole('button', { name: '更口语轻松' }));
  await waitFor(() => expect(preview.textContent).toContain('轻松讲原理'));
  expect(assistCalls[1]).toMatchObject({ mode: 'refine', instruction: '更口语轻松' });

  // 点击「一键回填表单」：表单全部更新，且发布模板 Tab 标出「已填」
  await user.click(within(preview).getByRole('button', { name: '一键回填表单' }));
  expect(nameInput.value).toBe('轻松讲原理');
  expect(screen.getByRole('tab', { name: '发布模板 · 已填' })).toBeTruthy();

  // 点击「撤回 AI 填充」：完整恢复手写原名
  await user.click(screen.getByRole('button', { name: '撤回 AI 填充' }));
  expect(nameInput.value).toBe('手写原名');

  // 再次回填并提交新建，验证 POST /api/series 带上 publish_template
  await user.click(within(preview).getByRole('button', { name: '一键回填表单' }));
  await user.click(screen.getByRole('button', { name: '创建专栏' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(createdPayload).toMatchObject({
    name: '轻松讲原理',
    defaults: { canvas: 'landscape-16x9', film_style: 'lemo/cyber-grid', tts_voice: '主理人' },
    publish_template: {
      title_pattern: '【EP{nn}】{title}',
      default_hashtags: ['#轻松科普'],
      cover_guidelines: '大字主标题 + 柔和渐变底',
      description_footer: '欢迎评论区点题',
    },
  });
});

test('SeriesModal AI assist handles cancel, errors without losing manual input, and independent brief polish', async () => {
  let resolveSlow!: (v: unknown) => void;
  let cancelCalled = false;
  let failNext = false;
  mockApi({
    '/api/voices': { voices: [] },
    'POST /api/series/assist': (req: MockRequest) => {
      const body = req.body as Record<string, unknown>;
      if (body.mode === 'polish_brief') {
        if (failNext) return reply(502, { code: 'series_assist_failed', message: '没有配置可用的 AI 工具' });
        return {
          mode: 'polish_brief',
          defaults: {},
          brief: '## 润色后的规范\n- 开头三秒直接给结论\n- 严禁营销话术',
          rationale: '已整理为结构化条目并保留禁区。',
          followups: [],
          warnings: [],
        };
      }
      if (body.idea === '触发错误') {
        return reply(502, { code: 'series_assist_failed', message: '模型超时，请稍后再试' });
      }
      return new Promise((resolve) => {
        resolveSlow = resolve;
      });
    },
    'DELETE /api/series/assist': () => {
      cancelCalled = true;
      return { ok: true };
    },
  });

  const user = userEvent.setup();
  render(
    <SeriesModal
      initial={null}
      styles={styles}
      modes={styles.modes}
      defaultParent="/home/u/Videos"
      projects={[]}
      summaries={{}}
      onSaved={async () => {}}
      onDeleted={async () => {}}
      onClose={() => {}}
    />,
  );

  // 手动填写专栏名称
  const nameInput = screen.getByLabelText('专栏名称') as HTMLInputElement;
  await user.type(nameInput, '不要丢掉我的手填名称');

  // 1) 触发取消：显示取消按钮，点击后调用 DELETE /api/series/assist，手填名称不变
  const ideaInput = screen.getByLabelText('用一句话描述你想做的专栏');
  await user.type(ideaInput, '慢请求测试');
  await user.click(screen.getByRole('button', { name: 'AI 生成草案' }));
  await screen.findByText('正在根据描述生成专栏草案…');
  const aiBox = screen.getByRole('region', { name: 'AI 专栏助手' });
  await user.click(within(aiBox).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(cancelCalled).toBe(true));
  expect(nameInput.value).toBe('不要丢掉我的手填名称');
  resolveSlow?.({});

  // 2) 触发失败：弹出友好中文错误，手填名称不变
  await user.clear(ideaInput);
  await user.type(ideaInput, '触发错误');
  await user.click(screen.getByRole('button', { name: 'AI 生成草案' }));
  expect(await screen.findByText('模型超时，请稍后再试')).toBeTruthy();
  expect(nameInput.value).toBe('不要丢掉我的手填名称');

  // 3) 切到「专栏规范」Tab：独立润色 + 撤回上版 + 失败不丢原文
  await user.click(screen.getByRole('tab', { name: '专栏规范' }));
  const briefArea = screen.getByLabelText('专栏视觉与口播规范（brief.md）') as HTMLTextAreaElement;
  await user.type(briefArea, '开头别废话，不要营销词');

  await user.click(screen.getByRole('button', { name: 'AI 润色规范' }));
  await waitFor(() => expect(briefArea.value).toContain('## 润色后的规范'));
  expect(screen.getByText(/已润色规范：已整理为结构化条目/)).toBeTruthy();

  // 撤回上版恢复原文
  await user.click(screen.getByRole('button', { name: '撤回上版' }));
  expect(briefArea.value).toBe('开头别废话，不要营销词');

  // 润色失败时报错且绝不清空原文
  failNext = true;
  await user.click(screen.getByRole('button', { name: 'AI 润色规范' }));
  expect(await screen.findByText('没有配置可用的 AI 工具')).toBeTruthy();
  expect(briefArea.value).toBe('开头别废话，不要营销词');
});

test('SeriesModal displays, adds, removes and saves defaults.motion_effects', async () => {
  let savedPayload: Record<string, unknown> | null = null;
  mockApi({
    '/api/voices': { voices: [{ name: '主理人' }] },
    '/api/motion-effects': {
      sources: [
        {
          id: 'motion-prompt',
          name: 'Motion Prompt',
          version: 'pinned',
          effects: [
            { id: '005', name: '遮罩显现', category: '动态图形', summary: '遮罩显现' },
            { id: '007', name: '数字递增', category: '动态图形', summary: '数字递增' },
          ],
        },
      ],
    },
    'PUT /api/series/ai-explainer': (req: MockRequest) => {
      savedPayload = req.body as Record<string, unknown>;
      return { ...sampleSeries, defaults: { ...sampleSeries.defaults, motion_effects: ['motion-prompt:007'] } };
    },
  });

  const user = userEvent.setup();
  render(
    <SeriesModal
      initial={{
        ...sampleSeries,
        defaults: { ...sampleSeries.defaults, motion_effects: ['motion-prompt:005'] },
      }}
      styles={styles}
      modes={styles.modes}
      defaultParent="/home/u/Videos"
      projects={[]}
      summaries={{}}
      onSaved={async () => {}}
      onDeleted={async () => {}}
      onClose={() => {}}
    />,
  );

  await user.click(screen.getByRole('tab', { name: '开片预设' }));
  expect(await screen.findByText('005 遮罩显现')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: '+ 添加常用动效' }));
  await user.selectOptions(screen.getByLabelText('选择常用动效'), 'motion-prompt:007');
  expect(screen.getByText('007 数字递增')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: '移除常用动效 motion-prompt:005' }));
  await user.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(savedPayload).not.toBeNull());
  expect(savedPayload).toMatchObject({
    defaults: { motion_effects: ['motion-prompt:007'] },
  });
});
