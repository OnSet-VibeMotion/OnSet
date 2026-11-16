/*
 * 组件测试的共用工具（*.test.tsx，jsdom 里渲染，不开客户端）。
 *
 * 后端换成一张表：mockApi({ 'GET /api/state': {...}, 'POST /api/stations/x/ops/y': (req) => ({...}) })。
 * 键是「方法 路径」（不带查询串；方法省略时只认 GET），值是返回的 JSON 或按请求算返回值的函数；
 * 函数可以返回 reply(状态码, 内容) 来模拟出错。表里没有的请求一律 404 并记进 unmatched，测试可以断言它为空。
 * 每个请求都记进 calls（方法、路径、查询串、解析过的请求体），用来断言界面发了什么。
 */
import { vi } from 'vitest';

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface MockReply {
  status: number;
  body: unknown;
}

type Handler = unknown | ((req: MockRequest) => unknown);

export function reply(status: number, body: unknown): MockReply & { __reply: true } {
  return { status, body, __reply: true };
}

export function mockApi(routes: Record<string, Handler>) {
  const calls: MockRequest[] = [];
  const unmatched: string[] = [];
  const table = new Map<string, Handler>();
  for (const [key, value] of Object.entries(routes)) table.set(key.includes(' ') ? key : `GET ${key}`, value);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'onset://app/');
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req = { method, path: url.pathname, query: url.searchParams, body };
    calls.push(req);
    const key = `${method} ${url.pathname}`;
    if (!table.has(key)) {
      unmatched.push(key);
      return new Response(JSON.stringify({ message: `测试里没有登记 ${key}` }), { status: 404 });
    }
    const handler = table.get(key);
    let out = typeof handler === 'function' ? await (handler as (r: MockRequest) => unknown)(req) : handler;
    let status = 200;
    if (out && typeof out === 'object' && (out as { __reply?: boolean }).__reply) {
      status = (out as MockReply).status;
      out = (out as MockReply).body;
    }
    return new Response(JSON.stringify(out ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    unmatched,
    /** 换掉或补上一条路由（例如操作之后后端返回的状态变了）。 */
    set(key: string, value: Handler) {
      table.set(key.includes(' ') ? key : `GET ${key}`, value);
    },
    /** 某条路由被请求过的次数。 */
    count(key: string) {
      const k = key.includes(' ') ? key : `GET ${key}`;
      return calls.filter((c) => `${c.method} ${c.path}` === k).length;
    },
  };
}

/** 对话事件流：组件里 new EventSource(url) 拿到的是它，测试用 emit 推事件。 */
export class FakeEventSource {
  static last: FakeEventSource | null = null;
  static all: FakeEventSource[] = [];
  url: string;
  readyState = 1;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  /** 推一条事件（type 缺省是 message）。data 按 JSON 发出。 */
  emit(data: unknown, type = 'message', lastEventId = '') {
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId });
    if (type === 'message') this.onmessage?.(event);
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  close() {
    this.readyState = 2;
  }
}

export function useFakeEventSource() {
  FakeEventSource.last = null;
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  return FakeEventSource;
}
