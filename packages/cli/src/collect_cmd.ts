/**
 * 网站 / 品牌真实素材一键采集操作（仅编排端可见，渲染器严禁暴露网络工具）：
 * - asset_gather：多页整站采集 + 跨页色板/字体聚合 + 多源官方 Logo 合并
 * - asset_collect：单页素材采集（favicon / og:image / 主视觉 / 内联 SVG / 色板与字体）
 * - asset_fetch：安全下载单个公开原图或官方矢量 SVG
 * - asset_page：无头浏览器将本地 HTML 或公开网页渲染为 2× 高清 PNG 截图
 */
import fs from 'node:fs';
import path from 'node:path';
import * as webcollect from '@onset/engine/webcollect';
import { defineGroup } from './ops/cli';
import { bool, num, projectRoot, str } from './ops/common';
import { defineOp, ParamError } from './ops/op';

defineGroup({
  path: ['asset'],
  summary: '网站与品牌真实素材采集（图标、主视觉、色板与高清截图）',
  description:
    '通过公网防 SSRF 安全边界抓取公开网站或品牌的真实视觉素材，按 SHA-256 去重并净化 SVG 后落盘到项目的 assets/collected/ 及 manifest.json。',
});

function resolveProjectHtmlFile(root: string, relOrAbs: string): string {
  const base = fs.realpathSync(path.resolve(root));
  const target = path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : path.resolve(base, relOrAbs);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ParamError(`html_file 必须位于项目目录内，已拒绝路径穿越：${relOrAbs}`);
  }
  if (!fs.existsSync(target)) {
    throw new ParamError(`找不到 HTML 文件：${relOrAbs}`);
  }
  const realTarget = fs.realpathSync(target);
  const realRel = path.relative(base, realTarget);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new ParamError(`html_file 真实路径越出项目目录，已拒绝符号链接穿越：${relOrAbs}`);
  }
  if (!fs.statSync(realTarget).isFile()) {
    throw new ParamError(`找不到 HTML 文件：${relOrAbs}`);
  }
  return fs.readFileSync(realTarget, 'utf8');
}

defineOp({
  name: 'asset_gather',
  cli: ['asset', 'gather'],
  summary: '多页采集官网或品牌的真实素材、跨页配色字体与官方矢量 Logo',
  description:
    '抓取目标官网首页并自动挑选导航内页（默认 4 页、硬上限 6 页），跨页聚合实测色板与字体栈，合并页面内联 SVG、Simple Icons 官方矢量与高清图标后去重落盘到 assets/collected/；传入品牌名时直接获取官方矢量 Logo。支持 dry_run 预览与可选首页 2× 视口截图。',
  examples: [
    'asset_gather({"target": "https://example.com/", "max_pages": 4, "dry_run": true})',
    'asset_gather({"target": "github", "project_root": "."})',
  ],
  params: {
    target: { type: 'string', description: '公开官网 URL 或品牌名称/slug', required: true, positional: 0 },
    max_pages: { type: 'integer', description: '最多抓取页面数（默认 4，硬上限 6）', default: 4 },
    dry_run: { type: 'boolean', description: '仅预览采集清单，不写盘与不更新 manifest.json' },
    screenshot: { type: 'boolean', description: '是否同步截取首页 2× 高清 PNG 视口图（dry_run 时忽略）' },
    brand_slug: { type: 'string', description: '可选：覆盖用于查询 Simple Icons 的品牌 slug' },
    project_root: projectRoot,
  },
  run: async (p, { out, signal }) => {
    const root = str(p.project_root) || '.';
    const maxPages = Math.max(1, Math.min(webcollect.HardGatherMaxPages, num(p.max_pages) || 4));
    const res = await webcollect.gatherSite(str(p.target), {
      projectRoot: root,
      maxPages,
      dryRun: bool(p.dry_run),
      includeScreenshot: bool(p.screenshot),
      brandSlug: str(p.brand_slug) || undefined,
      signal,
    });
    const mode = res.dry_run ? '（预览模式，未落盘）' : '';
    out.write(
      `已采集品牌「${res.brand}」${mode}：共 ${res.pages.length} 页、${res.assets.length} 项素材（Logo ${res.logos.length} 项）、色板 ${res.palette.length} 色、字体 ${res.fonts.length} 组。\n`,
    );
    if (!res.dry_run) out.write(`清单路径：${res.manifest_path}\n`);
    return { data: res };
  },
});

defineOp({
  name: 'asset_collect',
  cli: ['asset', 'collect'],
  summary: '采集单个公开网页的图标、OG 主视觉、内联 SVG、色板与字体',
  description:
    '通过 DNS-pinning 公网安全抓取解析单个网页及其外链样式表，自动净化内联 SVG 并按 SHA-256 去重落盘到 assets/collected/；支持 dry_run 仅返回预览清单，可选附带 2× 视口截图。',
  examples: ['asset_collect({"url": "https://example.com/", "dry_run": true})'],
  params: {
    url: { type: 'string', description: '公开 HTTP/HTTPS 网页地址', required: true, positional: 0 },
    max_assets: { type: 'integer', description: '单页最多采集的素材数（默认 8，上限 24）', default: 8 },
    dry_run: { type: 'boolean', description: '仅预览采集清单，不写盘' },
    screenshot: { type: 'boolean', description: '是否同步截取该页 2× 视口截图' },
    project_root: projectRoot,
  },
  run: async (p, { out, signal }) => {
    const root = str(p.project_root) || '.';
    const res = await webcollect.collectPage(str(p.url), {
      projectRoot: root,
      maxAssets: num(p.max_assets) || 8,
      dryRun: bool(p.dry_run),
      includeScreenshot: bool(p.screenshot),
      signal,
    });
    const mode = res.dry_run ? '（预览模式，未落盘）' : '';
    out.write(
      `已采集页面「${res.title}」${mode}：素材 ${res.assets.length} 项、色板 ${res.palette.length} 色、字体 ${res.fonts.length} 组。\n`,
    );
    return { data: res };
  },
});

defineOp({
  name: 'asset_fetch',
  cli: ['asset', 'fetch'],
  summary: '安全下载单张公开原图或官方矢量 SVG 并去重落盘',
  description:
    '使用与品牌提取同源的公网防 SSRF 抓取器下载单个图片或 SVG 资源（拒绝内网 IP、非 HTTP/HTTPS 协议及跳往内网的重定向），自动净化 SVG 并按 SHA-256 去重保存到 assets/collected/。',
  examples: ['asset_fetch({"url": "https://example.com/logo.svg", "name": "brand-logo"})'],
  params: {
    url: { type: 'string', description: '公开图片或 SVG 的 HTTP/HTTPS 地址', required: true, positional: 0 },
    name: { type: 'string', description: '可选：落盘文件名前缀（自动清洗禁止路径字符）' },
    caption: { type: 'string', description: '可选：写入清单的素材说明文字' },
    dry_run: { type: 'boolean', description: '仅探测与校验，不写盘' },
    project_root: projectRoot,
  },
  run: async (p, { out, signal }) => {
    const root = str(p.project_root) || '.';
    const entry = await webcollect.fetchAsset(str(p.url), {
      projectRoot: root,
      name: str(p.name) || undefined,
      caption: str(p.caption) || undefined,
      dryRun: bool(p.dry_run),
      signal,
    });
    const dims = entry.width && entry.height ? ` ${entry.width}x${entry.height}` : '';
    out.write(
      `已获取素材：${entry.file}（${entry.kind}${dims}，${entry.bytes} 字节，sha256=${entry.sha256.slice(0, 12)}）\n`,
    );
    return { data: entry };
  },
});

defineOp({
  name: 'asset_page',
  cli: ['asset', 'page'],
  summary: '用无头浏览器将公开网页或 HTML 文本渲染为 2× 高清 PNG 截图',
  description:
    '复用本机可用的 Chrome / Chromium（或 ONSET_CHROME_PATH 指定路径）将公开网页 URL、内联 HTML 文本或项目内 HTML 文件渲染为 2× 视口尺寸 PNG 并登记进 assets/collected/manifest.json；渲染本地 HTML 时隔离外网与本地文件系统。',
  examples: [
    'asset_page({"html": "<div style=\\"padding:32px;background:#111;color:#fff\\">Hello</div>", "width": 640, "height": 360})',
    'asset_page({"url": "https://example.com/", "width": 1280, "height": 720})',
  ],
  params: {
    url: { type: 'string', description: '可选：要截图的公开 HTTP/HTTPS 网页地址（与 html、html_file 三选一）' },
    html: { type: 'string', description: '可选：要离线隔离渲染的内联 HTML 文本（与 url、html_file 三选一）' },
    html_file: { type: 'string', description: '可选：项目目录内的本地 HTML 文件路径（与 url、html 三选一）' },
    width: { type: 'integer', description: 'CSS 逻辑视口宽度（像素，默认 1280）', default: 1280 },
    height: { type: 'integer', description: 'CSS 逻辑视口高度（像素，默认 720）', default: 720 },
    scale: { type: 'number', description: '设备像素比（默认 2，即 2× 高清截图）', default: 2 },
    name: { type: 'string', description: '可选：输出截图文件名前缀' },
    caption: { type: 'string', description: '可选：写入清单的截图说明' },
    project_root: projectRoot,
  },
  run: async (p, { out, signal }) => {
    const root = str(p.project_root) || '.';
    const url = str(p.url).trim();
    const html = str(p.html);
    const htmlFile = str(p.html_file).trim();
    const provided = [Boolean(url), Boolean(html.trim()), Boolean(htmlFile)].filter(Boolean).length;
    if (provided !== 1) {
      throw new ParamError('asset_page 需要且仅能提供 url、html、html_file 三个参数之一');
    }

    const common = {
      projectRoot: root,
      width: num(p.width) || 1280,
      height: num(p.height) || 720,
      scale: num(p.scale) || 2,
      name: str(p.name) || undefined,
      caption: str(p.caption) || undefined,
      signal,
    };

    const entry = url
      ? await webcollect.captureViewport(url, common)
      : await webcollect.renderHtmlPage(htmlFile ? resolveProjectHtmlFile(root, htmlFile) : html, common);

    const dims = entry.width && entry.height ? `${entry.width}x${entry.height}` : '未知尺寸';
    out.write(
      `已生成 2× 页面截图：${entry.file}（${dims}，${entry.bytes} 字节，sha256=${entry.sha256.slice(0, 12)}）\n`,
    );
    return { data: entry };
  },
});
