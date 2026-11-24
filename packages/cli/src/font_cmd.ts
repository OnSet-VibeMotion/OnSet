/**
 * 精选字体目录与按需校验入池操作（font_catalog / font_prepare）。
 */
import os from 'node:os';
import path from 'node:path';
import * as fontcatalog from '@onset/engine/fontcatalog';
import { currentEnvironment } from './cli';
import { defineGroup } from './ops/cli';
import { num, projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['font'],
  summary: '精选字体目录与按需缓存准备',
  description:
    '检索内置的 40 款免费商用字体元数据（含 9 款简中字体的字形角色、手机可读性与搭配建议），并按固定 commit 与 SHA-256 校验按需下载入池。',
});

defineOp({
  name: 'font_catalog',
  cli: ['font', 'catalog'],
  summary: '检索精选免费商用字体目录（含简中/英文角色、手机端可读性与搭配建议）',
  description: `按语言、角色、类别或关键词检索内置精选字体目录（含 9 款简中及 31 款多语种免费商用字体）。
传入 id 时返回该字体的完整详情（字重范围、可读性风险、搭配建议与许可证）；
传入 index_only=true 时将目录写成版本化 JSONL 本地索引文件并返回路径，避免把整份列表塞进上下文。`,
  examples: [
    'font_catalog({"language": "zh-Hans"})',
    'font_catalog({"id": "lxgwwenkai"})',
    'font_catalog({"index_only": true, "project_root": "."})',
  ],
  params: {
    id: { type: 'string', description: '精确字体 ID（传入时返回单款完整详情）' },
    language: { type: 'string', description: '语言标签过滤，例如 zh-Hans、en、ja' },
    role: { type: 'string', description: '适用角色过滤，例如 title、body、subtitle、data' },
    category: { type: 'string', description: '字形类别过滤，例如 sans、serif、mono、handwriting、display' },
    query: { type: 'string', description: '关键词搜索' },
    index_only: { type: 'boolean', description: '仅写出 JSONL 本地索引文件并返回路径' },
    project_root: { type: 'string', description: '项目根目录（用于 index_only 落盘到 .onset/indexes）' },
  },
  run: async (p, { out }) => {
    const id = str(p.id);
    if (id !== '') {
      const font = fontcatalog.getFont(id);
      if (!font) throw new Error(`未知字体 ID：${id}`);
      out.write(`${font.id}（${font.family}）· ${font.category} · ${font.languages.join(', ')}\n`);
      out.write(`适用角色：${font.roles.join('、')}\n`);
      if (font.bestFor.length) out.write(`擅长场景：${font.bestFor.join('；')}\n`);
      if (font.readability?.risks?.length) out.write(`手机端可读性提示：${font.readability.risks.join('；')}\n`);
      out.write(`字重文件：${font.files.map((f) => `${f.name} (${f.weight})`).join(', ')}\n`);
      return { data: font };
    }

    const matched = fontcatalog.searchFonts({
      language: str(p.language) || undefined,
      role: str(p.role) || undefined,
      category: str(p.category) || undefined,
      query: str(p.query) || undefined,
    });
    if (Boolean(p.index_only)) {
      const root = str(p.project_root);
      const dir = root ? path.join(root, '.onset', 'indexes') : path.join(os.tmpdir(), 'onset-indexes');
      const idx = fontcatalog.writeFontIndex(dir, matched);
      out.write(`已写出字体 JSONL 索引（${idx.count} 款）：${idx.path}\n`);
      return { data: idx };
    }
    const items = matched.map(fontcatalog.toFontIndexRecord);
    for (const item of items) {
      out.write(
        `- ${item.id} (${item.family}) [${item.category}] ${item.languages.join('/')} · ${item.roles.join(', ')}\n`,
      );
    }
    out.write(`共 ${items.length} 款字体。\n`);
    return { data: { count: items.length, fonts: items } };
  },
});

defineOp({
  name: 'font_prepare',
  cli: ['font', 'prepare'],
  summary: '按固定 commit 与 SHA-256 校验准备精选字体到本机缓存并拷入项目',
  description: `按目录里的固定上游 commit 与精确 SHA-256 校验获取字体与 OFL 许可证，缓存到本机，
并拷入项目的 assets/fonts/（随后渲染器启动时自动进 .onset/resources 共享池）。
同时返回符合确定性扫描规范的 @font-face CSS 片段。`,
  examples: [
    'font_prepare({"id": "notosanssc", "project_root": "."})',
    'font_prepare({"id": "lxgwwenkai", "weight": 700, "project_root": "."})',
  ],
  params: {
    id: { type: 'string', description: '字体 ID（来自 font_catalog）', required: true, positional: 0 },
    weight: { type: 'integer', description: '期望字重（1–1000，留空取 400 或首个常规字重）' },
    project_root: projectRoot,
  },
  run: async (p, { out, signal }) => {
    const id = str(p.id);
    const weight = Math.trunc(num(p.weight));
    const root = str(p.project_root) || '.';
    const result = await fontcatalog.prepareFont(id, {
      weight: weight > 0 ? weight : undefined,
      projectRoot: root,
      env: currentEnvironment(),
      signal,
    });
    out.write(
      `已准备字体：${result.family}（${result.id}，字重 ${result.requested_weight}，许可 ${result.license_spdx}）\n`,
    );
    for (const f of result.files) {
      out.write(`  - ${f.project_path ?? f.cache_path} (${f.weight})\n`);
    }
    return { data: result };
  },
});
