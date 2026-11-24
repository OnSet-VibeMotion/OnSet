/**
 * 跨项目品牌包操作（brand_kit_list / get / extract / apply）。
 */
import * as brandkit from '@onset/engine/brandkit';
import { currentEnvironment } from './cli';
import { defineGroup } from './ops/cli';
import { projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['brand-kit'],
  summary: '跨项目品牌包管理与官网样式自动提取',
  description:
    '管理跨项目复用的品牌视觉与产品事实（配色、字体、圆角、Logo 与规则），支持从公开 HTTPS 官网安全提取并按 Style-Only 契约挂载到项目。',
});

function kitsDir(): string {
  return brandkit.defaultBrandKitsDir(currentEnvironment());
}

defineOp({
  name: 'brand_kit_list',
  cli: ['brand-kit', 'list'],
  summary: '列出本机跨项目品牌包与当前项目已挂载的品牌包',
  description: '列出用户级目录中保存的全部品牌包；传入 project_root 时一并返回当前项目已应用的 Style-Only 品牌包快照。',
  examples: ['brand_kit_list({"project_root": "."})'],
  params: {
    project_root: { type: 'string', description: '可选：项目根目录' },
  },
  run: async (p, { out }) => {
    const kits = brandkit.listBrandKits(kitsDir());
    const root = str(p.project_root);
    const applied = root ? brandkit.readProjectBrandKit(root) : null;
    for (const k of kits) {
      const s = brandkit.effectiveBrandStyle(k);
      out.write(`- ${k.id}（${k.name}）· bg=${s.bg} accent=${s.accent} font=${s.display_font}\n`);
    }
    if (applied) out.write(`当前项目已挂载品牌包：${applied.name}（${applied.kit_id}）\n`);
    return { data: { kits, applied } };
  },
});

defineOp({
  name: 'brand_kit_get',
  cli: ['brand-kit', 'get'],
  summary: '读取指定品牌包详情与 Style-Only 视觉约束说明',
  description: '读取单个品牌包的完整色板、字体、Logo、品牌规则与参考附件清单。',
  examples: ['brand_kit_get({"id": "acme-1a2b3c"})'],
  params: {
    id: { type: 'string', description: '品牌包 ID', required: true, positional: 0 },
  },
  run: async (p, { out }) => {
    const kit = brandkit.getBrandKit(kitsDir(), str(p.id));
    if (!kit) throw new Error(`找不到品牌包：${str(p.id)}`);
    const eff = brandkit.effectiveBrandStyle(kit);
    out.write(
      `${kit.name}（${kit.id}）\n配色：bg=${eff.bg} surface=${eff.surface} text=${eff.text} accent=${eff.accent}\n字体：${eff.display_font} / ${eff.body_font}\n`,
    );
    return { data: { ...kit, effective_style: eff } };
  },
});

defineOp({
  name: 'brand_kit_extract',
  cli: ['brand-kit', 'extract'],
  summary: '从公开 HTTPS 官网自动提取品牌配色、字体与圆角并保存为品牌包',
  description: `使用 DNS-pinning 公网安全抓取（支持代理 Fake-IP 自动 DoH 复验）从公开 HTTPS 官网提取品牌视觉特征并保存。
传入 kit_id 时执行无损重扫，保留已手动覆写的名称、样式、规则与附件。`,
  examples: ['brand_kit_extract({"url": "https://example.com/"})'],
  params: {
    url: { type: 'string', description: '公开 HTTPS 官网地址', required: true, positional: 0 },
    kit_id: { type: 'string', description: '可选：已有品牌包 ID（传入时执行无损重扫）' },
    expected_updated_at: { type: 'string', description: '可选：乐观锁时间戳' },
  },
  run: async (p, { out, signal }) => {
    const kit = await brandkit.extractAndSaveBrandKit(kitsDir(), str(p.url), {
      kitId: str(p.kit_id) || undefined,
      expectedUpdatedAt: str(p.expected_updated_at) || undefined,
      signal,
    });
    const eff = brandkit.effectiveBrandStyle(kit);
    out.write(`已提取并保存品牌包：${kit.name}（${kit.id}，主色 ${eff.accent}，底色 ${eff.bg}）\n`);
    return { data: { ...kit, effective_style: eff } };
  },
});

defineOp({
  name: 'brand_kit_apply',
  cli: ['brand-kit', 'apply'],
  summary: '将指定品牌包按 Style-Only 契约挂载到当前项目',
  description:
    '写出项目的 production/brand-kit.json 并拷贝品牌 Logo 到 assets/brand/，返回供分镜与渲染参考的视觉约束段。',
  examples: ['brand_kit_apply({"id": "acme-1a2b3c", "project_root": "."})'],
  params: {
    id: { type: 'string', description: '品牌包 ID', required: true, positional: 0 },
    project_root: projectRoot,
  },
  run: async (p, { out }) => {
    const applied = brandkit.applyBrandKitToProject(kitsDir(), str(p.id), str(p.project_root) || '.');
    const promptSection = brandkit.brandKitPromptSection(applied);
    out.write(`已将品牌包「${applied.name}」挂载到项目（production/brand-kit.json）。\n`);
    return { data: { applied, prompt_section: promptSection } };
  },
});
