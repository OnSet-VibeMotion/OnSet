// @vitest-environment jsdom
/// <reference types="node" />
/*
 * 工作台外框（app.tsx）：画面面板什么时候开、什么时候收（原 e2e/layout.spec.mjs），
 * 以及各处「在 Finder 中显示」交给 preload 的路径（原 e2e/reveal.spec.mjs）。
 *
 * 渲染整个 App，后端是一张按真实接口形状写的假表（打开着一个口播项目、一个还没出片的镜头）。
 * preload 的 window.onset 换成记录：reveal 记下交给主进程的路径，onMenu 让测试发原生菜单的动作。
 * reveal.ts 在模块加载时就看有没有 window.onset.reveal，所以先装好它再动态导入 App。
 *
 * jsdom 不排版，下面这些只在真窗口里量得出来，这里改成核对对应的状态与样式规则：
 * 对话正文限宽 760px、对话栏不窄于 420px、拖动分隔条后面板的像素宽度、窄窗口（1180px 以下）面板变成抽屉。
 * 主进程把相对路径换成绝对路径、只认项目里的路径，在 packages/engine/src/studio/reveal.test.ts。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentType } from 'react';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import type { MenuAction } from '../main';
import { mockApi, useFakeEventSource } from '../testing';
import type { AgentsResponse, Project, ProjectState, ProgressState, Scene, SetupStatus, TreeFile } from '../types';

const project: Project = { id: 'p1', path: '/Users/test/片场/讲复利', name: '讲复利' };
const scene: Scene = { id: 'scene-001', directory: 'scenes/scene-001', exists: false, stale: false, attempts: 0, duration_seconds: 4 };
const state: ProjectState = {
  project,
  metadata: { canvas: '1080x1440@30' },
  scenes: { total: 1, completed: 0, stale: 0 },
  flow: { id: 'speech', name: '口播', first_page: 'script', steps: ['script', 'storyboard', 'scene', 'final', 'publish'], hidden_pages: ['beat'], first_steps: ['script'], land_page: '' },
  pages: [
    { id: 'progress', label: '制作路线' }, { id: 'script', label: '口播稿' }, { id: 'storyboard', label: '分镜' }, { id: 'scene', label: '镜头' },
    { id: 'final', label: '成片' }, { id: 'publish', label: '发布' }, { id: 'file', label: '文件' },
  ],
};
const tree: TreeFile[] = [
  { path: 'notes.md', size: 12, mtime: 1 },
  { path: 'scenes/scene-001/scene.json', size: 80, mtime: 1 },
];
const agents: AgentsResponse = {
  agents: [{ id: 'claude', label: 'Claude Code', command: 'claude', installed: true, renderer: true }],
  orchestrator: 'claude', renderer: 'claude', orchestrator_model: '', renderer_model: '', global_renderer: 'claude',
};
const setup: SetupStatus = { ready: true, items: [], command: '' };
const route: ProgressState = { mode: 'speech', stations: [], current: '', waiting_on: '', turns: {} };

function backend() {
  return mockApi({
    '/api/projects': { projects: [project], current_project_id: 'p1', summaries: {}, default_parent: '/Users/test/片场' },
    '/api/agents': agents,
    '/api/setup': setup,
    '/api/skills': { status: { installed: true, installing: false } },
    '/api/state': state,
    '/api/scenes': { scenes: [scene] },
    '/api/tree': { files: tree },
    '/api/stations': { stations: [], problems: [] },
    '/api/progress': route,
    '/api/sessions': { sessions: [], busy: '' },
    '/api/tasks': { tasks: [] },
    '/api/styles': { canvases: [], modes: [] },
    '/api/files': { path: 'notes.md', content: '# 笔记', size: 12 },
  });
}

let App: ComponentType;
const revealed: [string, string | undefined][] = [];
let menu: ((action: MenuAction) => void) | null = null;

beforeAll(async () => {
  window.onset = {
    desktop: true,
    platform: 'darwin',
    reveal: async (path, projectId) => {
      revealed.push([path, projectId]);
      return '';
    },
    onMenu: (callback) => {
      menu = callback;
      return () => {
        if (menu === callback) menu = null;
      };
    },
  };
  ({ App } = await import('../app'));
});

beforeEach(() => {
  localStorage.clear();
  revealed.length = 0;
  useFakeEventSource();
});

async function openApp() {
  const api = backend();
  const view = render(<App />);
  await screen.findByRole('navigation', { name: '制作步骤' });
  await waitFor(() => expect(document.querySelector('.rail-scene[title="scene-001"]')).toBeTruthy());
  return { api, ...view };
}

const panel = () => document.getElementById('panel');
const takeRevealed = () => revealed.splice(0);
/** 面板宽度（工作区的百分比）；按比例算出来的小数不必逐位相等。 */
const panelWidth = () => parseFloat(document.querySelector<HTMLElement>('.workspace')!.style.getPropertyValue('--panel-w'));

test('the chat is the main column and the picture panel opens on demand', async () => {
  const user = userEvent.setup();
  await openApp();

  // 默认只有对话，右边是收起栏。
  expect(panel()).toBeNull();
  expect(document.querySelector('.panel-rail')).toBeTruthy();
  expect(document.querySelector('.workspace')!.classList.contains('panel-open')).toBe(false);
  expect(document.getElementById('panel-toggle')!.getAttribute('aria-pressed')).toBe('false');

  // 点步骤：打开面板并切到那一页。
  await user.click(document.querySelector<HTMLElement>('[data-tab="scene"]')!);
  expect(panel()).toBeTruthy();
  expect(panel()!.querySelector('.panel-title')!.textContent).toContain('镜头');
  expect(document.getElementById('panel-toggle')!.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.workspace')!.classList.contains('panel-open')).toBe(true);
  expect(document.querySelector('.panel-rail')).toBeNull();

  // × 收起；收起栏里点镜头再打开，标题带上镜头。
  await user.click(screen.getByRole('button', { name: '收起画面' }));
  expect(panel()).toBeNull();
  await user.click(document.querySelector<HTMLElement>('.rail-scene[title="scene-001"]')!);
  expect(panel()!.querySelector('.panel-sub')!.textContent).toBe('scene-001');

  // Esc 收起，输入框里按不算。
  const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
  prompt.focus();
  await user.keyboard('{Escape}');
  expect(panel()).toBeTruthy();
  await user.click(panel()!.querySelector<HTMLElement>('.panel-title')!);
  await user.keyboard('{Escape}');
  expect(panel()).toBeNull();

  // 菜单「显示或收起画面」（⌘\）。
  act(() => menu!({ type: 'panel' }));
  expect(panel()).toBeTruthy();
  // 开着与否记住：重新打开客户端还是开着。
  expect(localStorage.getItem('onset-studio.panel-open')).toBe('1');

  // 拖动分隔条：面板宽度按工作区比例记住；双击恢复默认。
  const workspace = document.querySelector<HTMLElement>('.workspace')!;
  const box = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900, x: 0, y: 0 };
  workspace.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
  const handle = document.querySelector<HTMLElement>('.panel-resize')!;
  handle.setPointerCapture = () => {};
  expect(panelWidth()).toBeCloseTo(58);
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600 });
  expect(document.body.classList.contains('resizing')).toBe(true);
  // 拖得太宽也给对话留 420px。
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
  expect(panelWidth()).toBeCloseTo(((1440 - 420) / 1440) * 100);
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 432 });
  expect(panelWidth()).toBeCloseTo(70);
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(document.body.classList.contains('resizing')).toBe(false);
  expect(Number(localStorage.getItem('onset-studio.panel-width:media'))).toBeCloseTo(0.7);
  fireEvent.doubleClick(handle);
  expect(panelWidth()).toBeCloseTo(58);
  expect(localStorage.getItem('onset-studio.panel-width:media')).toBe('0.58');
  // 读文字的页面宽度另记：切到口播稿是默认的 45%。
  await user.click(document.querySelector<HTMLElement>('[data-tab="script"]')!);
  expect(panelWidth()).toBeCloseTo(45);

  // 窄窗口里面板是盖在对话上的抽屉：对话没被挤走，输入框还在；点遮罩收起。
  expect(document.getElementById('prompt')).toBeTruthy();
  await user.click(document.querySelector<HTMLElement>('.panel-scrim')!);
  expect(panel()).toBeNull();
  expect(document.getElementById('prompt')).toBeTruthy();
});

test('the layout rules behind the chat column and the drawer are in place', () => {
  // 只有真窗口量得出的几条（原 e2e 量的是像素），这里守住样式规则。
  const css = readFileSync(join(import.meta.dirname, '../styles.css'), 'utf8') + readFileSync(join(import.meta.dirname, '../chat.css'), 'utf8');
  // 对话正文限宽 760px。
  expect(css).toMatch(/--gutter[^;]*760px/);
  // 窄窗口：收起栏不显示，面板盖在对话上、有遮罩。
  const narrow = /@media \(max-width: 1180px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  expect(narrow).toMatch(/\.panel-rail[^{]*\{[^}]*display:\s*none/);
  expect(narrow).toMatch(/\.panel-scrim[^{]*\{[^}]*display:\s*block/);
});

test('shows the project, a scene, files and a recent project in Finder', async () => {
  const user = userEvent.setup();
  await openApp();

  // 顶栏的文件夹按钮：打开项目文件夹（空路径是项目文件夹）。
  await user.click(screen.getByRole('button', { name: '在 Finder 中打开项目文件夹' }));
  expect(takeRevealed()).toEqual([['', undefined]]);

  // 菜单「在 Finder 中显示项目」（⌥⌘R）。
  act(() => menu!({ type: 'reveal' }));
  await waitFor(() => expect(takeRevealed()).toEqual([['', undefined]]));

  // 镜头还没出片：选中镜头目录。
  await user.click(document.querySelector<HTMLElement>('[data-tab="scene"]')!);
  await user.click(await waitFor(() => panel()!.querySelector<HTMLElement>('.scene-menu summary')!));
  await user.click(await waitFor(() => document.getElementById('reveal-scene')!));
  expect(takeRevealed()).toEqual([['scenes/scene-001', undefined]]);

  // 右键文件：选中那个文件。
  await user.click(document.getElementById('page-menu-trigger')!);
  await user.click(document.querySelector<HTMLElement>('.page-menu-list [data-tab="file"]')!);
  const row = await waitFor(() => panel()!.querySelector<HTMLElement>('[data-ctx-file="notes.md"]')!);
  fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
  await user.click(within(document.querySelector<HTMLElement>('.ctx-menu')!).getByRole('menuitem', { name: '在 Finder 中显示' }));
  expect(takeRevealed()).toEqual([['notes.md', undefined]]);

  // 文件页工具栏。
  await user.click(row);
  await user.click(await waitFor(() => document.getElementById('reveal-file')!));
  expect(takeRevealed()).toEqual([['notes.md', undefined]]);

  // 首页最近项目：按项目 id 打开那个项目的文件夹。
  await user.click(screen.getByRole('button', { name: '回到首页' }));
  await user.click(await screen.findByRole('button', { name: `在 Finder 中打开 ${project.name}` }));
  expect(takeRevealed()).toEqual([['', 'p1']]);
});
