// @vitest-environment jsdom
/*
 * 客户端更新（Updates.tsx）：状态从 preload 的桥来（main/updater.ts），这里换成一个假桥。
 * 真的检查、下载与重启装只有打包好的客户端做得了，由 release.yml 的手动运行与真机验证。
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../types';
import { UpdatePanel, sizeText, updateNeedsAttention, useUpdateState } from './Updates';

const base = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: 'idle',
  current: '2.1.0',
  version: '',
  notes: '',
  released_at: '',
  percent: 0,
  transferred: 0,
  total: 0,
  bytes_per_second: 0,
  error: '',
  disabled_reason: '',
  checked_at: '',
  release_url: 'https://github.com/OnSet-VibeMotion/OnSet/releases/latest',
  ...over,
});

function bridge(initial: UpdateState, install: (force?: boolean) => { ok: boolean; busy?: string[] } = () => ({ ok: true })) {
  let listener: ((s: UpdateState) => void) | null = null;
  const actions: [string, boolean | undefined][] = [];
  window.onset = {
    desktop: true,
    platform: 'darwin',
    updateState: async () => initial,
    onUpdate: (cb) => {
      listener = cb;
      return () => (listener = null);
    },
    updateAction: async (action, force) => {
      actions.push([action, force]);
      return action === 'install' ? install(force) : { ok: true };
    },
  };
  return { actions, push: (s: UpdateState) => act(() => listener?.(s)) };
}

function Harness() {
  return <UpdatePanel state={useUpdateState()} />;
}

afterEach(() => {
  delete window.onset;
  vi.restoreAllMocks();
});

describe('版本更新', () => {
  it('查到新版本先问，下载有进度，下好了才给重启', async () => {
    const user = userEvent.setup();
    const b = bridge(base({ status: 'latest', checked_at: new Date().toISOString() }));
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已是最新版本'));
    await user.click(screen.getByRole('button', { name: '检查更新' }));
    expect(b.actions).toEqual([['check', undefined]]);

    b.push(base({ status: 'available', version: '2.2.0', notes: '· 插件中心\n· 自动更新' }));
    expect(screen.getByRole('status').textContent).toBe('有新版本 2.2.0');
    // 不自动下载：等用户点。
    expect(screen.queryByRole('button', { name: '重启并安装' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '这一版改了什么' }));
    expect(document.querySelector('.update-notes pre')?.textContent).toContain('插件中心');
    await user.click(screen.getByRole('button', { name: '下载' }));
    expect(b.actions.at(-1)).toEqual(['download', undefined]);

    b.push(base({ status: 'downloading', version: '2.2.0', percent: 40, transferred: 80 * 1024 * 1024, total: 200 * 1024 * 1024, bytes_per_second: 2 * 1024 * 1024 }));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
    expect(document.querySelector('.update-progress')?.textContent).toContain('80.0 MB / 200.0 MB · 2.0 MB/s');

    b.push(base({ status: 'downloaded', version: '2.2.0', percent: 100 }));
    await user.click(screen.getByRole('button', { name: '重启并安装' }));
    expect(b.actions.at(-1)).toEqual(['install', false]);
  });

  it('重启会打断正在做的事时先列出来，用户说仍然重启才装', async () => {
    const user = userEvent.setup();
    const b = bridge(base({ status: 'downloaded', version: '2.2.0' }), (force) => (force ? { ok: true } : { ok: false, busy: ['讲解 A：一轮对话'] }));
    render(<Harness />);
    await user.click(await screen.findByRole('button', { name: '重启并安装' }));
    const confirm = await screen.findByRole('alertdialog', { name: '重启会打断正在做的事' });
    expect(confirm.textContent).toContain('讲解 A：一轮对话');
    await user.click(within(confirm).getByRole('button', { name: '等会儿' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: '重启并安装' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '仍然重启' }));
    expect(b.actions.filter(([a]) => a === 'install')).toEqual([
      ['install', false],
      ['install', false],
      ['install', true],
    ]);
  });

  it('出错说清原因、给重试与发布页；关掉时说为什么', async () => {
    const user = userEvent.setup();
    const b = bridge(base({ status: 'error', version: '2.2.0', error: '连不上更新服务器。可以在「网络与更新」里填代理' }));
    const { unmount } = render(<Harness />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('连不上更新服务器');
    await user.click(screen.getByRole('button', { name: '重试下载' }));
    await user.click(within(alert).getByRole('button', { name: '去发布页下载' }));
    expect(b.actions).toEqual([
      ['download', undefined],
      ['open-release', undefined],
    ]);
    unmount();
    bridge(base({ status: 'disabled', disabled_reason: '开发版不检查更新' }));
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('开发版不检查更新'));
    expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull();
  });

  it('浏览器里没有桥：什么都不显示', () => {
    const { container } = render(<Harness />);
    expect(container.textContent).toBe('');
  });

  it('只在有新版本或下好了时点小点', () => {
    expect(updateNeedsAttention(base({ status: 'available' }))).toBe(true);
    expect(updateNeedsAttention(base({ status: 'downloaded' }))).toBe(true);
    expect(updateNeedsAttention(base({ status: 'downloading' }))).toBe(false);
    expect(updateNeedsAttention(null)).toBe(false);
    expect(sizeText(1536)).toBe('2 KB');
  });
});
