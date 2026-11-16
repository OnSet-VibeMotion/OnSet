// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mockApi, type MockRequest } from '../testing';
import type { AgentsResponse, Attachment, StylesResponse } from '../types';
import { Home } from './Home';

// 首页拖进文件夹：浏览器给的是 FileSystemEntry（目录要分批 readEntries 读到空批次才算完）。
// 这里用假的 entry 代替 Chromium 原生拖拽；上传之后文件在磁盘上怎么落（嵌套、空目录、空文件）由
// packages/engine/src/studio/uploads.test.ts 管，这里只看界面交给后端的请求。

type Node = { name: string; children?: Node[]; content?: string };

function entryOf(node: Node): FileSystemEntry {
  if (!node.children) {
    return {
      name: node.name,
      isFile: true,
      isDirectory: false,
      file: (resolve: (file: File) => void) => resolve(new File([node.content ?? ''], node.name)),
    } as unknown as FileSystemEntry;
  }
  const children = node.children.map(entryOf);
  return {
    name: node.name,
    isFile: false,
    isDirectory: true,
    // 照 Chromium：一次最多给 100 项，读到空批次为止。
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (resolve: (batch: FileSystemEntry[]) => void) => {
          const batch = children.slice(offset, offset + 100);
          offset += batch.length;
          resolve(batch);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

function dropFolder(folder: Node) {
  const entry = entryOf(folder);
  const dataTransfer = {
    types: ['Files'],
    files: [new File([''], folder.name)],
    items: [{ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null }],
  };
  const card = document.querySelector('.home .input-card')!;
  fireEvent.dragOver(card, { dataTransfer });
  fireEvent.drop(card, { dataTransfer });
}

const agents: AgentsResponse = {
  agents: [{ id: 'claude', label: 'Claude Code', command: 'claude', installed: true, renderer: true }],
  orchestrator: 'claude',
  renderer: 'claude',
  orchestrator_model: '',
  renderer_model: '',
  global_renderer: 'claude',
};

const styles: StylesResponse = {
  canvases: [{ id: 'vertical-3x4', label: '3:4 竖屏', width: 1080, height: 1440, orientation: 'portrait' }],
  default_canvas: 'vertical-3x4',
  modes: [{ id: 'speech', label: '口播讲解', hint: '配音 + 动画，最常用', delivery: 'speech', narration: 'solo' }],
};

beforeEach(() => {
  // 开机画面按「减少动态效果」走，几段停顿都缩短。
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

test('home imports dropped folders as references, preserves nested files', async () => {
  const uploads: Attachment[][] = [
    [{ upload: true, path: 'production/studio/uploads/20261117-文章.md', name: '文章.md', size: 15 }],
    [{ ref: true, source: 'production/studio/uploads/20261117-参考 素材-ab12', label: '文件夹「参考 素材」' }],
  ];
  const backend = mockApi({
    '/api/styles': styles,
    '/api/setup': { ready: true, items: [], command: '' },
    '/api/skills': { status: { installed: true, installing: false } },
    'POST /api/projects/name': { name: '参考素材的片子', naming: 'n1' },
    'POST /api/projects/create': (req: MockRequest) => ({ project: { id: 'p2', name: (req.body as { name: string }).name, path: '/home/u/片场/参考素材的片子' } }),
    'POST /api/uploads': () => ({ attachments: uploads.shift() }),
    'POST /api/production/start': { session_id: 's1' },
  });
  const onStarted = vi.fn(async () => {});
  const user = userEvent.setup();
  render(
    <Home projects={[]} summaries={{}} defaultParent="/home/u/片场" currentId="" agents={agents} onOpen={async () => {}} onRemove={async () => {}} onBrowse={() => {}} onStarted={onStarted} />,
  );
  const send = () => document.querySelector<HTMLButtonElement>('#home-send')!;
  const tray = () => document.querySelector('.home-tray');

  // 目录分批读取：105 个文件一个不少。
  const batch: Node = { name: '批量素材', children: Array.from({ length: 105 }, (_, i) => ({ name: `素材-${i}.txt`, content: 'text' })) };
  dropFolder(batch);
  expect(await screen.findByRole('list', { name: '引用素材' })).toHaveProperty('textContent', expect.stringContaining('105 个文件'));
  expect(send().disabled).toBe(false);

  // 拖进带 .env 的目录（各种大小写、嵌套）整批拒收，已有的引用不动，输入框照常可用。
  for (const secret of [['.env'], ['.ENV'], ['.Env.local'], ['nested', '.ENV.local']]) {
    const withSecret: Node = {
      ...batch,
      children: [
        ...batch.children!,
        secret.length === 1 ? { name: secret[0], content: 'SECRET=test' } : { name: secret[0], children: [{ name: secret[1], content: 'SECRET=test' }] },
      ],
    };
    dropFolder(withSecret);
    await waitFor(() => expect(document.querySelector('.home')!.textContent).toContain('.env 不能上传'));
    expect(tray()!.querySelectorAll('li')).toHaveLength(1);
    expect(send().disabled).toBe(false);
  }

  // 还没发送的文件夹引用可以移除（空文件夹同样算一个引用）。
  await user.click(within(tray() as HTMLElement).getByRole('button', { name: '移除' }));
  expect(tray()).toBeNull();
  dropFolder({ name: '空素材', children: [] });
  await waitFor(() => expect(tray()?.textContent).toContain('文件夹'));
  await user.click(within(tray() as HTMLElement).getByRole('button', { name: '移除' }));
  expect(tray()).toBeNull();

  // 普通文件上传与文件夹引用一起带上。
  await user.upload(document.querySelector<HTMLInputElement>('.home input[type="file"]')!, new File(['# 上传文章'], '文章.md', { type: 'text/markdown' }));
  await waitFor(() => expect(tray()?.textContent).toContain('文章.md'));
  dropFolder({
    name: '参考 素材',
    children: [
      { name: '子目录', children: [{ name: '讲稿.md', content: '# 子讲稿' }] },
      { name: '空目录', children: [] },
      { name: '讲稿.md', content: '# 根讲稿' },
      { name: 'empty.txt', content: '' },
    ],
  });
  await waitFor(() => expect(tray()?.textContent).toContain('参考 素材'));
  expect(tray()!.textContent).toContain('文件夹');
  expect(tray()!.textContent).toContain('3 个文件');
  expect(tray()!.textContent).toContain('文章.md');

  await user.type(document.querySelector<HTMLTextAreaElement>('#home-prompt')!, '参考这些素材制作视频');
  await user.click(send());
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith('p2', 's1'), { timeout: 8000 });

  // 先建项目，再按素材顺序上传：普通文件一个字段；文件夹带名字头，保留相对路径、空目录与空文件。
  const create = backend.calls.find((c) => c.path === '/api/projects/create')!;
  expect(create.body).toMatchObject({ parent: '/home/u/片场', canvas: 'vertical-3x4', delivery: 'speech', naming: 'n1' });
  expect((create.body as { name: string }).name).toMatch(/^参考素材的片子-\d{4}$/);
  const order = backend.calls.map((c) => c.path).filter((p) => p !== '/api/styles' && p !== '/api/setup');
  expect(order.indexOf('/api/projects/create')).toBeLessThan(order.indexOf('/api/uploads'));
  const uploadInits = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/uploads').map(([, init]) => init!);
  expect(uploadInits).toHaveLength(2);
  const article = uploadInits[0].body as FormData;
  expect([...article.keys()]).toEqual(['file']);
  expect(await (article.get('file') as File).text()).toBe('# 上传文章');
  expect((uploadInits[1].headers as Record<string, string>)['X-Onset-Upload-Directory']).toBe(encodeURIComponent('参考 素材'));
  const folder = uploadInits[1].body as FormData;
  const fields = Object.fromEntries([...folder.entries()].map(([key, value]) => [decodeURIComponent(key), value]));
  expect(Object.keys(fields).sort()).toEqual(['directory:', 'directory:子目录', 'directory:空目录', 'file:empty.txt', 'file:子目录/讲稿.md', 'file:讲稿.md'].sort());
  expect(await (fields['file:讲稿.md'] as File).text()).toBe('# 根讲稿');
  expect(await (fields['file:子目录/讲稿.md'] as File).text()).toBe('# 子讲稿');
  // 空文件与目录标记用空字符串字段（空 Blob 在 Electron 自定义协议里读不出来）。
  expect(fields['file:empty.txt']).toBe('');
  expect(fields['directory:空目录']).toBe('');

  // 开工时把两份上传回来的引用都交给编排工具。
  const start = backend.calls.find((c) => c.path === '/api/production/start')!;
  expect(start.body).toEqual({
    message: '参考这些素材制作视频',
    tool: 'claude',
    attachments: [
      { upload: true, path: 'production/studio/uploads/20261117-文章.md', name: '文章.md', size: 15 },
      { ref: true, source: 'production/studio/uploads/20261117-参考 素材-ab12', label: '文件夹「参考 素材」' },
    ],
  });
  expect(backend.unmatched).toEqual([]);
}, 15000);
