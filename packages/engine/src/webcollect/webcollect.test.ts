import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeAssetName,
  assertSafeCollectUrl,
  captureViewport,
  collectedDir,
  collectPage,
  fetchAsset,
  fetchSimpleIconSvg,
  findChromeExecutable,
  gatherSite,
  normalizeBrandSlug,
  probeImageDimensions,
  readCollectedManifest,
  renderHtmlPage,
  type SafeHttpTransport,
  type ScreenshotRunRequest,
  safeFetchBuffer,
  sanitizeSvg,
  saveCollectedAsset,
  type WebFetcher,
} from './index';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-webcollect-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 构造最小合法 PNG 字节流（带指定宽高的 IHDR 头，用于离线单测与宽高探测）。 */
function makeSyntheticPng(width: number, height: number, seed = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // RGBA
  ihdr[21] = seed & 0xff;
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, iend]);
}

const publicDnsDeps = {
  lookupAll: async () => [{ address: '93.184.216.34', family: 4 }],
};

describe('webcollect store & SVG sanitization', () => {
  it('strips dangerous SVG tags, event handlers and javascript URIs before hashing and deduplicating', () => {
    const dirtySvg = `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://evil.example/dtd">
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" onload="alert('xss')" onclick='steal()'>
  <script>window.pwned = true;</script>
  <iframe src="https://evil.example"></iframe>
  <foreignObject width="100" height="100"><div>bad</div></foreignObject>
  <a xlink:href="javascript:alert(1)" href="javascript:void(0)">
    <rect x="0" y="0" width="120" height="40" fill="#ff5500" onmouseover="evil()" />
  </a>
</svg>`;
    const clean = sanitizeSvg(dirtySvg);
    expect(clean).toContain('<svg');
    expect(clean).toContain('fill="#ff5500"');
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/<iframe/i);
    expect(clean).not.toMatch(/<foreignObject/i);
    expect(clean).not.toMatch(/\bonload\s*=/i);
    expect(clean).not.toMatch(/\bonclick\s*=/i);
    expect(clean).not.toMatch(/\bonmouseover\s*=/i);
    expect(clean).not.toMatch(/javascript:/i);

    const project = tempDir();
    const first = saveCollectedAsset({
      projectRoot: project,
      buffer: Buffer.from(dirtySvg, 'utf8'),
      ext: '.svg',
      kind: 'vector',
      source: 'inline-svg:https://acme.example/',
      caption: '主 Logo',
      name: 'brand-logo',
    });
    expect(first.deduplicated).toBe(false);
    expect(first.entry.width).toBe(120);
    expect(first.entry.height).toBe(40);

    // 落盘内容已净化且权限为 0644
    const absFile = path.join(project, first.entry.file);
    const savedText = fs.readFileSync(absFile, 'utf8');
    expect(savedText).not.toMatch(/<script|onload|javascript:/i);
    if (process.platform !== 'win32') {
      expect(fs.statSync(absFile).mode & 0o777).toBe(0o644);
    }

    // 重复保存净化后等价的内容，按 SHA-256 去重，不产生第二个文件
    const second = saveCollectedAsset({
      projectRoot: project,
      buffer: Buffer.from(clean, 'utf8'),
      ext: '.svg',
      kind: 'vector',
      source: 'https://acme.example/logo.svg',
      caption: '重复 Logo',
      name: 'another-name',
    });
    expect(second.deduplicated).toBe(true);
    expect(second.entry.sha256).toBe(first.entry.sha256);
    expect(second.entry.file).toBe(first.entry.file);

    const files = fs.readdirSync(collectedDir(project)).filter((f) => f !== 'manifest.json');
    expect(files).toHaveLength(1);
    expect(readCollectedManifest(project).assets).toHaveLength(1);
  });

  it('enforces file size limit and rejects path traversal names', () => {
    const project = tempDir();
    expect(() => assertSafeAssetName('../etc/passwd')).toThrow(/非法素材名称/);
    expect(() => assertSafeAssetName('foo/bar')).toThrow(/非法素材名称/);
    expect(() => assertSafeAssetName('a\\b')).toThrow(/非法素材名称/);

    expect(() =>
      saveCollectedAsset({
        projectRoot: project,
        buffer: Buffer.alloc(1024, 1),
        ext: '.png',
        kind: 'image',
        source: 'https://acme.example/big.png',
        caption: '超限图',
        maxBytes: 512,
      }),
    ).toThrow(/超过上限/);
  });
});

describe('webcollect SSRF security boundaries', () => {
  it('blocks private IPs, loopback, metadata IP, IPv6 loopback and non-http(s) protocols', async () => {
    const blocked = [
      'http://127.0.0.1/secret.png',
      'https://127.0.0.1:8443/logo.svg',
      'http://169.254.169.254/latest/meta-data/',
      'https://169.254.169.254/latest/meta-data/iam',
      'http://10.0.0.1/internal.png',
      'https://10.0.0.1/logo.svg',
      'http://192.168.1.10/a.png',
      'https://[::1]/a.png',
      'https://[::ffff:127.0.0.1]/a.png',
      'https://localhost/logo.svg',
      'https://api.internal/logo.svg',
      'file:///etc/passwd',
      'ftp://example.com/logo.png',
      'javascript:alert(1)',
    ];
    for (const url of blocked) {
      expect(() => assertSafeCollectUrl(url), `应当拦截 ${url}`).toThrow();
    }

    const project = tempDir();
    for (const url of [
      'http://127.0.0.1/a.png',
      'http://169.254.169.254/a',
      'http://10.0.0.1/a.png',
      'file:///etc/passwd',
    ]) {
      await expect(fetchAsset(url, { projectRoot: project })).rejects.toThrow();
      await expect(collectPage(url, { projectRoot: project })).rejects.toThrow();
      await expect(captureViewport(url, { projectRoot: project, runner: async () => {} })).rejects.toThrow();
    }
  });

  it('blocks 302 redirects to private/loopback/metadata IPs and file:// in safeFetchBuffer & captureViewport', async () => {
    const redirectTargets = [
      'http://127.0.0.1/admin.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/secret.svg',
      'file:///etc/passwd',
    ];
    const project = tempDir();

    for (const target of redirectTargets) {
      const transport: SafeHttpTransport = async () => ({
        status: 302,
        location: target,
        contentType: 'text/plain',
        body: Buffer.alloc(0),
      });

      await expect(
        safeFetchBuffer('https://public.example/redirect', { deps: publicDnsDeps, transport }),
        `302 -> ${target} 必须被拦截`,
      ).rejects.toThrow(/拒绝|协议|非公网|本地/);

      await expect(
        fetchAsset('https://public.example/redirect', { projectRoot: project, deps: publicDnsDeps, transport }),
      ).rejects.toThrow(/拒绝|协议|非公网|本地/);

      await expect(
        captureViewport('https://public.example/redirect', {
          projectRoot: project,
          deps: publicDnsDeps,
          transport,
          runner: async () => {
            throw new Error('绝不应启动浏览器');
          },
        }),
      ).rejects.toThrow(/拒绝|协议|非公网|本地/);
    }
  });

  it('rejects DNS resolution to private IP while allowing Fake-IP verified by DoH', async () => {
    const transport: SafeHttpTransport = async () => ({
      status: 200,
      contentType: 'image/png',
      body: makeSyntheticPng(16, 16),
    });
    await expect(
      safeFetchBuffer('https://rebind.example/logo.png', {
        deps: { lookupAll: async () => [{ address: '10.0.0.1', family: 4 }] },
        transport,
      }),
    ).rejects.toThrow(/非公网/);

    const ok = await safeFetchBuffer('https://proxied.example/logo.png', {
      deps: {
        lookupAll: async () => [{ address: '198.18.0.5', family: 4 }],
        dohResolve: async () => ['93.184.216.34'],
      },
      transport,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.length).toBeGreaterThan(0);
  });
});

describe('webcollect multi-page gatherSite & Simple Icons', () => {
  it('aggregates cross-page palette/fonts, sanitizes inline SVG, fetches Simple Icons and deduplicates SHA-256', async () => {
    const project = tempDir();
    const sharedOgPng = makeSyntheticPng(1200, 630, 1);
    const faviconPng = makeSyntheticPng(180, 180, 2);
    const heroPng = makeSyntheticPng(1600, 900, 3);
    const simpleIconSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2L2 22h20z"/></svg>';

    const routes: Record<string, { contentType: string; body: Buffer | string }> = {
      'https://acme.example/': {
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head>
          <title>Acme Studio — Motion Platform</title>
          <meta name="theme-color" content="#ff5500">
          <meta property="og:image" content="/img/og.png">
          <link rel="apple-touch-icon" href="/img/apple-icon.png">
          <style>
            :root { --bg: #0b0d12; --brand-primary: #ff5500; --accent-2: #00c48c; }
            body { font-family: "Inter", sans-serif; }
            h1 { font-family: "Fraunces", serif; }
          </style>
        </head><body>
          <header>
            <svg class="brand-logo" width="80" height="32" onload="alert(1)"><script>evil()</script><rect width="80" height="32" fill="#ff5500"/></svg>
            <nav>
              <a href="/features">Features</a>
              <a href="/pricing">Pricing</a>
              <a href="/about">About</a>
              <a href="/docs">Docs</a>
              <a href="/brand">Brand</a>
              <a href="/showcase">Showcase</a>
              <a href="/login">Login</a>
            </nav>
          </header>
          <img class="hero-banner" src="/img/hero.png" width="1600" height="900" alt="Acme Hero">
        </body></html>`,
      },
      'https://acme.example/features': {
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head>
          <title>Features — Acme</title>
          <meta property="og:image" content="/img/og.png">
          <style>
            :root { --bg: #0b0d12; --brand-primary: #ff5500; }
            body { font-family: "Inter", sans-serif; }
          </style>
        </head><body><h1>Features</h1></body></html>`,
      },
      'https://acme.example/pricing': {
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head>
          <title>Pricing — Acme</title>
          <meta property="og:image" content="/img/og.png">
          <style>
            :root { --bg: #0b0d12; --brand-primary: #ff5500; --special: #7c3aed; }
            body { font-family: "Inter", sans-serif; }
          </style>
        </head><body><h1>Pricing</h1></body></html>`,
      },
      'https://acme.example/about': {
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head>
          <title>About — Acme</title>
          <style>body { color: #0b0d12; background: #ff5500; font-family: "Inter", sans-serif; }</style>
        </head><body><h1>About</h1></body></html>`,
      },
      'https://acme.example/docs': {
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><title>Docs</title></head><body>Docs</body></html>',
      },
      'https://acme.example/brand': {
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><title>Brand</title></head><body>Brand</body></html>',
      },
      'https://acme.example/showcase': {
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><title>Showcase</title></head><body>Showcase</body></html>',
      },
      'https://acme.example/img/og.png': { contentType: 'image/png', body: sharedOgPng },
      'https://acme.example/img/apple-icon.png': { contentType: 'image/png', body: faviconPng },
      'https://acme.example/img/hero.png': { contentType: 'image/png', body: heroPng },
      'https://cdn.simpleicons.org/acmestudio': { contentType: 'image/svg+xml', body: simpleIconSvg },
    };

    const fetcher: WebFetcher = async (url) => {
      const hit = routes[url];
      if (!hit) throw new Error(`HTTP 404: ${url}`);
      return {
        url,
        status: 200,
        contentType: hit.contentType,
        body: Buffer.isBuffer(hit.body) ? hit.body : Buffer.from(hit.body, 'utf8'),
      };
    };

    // 1. 先测 dryRun：返回预览但不创建任何文件
    const preview = await gatherSite('https://acme.example/', {
      projectRoot: project,
      maxPages: 3,
      dryRun: true,
      fetcher,
    });
    expect(preview.dry_run).toBe(true);
    expect(preview.pages).toHaveLength(3);
    expect(preview.assets.length).toBeGreaterThanOrEqual(4);
    expect(fs.existsSync(collectedDir(project))).toBe(false);

    // 2. 真实落盘 + 验证硬上限（请求 10 页最多采 6 页，跳过 /login）
    const gathered = await gatherSite('https://acme.example/', {
      projectRoot: project,
      maxPages: 10,
      fetcher,
    });
    expect(gathered.dry_run).toBe(false);
    expect(gathered.pages.length).toBeLessThanOrEqual(6);
    expect(gathered.pages.map((p) => p.url)).not.toContain('https://acme.example/login');
    expect(gathered.palette[0]).toBe('#ff5500');
    expect(gathered.palette).toContain('#0b0d12');
    expect(gathered.fonts[0]).toContain('Inter');

    // 验证多源 Logo（内联 SVG + Simple Icons + apple-touch-icon）均已合并，且内联 SVG 已被净化
    expect(gathered.logos.some((l) => l.source.startsWith('inline-svg:'))).toBe(true);
    expect(gathered.logos.some((l) => l.source === 'simple-icons:acmestudio')).toBe(true);
    const inlineEntry = gathered.logos.find((l) => l.source.startsWith('inline-svg:'))!;
    const inlineSaved = fs.readFileSync(path.join(project, inlineEntry.file), 'utf8');
    expect(inlineSaved).not.toMatch(/<script|onload/i);

    // 验证 SHA-256 去重：og.png 在首页、features、pricing 出现 3 次，落盘仅 1 份
    const manifest = readCollectedManifest(project);
    const ogEntries = manifest.assets.filter((a) => a.source === 'https://acme.example/img/og.png');
    expect(ogEntries).toHaveLength(1);
    expect(ogEntries[0].width).toBe(1200);
    expect(ogEntries[0].height).toBe(630);

    // 3. 单独测 Simple Icons slug 归一化与纯品牌名采集
    expect(normalizeBrandSlug('Next.js')).toBe('nextdotjs');
    expect(normalizeBrandSlug('C++')).toBe('cplusplus');
    const iconOnly = await fetchSimpleIconSvg('Acme Studio', { fetcher });
    expect(iconOnly?.slug).toBe('acmestudio');
    expect(iconOnly?.svg).toContain('<svg');
  });
});

describe('webcollect headless screenshots', () => {
  it('isolates local HTML rendering over 127.0.0.1 with strict CSP and records 2x PNG in manifest (mock runner)', async () => {
    const project = tempDir();
    const capturedReqs: ScreenshotRunRequest[] = [];
    let rootStatus = 0;
    let rootCsp = '';
    let nonRootStatus = 0;

    const entry = await renderHtmlPage('<html><body><h1>Isolated Card</h1></body></html>', {
      projectRoot: project,
      width: 640,
      height: 360,
      scale: 2,
      name: 'mock-card',
      runner: async (req) => {
        capturedReqs.push(req);
        // 验证内存服务器只响应 / 且携带严格 CSP，任意其它路径（如 /etc/passwd）返回 404
        const rootResp = await new Promise<{ status: number; csp: string }>((resolve, reject) => {
          http
            .get(req.targetUrl, (res) => {
              res.resume();
              resolve({
                status: res.statusCode ?? 0,
                csp: String(res.headers['content-security-policy'] ?? ''),
              });
            })
            .on('error', reject);
        });
        rootStatus = rootResp.status;
        rootCsp = rootResp.csp;
        const otherUrl = new URL('/etc/passwd', req.targetUrl).href;
        nonRootStatus = await new Promise<number>((resolve, reject) => {
          http
            .get(otherUrl, (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            })
            .on('error', reject);
        });
        fs.writeFileSync(req.outputPath, makeSyntheticPng(req.width * req.scale, req.height * req.scale, 9));
      },
    });

    const capturedReq = capturedReqs[0];
    expect(capturedReq?.isolated).toBe(true);
    expect(capturedReq?.targetUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(capturedReq?.hostResolverRules).toContain('MAP * ~NOTFOUND');
    expect(rootStatus).toBe(200);
    expect(rootCsp).toContain("default-src 'none'");
    expect(rootCsp).toContain("connect-src 'none'");
    expect(nonRootStatus).toBe(404);
    expect(entry.kind).toBe('screenshot');
    expect(entry.width).toBe(1280);
    expect(entry.height).toBe(720);
    expect(readCollectedManifest(project).assets.some((a) => a.sha256 === entry.sha256)).toBe(true);
  });

  it('pins verified public host in captureViewport (mock runner)', async () => {
    const project = tempDir();
    let resolverRules = '';
    const entry = await captureViewport('https://acme.example/landing', {
      projectRoot: project,
      width: 800,
      height: 450,
      scale: 2,
      deps: publicDnsDeps,
      runner: async (req) => {
        resolverRules = req.hostResolverRules ?? '';
        fs.writeFileSync(req.outputPath, makeSyntheticPng(1600, 900, 7));
      },
    });
    expect(resolverRules).toContain('MAP acme.example 93.184.216.34');
    expect(resolverRules).toContain('MAP 127.0.0.1 ~NOTFOUND');
    expect(resolverRules).toContain('MAP 169.254.169.254 ~NOTFOUND');
    expect(entry.width).toBe(1600);
    expect(entry.height).toBe(900);
  });

  const chromeBin = findChromeExecutable();
  it.skipIf(!chromeBin)(
    'renders real 2x PNG via local Chrome for inline HTML',
    async () => {
      const project = tempDir();
      const html = `<!doctype html><html><body style="margin:0;background:#111827;color:#f9fafb;font:32px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">OnSet 2x Render</body></html>`;
      const entry = await renderHtmlPage(html, {
        projectRoot: project,
        width: 320,
        height: 180,
        scale: 2,
        name: 'real-chrome-card',
        chromePath: chromeBin!,
      });
      const absFile = path.join(project, entry.file);
      const png = fs.readFileSync(absFile);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(probeImageDimensions(png, '.png')).toEqual({ width: 640, height: 360 });
      expect(entry.kind).toBe('screenshot');
      expect(entry.width).toBe(640);
      expect(entry.height).toBe(360);
      expect(readCollectedManifest(project).assets).toHaveLength(1);
    },
    30_000,
  );
});
