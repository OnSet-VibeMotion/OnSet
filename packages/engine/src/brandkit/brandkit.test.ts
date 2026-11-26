import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addBrandAttachment,
  applyBrandKitToProject,
  assertSafePublicUrl,
  brandKitPromptSection,
  deleteBrandKit,
  effectiveBrandStyle,
  extractAndSaveBrandKit,
  extractBrandFromHtml,
  getBrandKit,
  isFakeIpV4,
  isPublicIP,
  listBrandKits,
  pinnedLookup,
  readProjectBrandKit,
  resolvePublicHost,
  saveBrandKit,
} from './index';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-brandkit-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('brandkit network safety', () => {
  it('blocks private, loopback, link-local and fake-ip ranges and resolves fake-ip via DoH', async () => {
    expect(isPublicIP('127.0.0.1')).toBe(false);
    expect(isPublicIP('10.0.0.5')).toBe(false);
    expect(isPublicIP('192.168.1.1')).toBe(false);
    expect(isPublicIP('169.254.169.254')).toBe(false);
    expect(isPublicIP('198.18.0.12')).toBe(false);
    expect(isPublicIP('::1')).toBe(false);
    expect(isPublicIP('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIP('93.184.216.34')).toBe(true);
    expect(isFakeIpV4('198.18.0.42')).toBe(true);
    expect(isFakeIpV4('198.19.255.1')).toBe(true);
    expect(isFakeIpV4('198.20.0.1')).toBe(false);

    expect(() => assertSafePublicUrl('http://example.com')).toThrow(/HTTPS/);
    expect(() => assertSafePublicUrl('https://localhost/a')).toThrow(/本地|内网/);

    // 全部为代理 Fake-IP 时走 DoH 独立解析公网 IP
    const res = await resolvePublicHost('example.com', {
      lookupAll: async () => [{ address: '198.18.0.5', family: 4 }],
      dohResolve: async () => ['93.184.216.34'],
    });
    expect(res).toEqual({ address: '93.184.216.34', family: 4 });

    // 混合私网直接拦截，绝不降级 DoH
    await expect(
      resolvePublicHost('mixed.example.com', {
        lookupAll: async () => [
          { address: '198.18.0.5', family: 4 },
          { address: '10.0.0.2', family: 4 },
        ],
        dohResolve: async () => ['93.184.216.34'],
      }),
    ).rejects.toThrow(/非公网/);
  });

  it('pinnedLookup supports both Node 20+ {all:true} and legacy scalar callback', () => {
    const fn = pinnedLookup('93.184.216.34', 4);
    let allResult: unknown;
    fn('example.com', { all: true }, (_err, addrs) => {
      allResult = addrs;
    });
    expect(allResult).toEqual([{ address: '93.184.216.34', family: 4 }]);

    let scalarAddr: unknown;
    let scalarFamily: unknown;
    fn('example.com', { all: false }, (_err, addr, fam) => {
      scalarAddr = addr;
      scalarFamily = fam;
    });
    expect(scalarAddr).toBe('93.184.216.34');
    expect(scalarFamily).toBe(4);
  });
});

describe('brandkit extraction and library lifecycle', () => {
  it('extracts palette, fonts and radius from HTML/CSS and preserves manual overrides on rescan', async () => {
    const html = `<!doctype html><html><head>
      <title>Acme Studio — Motion Tools</title>
      <meta name="theme-color" content="#ff5500">
      <style>
        :root { --bg: #0b0d12; --surface: #141821; --brand-primary: #ff5500; --text: #f9fafb; }
        body { font-family: "Inter", sans-serif; border-radius: 16px; }
        h1 { font-family: "Fraunces", serif; }
      </style>
    </head><body></body></html>`;
    const extracted = extractBrandFromHtml('https://acme.example/', html);
    expect(extracted.name).toBe('Acme Studio');
    expect(extracted.style.bg).toBe('#0b0d12');
    expect(extracted.style.accent).toBe('#ff5500');
    expect(extracted.style.radius).toBe('16px');

    const root = tempDir();
    const kit = await extractAndSaveBrandKit(root, 'https://acme.example/', {
      extractor: async () => extracted,
    });
    expect(listBrandKits(root)).toHaveLength(1);

    // 手动覆写主色、名称和规则
    const edited = saveBrandKit(root, {
      id: kit.id,
      name: 'Acme 中文品牌',
      style_overrides: { accent: '#00c48c' },
      rules: ['禁止使用荧光渐变'],
      expected_updated_at: kit.updated_at,
    });
    expect(effectiveBrandStyle(edited).accent).toBe('#00c48c');

    // 乐观锁：旧时间戳被拒
    expect(() =>
      saveBrandKit(root, { id: kit.id, name: 'conflict', expected_updated_at: '1999-01-01T00:00:00Z' }),
    ).toThrow(/BRAND_KIT_CHANGED/);

    // 重扫官网后，用户改过的名称、style_overrides 与 rules 均无损保留
    const rescanned = await extractAndSaveBrandKit(root, 'https://acme.example/', {
      kitId: kit.id,
      expectedUpdatedAt: edited.updated_at,
      extractor: async () => ({ ...extracted, style: { ...extracted.style, bg: '#111111' } }),
    });
    expect(rescanned.name).toBe('Acme 中文品牌');
    expect(rescanned.style.bg).toBe('#111111');
    expect(effectiveBrandStyle(rescanned).accent).toBe('#00c48c');
    expect(rescanned.rules).toEqual(['禁止使用荧光渐变']);

    // 挂载 Logo 并应用到项目
    const logoSrc = path.join(tempDir(), 'logo.png');
    fs.writeFileSync(logoSrc, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    addBrandAttachment(root, kit.id, 'logo', logoSrc, '主 Logo');

    const projectRoot = tempDir();
    const applied = applyBrandKitToProject(root, kit.id, projectRoot);
    expect(applied.style_only).toBe(true);
    expect(applied.logos).toHaveLength(1);
    expect(fs.existsSync(path.join(projectRoot, applied.logos[0]))).toBe(true);
    expect(readProjectBrandKit(projectRoot)?.kit_id).toBe(kit.id);

    const prompt = brandKitPromptSection(applied);
    expect(prompt).toContain('Acme 中文品牌');
    expect(prompt).toContain('#00c48c');
    expect(prompt).not.toMatch(/\bagent\b/i);

    deleteBrandKit(root, kit.id);
    expect(getBrandKit(root, kit.id)).toBeUndefined();
  });
});
