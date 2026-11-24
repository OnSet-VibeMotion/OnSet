/**
 * 专栏（Series）的跨期资产同步、沉淀与规范更新操作：供编排工具经 MCP 工具服务调用。
 */
import { marshalIndent } from '@onset/engine/gojson';
import * as series from '@onset/engine/series';
import { currentEnvironment } from './cli';
import { defineGroup } from './ops/cli';
import { bool, str } from './ops/common';
import { defineOp, isParamProvided } from './ops/op';

defineGroup({
  path: ['series'],
  summary: '专栏与跨期资产复用',
  description: '读取本片所属专栏规范与发布模板，拉取专栏跨期资产，或把本期验收好的组件/角色/片头片尾沉淀回专栏。',
});

function seriesRoot(): string {
  return series.defaultDir(currentEnvironment());
}

function requireProjectBinding(projectRoot: string): series.ProjectSeriesBinding {
  const binding = series.readBinding(projectRoot);
  if (!binding) throw new Error('当前项目没有归属任何专栏（缺少 onset.series.json）');
  return binding;
}

defineOp({
  name: 'series_info',
  cli: ['series', 'info'],
  summary: '查看当前项目所属专栏的规范、发布模板与跨期资产同步状态',
  description:
    '只读查看本片所属专栏的配置、视觉与口播规范（brief.md）、发布模板，以及每项跨期资产与当前项目的同步状态。',
  examples: ['series_info({})', 'series_info({"json": true})'],
  params: {
    json: { type: 'boolean', description: '以 JSON 格式输出' },
  },
  run: (p, { out }) => {
    const projectRoot = process.cwd();
    const root = seriesRoot();
    const binding = series.readBinding(projectRoot);
    if (!binding) {
      const data = { bound: false };
      if (bool(p.json)) out.write(marshalIndent(data) + '\n');
      else out.write('当前项目为独立项目，未归属任何专栏。\n');
      return { data };
    }
    const cfg = series.getSeries(root, binding.series_id);
    const brief = cfg ? series.readBrief(root, cfg.id) : '';
    const publishTemplate = cfg ? series.readPublishTemplate(root, cfg.id) : null;
    const assets = series.diffSeriesAssets(root, projectRoot);
    const data = { bound: true, binding, series: cfg, brief, publish_template: publishTemplate, assets };
    if (bool(p.json)) {
      out.write(marshalIndent(data) + '\n');
      return { data };
    }
    out.write(`专栏：${cfg?.name ?? binding.series_name}（${binding.series_id}）`);
    if (binding.episode) out.write(` · 第 ${binding.episode} 期`);
    out.write('\n');
    if (brief.trim()) out.write(`\n规范摘要：\n${brief.trim()}\n`);
    if (assets.length > 0) {
      out.write('\n跨期资产：\n');
      for (const a of assets) out.write(`- ${a.key} → ${a.target_path} [${a.status}]\n`);
    }
    return { data };
  },
});

defineOp({
  name: 'series_sync_asset',
  cli: ['series', 'sync'],
  summary: '把本专栏的跨期资产拉取/更新到当前项目',
  description:
    '从本专栏资产库拷贝指定资产到当前项目（shared 组件、cast 角色、bumper 片头片尾、audio 音频、cover 封面、directions 语气说明、publish_template 发布模板）。若本地改过，需显式传 replace: true 才覆盖。',
  examples: [
    'series_sync_asset({"kind": "shared", "name": "brand-badge"})',
    'series_sync_asset({"kind": "bumper", "name": "intro", "replace": true})',
  ],
  params: {
    kind: {
      type: 'string',
      required: true,
      description: '资产类型：shared / cast / bumper / audio / cover / directions / publish_template',
    },
    name: { type: 'string', description: '资产名（directions 与 publish_template 可省略）' },
    replace: { type: 'boolean', description: '本地已有改动时强制用专栏版本覆盖' },
  },
  run: (p, { out }) => {
    const projectRoot = process.cwd();
    const kind = str(p.kind) as series.AssetKind;
    if (!series.ValidAssetKinds.has(kind)) {
      throw new Error(`不支持的资产类型：${kind}`);
    }
    const result = series.syncAssetToProject(seriesRoot(), projectRoot, {
      kind,
      name: str(p.name),
      replace: bool(p.replace),
    });
    if (result.unchanged) out.write(`专栏资产 ${result.key} 已是最新，无需改动：${result.target_path}\n`);
    else out.write(`已从专栏同步 ${result.key} → ${result.target_path}\n`);
    return { data: result };
  },
});

defineOp({
  name: 'series_promote_asset',
  cli: ['series', 'promote'],
  summary: '把本期验收好的组件、角色、片头片尾、音频或封面沉淀回本专栏',
  description: `把当前项目内验收好的跨期资产沉淀到本专栏库，供后续所有期数自动复用。
- shared：项目内的 production/shared/<name>/（须含 README.md 与 .js/.mjs/.css）
- cast：项目内的角色目录（如 cast/<name>）
- bumper：固定成片 MP4 或可参数化 HTML 模板目录（如 scenes/intro 或 assets/series/bumpers/intro）
- audio / cover：项目内的音频或封面素材目录/文件`,
  examples: [
    'series_promote_asset({"kind": "shared", "name": "title-badge"})',
    'series_promote_asset({"kind": "bumper", "name": "intro", "from": "scenes/scene-001"})',
    'series_promote_asset({"kind": "audio", "name": "main-bgm", "from": "assets/bgm", "replace": true})',
  ],
  params: {
    kind: { type: 'string', required: true, description: '资产类型：shared / cast / bumper / audio / cover' },
    name: { type: 'string', required: true, description: '资产名（小写字母开头，只含小写字母、数字和短横线）' },
    from: { type: 'string', description: '项目内源目录或文件路径；留空按类型取默认路径' },
    replace: { type: 'boolean', description: '专栏已有同名且不同内容时覆盖' },
  },
  run: (p, { out }) => {
    const projectRoot = process.cwd();
    const binding = requireProjectBinding(projectRoot);
    const kind = str(p.kind);
    if (!series.isDirAssetKind(kind)) {
      throw new Error(`沉淀资产的类型必须是 shared、cast、bumper、audio 或 cover：${kind}`);
    }
    const result = series.promoteAssetToSeries(seriesRoot(), binding.series_id, projectRoot, {
      kind,
      name: str(p.name),
      from: str(p.from),
      replace: bool(p.replace),
    });
    if (result.unchanged) out.write(`专栏资产 ${result.key} 内容相同，无需更新。\n`);
    else
      out.write(
        `${result.replaced ? '已更新' : '已沉淀'}专栏资产 ${result.key}（${result.files} 个文件，${result.bytes} 字节）。\n`,
      );
    return { data: result };
  },
});

defineOp({
  name: 'series_update_brief',
  cli: ['series', 'brief'],
  summary: '更新本专栏的视觉与口播固定规范（brief.md）',
  description: '按用户明确要求更新当前项目所属专栏的 brief.md，后续所有期数都会自动带入这份规范。',
  examples: ['series_update_brief({"content": "# 视觉约定\\n背景固定炭黑，重点词用琥珀高亮。"})'],
  params: {
    content: { type: 'string', required: true, description: '完整的 brief.md 正文内容（传空串表示清空）' },
  },
  run: (p, { out }) => {
    const binding = requireProjectBinding(process.cwd());
    series.writeBrief(seriesRoot(), binding.series_id, str(p.content));
    out.write(`已更新专栏「${binding.series_name}」的规范（brief.md）。\n`);
    return { data: { series_id: binding.series_id, ok: true } };
  },
});

defineOp({
  name: 'series_update_publish_template',
  cli: ['series', 'publish-template'],
  summary: '更新本专栏的发布与封面模板',
  description: '设置或更新当前专栏共用的标题规则、固定话题、简介尾注、封面规范与固定署名。',
  examples: [
    'series_update_publish_template({"title_pattern": "【EP{nn}】{title}", "default_hashtags": ["#AI拆解", "#科普"]})',
  ],
  params: {
    title_pattern: { type: 'string', description: '标题规则，如 【EP{nn}】{title}' },
    default_hashtags: { type: 'strings', description: '固定话题标签列表' },
    description_footer: { type: 'string', description: '发布简介固定尾注' },
    cover_guidelines: { type: 'string', description: '系列封面视觉与构图规范' },
    credits_lines: { type: 'strings', description: '固定片头/BGM 等素材署名行' },
    clear: { type: 'boolean', description: '清空整个发布模板' },
  },
  run: (p, { out }) => {
    const binding = requireProjectBinding(process.cwd());
    if (bool(p.clear)) {
      series.writePublishTemplate(seriesRoot(), binding.series_id, {});
      out.write(`已清空专栏「${binding.series_name}」的发布模板。\n`);
      return { data: { series_id: binding.series_id, publish_template: null } };
    }
    const existing = series.readPublishTemplate(seriesRoot(), binding.series_id);
    const has = (key: string) => isParamProvided(p, key);
    const toStrings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const merged: series.PublishTemplateInput = {
      title_pattern: has('title_pattern') ? str(p.title_pattern) : existing?.title_pattern,
      default_hashtags: has('default_hashtags') ? toStrings(p.default_hashtags) : existing?.default_hashtags,
      description_footer: has('description_footer') ? str(p.description_footer) : existing?.description_footer,
      cover_guidelines: has('cover_guidelines') ? str(p.cover_guidelines) : existing?.cover_guidelines,
      credits_lines: has('credits_lines') ? toStrings(p.credits_lines) : existing?.credits_lines,
    };
    if (
      !has('title_pattern') &&
      !has('default_hashtags') &&
      !has('description_footer') &&
      !has('cover_guidelines') &&
      !has('credits_lines')
    ) {
      out.write(`未指定要更新的字段，已保留专栏「${binding.series_name}」现有发布模板。\n`);
      return { data: { series_id: binding.series_id, publish_template: existing } };
    }
    const saved = series.writePublishTemplate(seriesRoot(), binding.series_id, merged);
    out.write(`已更新专栏「${binding.series_name}」的发布模板。\n`);
    return { data: { series_id: binding.series_id, publish_template: saved } };
  },
});
