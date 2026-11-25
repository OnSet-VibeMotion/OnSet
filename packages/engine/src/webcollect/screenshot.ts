/**
 * 无头浏览器 2× 高清截图渲染器：
 * - captureViewport：安全预检公网 URL 与重定向链后截图落盘进 assets/collected/ 并登记清单；
 * - renderHtmlPage：通过仅绑定 127.0.0.1 的临时内存服务 + 严格 CSP + 全网阻断规则渲染本地 HTML，
 *   防止任意本地文件读取（file://）与外部网络泄漏，默认产出 2× 视口尺寸的 PNG。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { removeTree } from '../fsutil';
import { findChromeExecutable, runChromeScreenshot } from './chrome';
import { preflightSafeUrl, stripIpv6Brackets } from './http';
import { saveCollectedAsset } from './store';
import {
  type CollectedAssetEntry,
  DefaultScreenshotHeight,
  DefaultScreenshotScale,
  DefaultScreenshotWidth,
  type ScreenshotOptions,
} from './types';

const MaxInlineHtmlBytes = 5 * 1024 * 1024;

const IsolatedHtmlCsp = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

function normalizeViewport(opts: ScreenshotOptions): {
  width: number;
  height: number;
  scale: number;
  timeoutMs: number;
} {
  const width = Math.max(160, Math.min(3840, Math.round(opts.width ?? DefaultScreenshotWidth)));
  const height = Math.max(160, Math.min(3840, Math.round(opts.height ?? DefaultScreenshotHeight)));
  const scale = Math.max(1, Math.min(4, opts.scale ?? DefaultScreenshotScale));
  const timeoutMs = Math.max(2_000, Math.min(120_000, opts.timeoutMs ?? 25_000));
  return { width, height, scale, timeoutMs };
}

function resolveBrowserBinary(opts: ScreenshotOptions): string {
  if (opts.runner) return opts.chromePath || 'mock-chrome';
  const chrome = findChromeExecutable(opts.chromePath, opts.env);
  if (!chrome) {
    throw new Error('未找到可用的 Chrome / Chromium 浏览器；请安装 Chrome 或通过 ONSET_CHROME_PATH 指定可执行文件路径');
  }
  return chrome;
}

/** 将本地 HTML 文本在网络隔离与文件隔离沙箱内渲染为 2× 高清 PNG 并登记清单。 */
export async function renderHtmlPage(html: string, opts: ScreenshotOptions): Promise<CollectedAssetEntry> {
  if (!html || !html.trim()) {
    throw new Error('HTML 内容为空，无法渲染截图');
  }
  const htmlBuf = Buffer.from(html, 'utf8');
  if (htmlBuf.length > MaxInlineHtmlBytes) {
    throw new Error(`HTML 体积超过上限（${htmlBuf.length} > ${MaxInlineHtmlBytes} 字节）`);
  }
  const chromePath = resolveBrowserBinary(opts);
  const { width, height, scale, timeoutMs } = normalizeViewport(opts);
  const runner = opts.runner ?? runChromeScreenshot;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-html-shot-'));
  const shotFile = path.join(workDir, 'page.png');

  // 仅绑定 127.0.0.1 的内存 HTTP 服务：浏览器同源策略天然禁止 http:// 访问 file://，
  // 配合严格 CSP 与全网阻断规则，彻底防止读取本地任意文件或发起外联请求。
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': IsolatedHtmlCsp,
        'x-content-type-options': 'nosniff',
      });
      res.end(htmlBuf);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') reject(new Error('无法启动本地隔离渲染端口'));
        else resolve(addr.port);
      });
    });

    await runner({
      chromePath,
      targetUrl: `http://127.0.0.1:${port}/`,
      outputPath: shotFile,
      width,
      height,
      scale,
      isolated: true,
      hostResolverRules: 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      timeoutMs,
      signal: opts.signal,
    });

    const pngBuf = fs.readFileSync(shotFile);
    const saved = saveCollectedAsset({
      projectRoot: opts.projectRoot,
      buffer: pngBuf,
      ext: '.png',
      kind: 'screenshot',
      source: 'html:inline',
      caption: opts.caption || `本地 HTML 页面截图（${width}x${height} @${scale}x）`,
      name: opts.name || 'html-page',
      mimeType: 'image/png',
    });
    return saved.entry;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      removeTree(workDir);
    } catch {
      // 忽略清理失败
    }
  }
}

/** 安全预检公开网页并截取 2× 视口 PNG 落盘进 assets/collected/。 */
export async function captureViewport(rawUrl: string, opts: ScreenshotOptions): Promise<CollectedAssetEntry> {
  const preflight = await preflightSafeUrl(rawUrl, {
    deps: opts.deps,
    transport: opts.transport,
    timeoutMs: Math.min(opts.timeoutMs ?? 15_000, 15_000),
    signal: opts.signal,
    followRedirects: !opts.runner || Boolean(opts.transport),
  });
  const chromePath = resolveBrowserBinary(opts);
  const { width, height, scale, timeoutMs } = normalizeViewport(opts);
  const runner = opts.runner ?? runChromeScreenshot;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-url-shot-'));
  const shotFile = path.join(workDir, 'viewport.png');
  const finalHost = stripIpv6Brackets(preflight.finalUrl.hostname);
  const pinnedTarget = preflight.family === 6 ? `[${preflight.address}]` : preflight.address;
  const hostResolverRules = [
    `MAP ${finalHost} ${pinnedTarget}`,
    'MAP localhost ~NOTFOUND',
    'MAP 127.0.0.1 ~NOTFOUND',
    'MAP 169.254.169.254 ~NOTFOUND',
  ].join(', ');

  try {
    await runner({
      chromePath,
      targetUrl: preflight.finalUrl.href,
      outputPath: shotFile,
      width,
      height,
      scale,
      isolated: false,
      hostResolverRules,
      timeoutMs,
      signal: opts.signal,
    });
    const pngBuf = fs.readFileSync(shotFile);
    const saved = saveCollectedAsset({
      projectRoot: opts.projectRoot,
      buffer: pngBuf,
      ext: '.png',
      kind: 'screenshot',
      source: preflight.finalUrl.href,
      caption: opts.caption || `网页视口截图（${preflight.finalUrl.hostname} ${width}x${height} @${scale}x）`,
      name: opts.name || `page-${finalHost}`,
      mimeType: 'image/png',
    });
    return saved.entry;
  } finally {
    try {
      removeTree(workDir);
    } catch {
      // 忽略清理失败
    }
  }
}

export { findChromeExecutable, runChromeScreenshot } from './chrome';
