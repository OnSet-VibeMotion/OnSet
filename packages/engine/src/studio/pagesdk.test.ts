import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageHostTimeoutMs, pageSDK } from './stations';

// 在一个假的 iframe 环境里跑页面 SDK：parent 记下页面发出的请求，deliver 模拟宿主（或别的窗口）发来的消息。
function loadSDK() {
  const posted: Record<string, unknown>[] = [];
  const listeners: ((e: { source: unknown; data: unknown }) => void)[] = [];
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  const style = { setProperty: () => {} };
  const window: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, f: (e: { source: unknown; data: unknown }) => void) => {
      if (type === 'message') listeners.push(f);
    },
  };
  const context = vm.createContext({
    window,
    location: { pathname: '/station-ui/fake-publisher/ui/index.html' },
    document: { documentElement: { style }, getElementById: () => null, createElement: () => ({}), head: { prepend: () => {} } },
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(pageSDK, context);
  const deliver = (data: unknown, source: unknown = parent) => {
    for (const f of listeners) f({ source, data });
  };
  return { am: window.am as Record<string, (...args: unknown[]) => Promise<unknown>>, posted, deliver };
}

describe('page SDK', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the host answer and ignores messages from anyone else', async () => {
    const { am, posted, deliver } = loadSDK();
    const info = am.info();
    const req = posted.find((m) => m.type === 'info')!;
    expect(req).toMatchObject({ am: 'station', type: 'info' });
    deliver({ am: 'host', id: req.id, ok: true, result: { project: '别的' } }, {});
    deliver({ am: 'host', id: req.id, ok: true, result: { project: 'demo' } });
    await expect(info).resolves.toEqual({ project: 'demo' });
  });

  it('fails a request the host never answers, with a clear error instead of hanging', async () => {
    const { am } = loadSDK();
    const read = am.read('publish.md');
    const caught = read.catch((err: Error) => err.message);
    vi.advanceTimersByTime(pageHostTimeoutMs + 1);
    expect(await caught).toContain('没有回应这个请求（read）');
  });

  it('waits as long as the user needs once the host acknowledged a confirmation', async () => {
    const { am, posted, deliver } = loadSDK();
    const run = am.run('send', { platform: 'douyin' });
    const req = posted.find((m) => m.type === 'run')!;
    deliver({ am: 'host', id: req.id, ack: true });
    vi.advanceTimersByTime(pageHostTimeoutMs * 10);
    deliver({ am: 'host', id: req.id, ok: false, error: '用户没有同意' });
    await expect(run).rejects.toThrow('用户没有同意');
  });
});
