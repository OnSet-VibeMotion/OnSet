// 组件测试的公共设置：每个用例结束后卸载组件、还原换掉的全局（fetch、EventSource），
// 并补上 jsdom 没有、界面又会用到的几个浏览器接口。
import { afterEach, vi } from 'vitest';

if (typeof window !== 'undefined') {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } } as unknown as typeof IntersectionObserver;
  Element.prototype.scrollIntoView ??= function () {};
  Element.prototype.scrollTo ??= function () {};
  HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function () {};
  HTMLMediaElement.prototype.load = function () {};
  // waitFor / findBy* 缺省只等 1 秒：冷启动（CI 每次都是）时第一次渲染加上代码转换会超过它，偶尔失败（本地实测 1.2 秒）。
  const { configure } = await import('@testing-library/react');
  configure({ asyncUtilTimeout: 5000 });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
});
