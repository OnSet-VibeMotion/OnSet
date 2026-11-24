/**
 * 动效库查询（motion_effect_list / motion_effect_show）：
 * 让编排工具在编写分镜与镜头 prompt.md 时直接检索内置 Motion Prompt（96 条动态图形/运镜/转场）
 * 与已安装第三方插件提供的动效目录，并获取精确参数规范。
 */
import * as flow from '@onset/engine/flow';
import { encodeLine } from '@onset/engine/gojson';
import { currentEnvironment } from './cli';
import { defineGroup } from './ops/cli';
import { bool, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['motion-effect'],
  summary: '动效库：检索内置与插件动效目录并查看参数规范',
  description: `内置 Motion Prompt 提供 96 条动态图形、运镜与转场参考，已安装的第三方插件也可以补充动效条目。
编写镜头画面描述（prompt.md）需要具体动效手法与节奏参数时，先用 motion_effect_list 按分类或关键词筛选，
再用 motion_effect_show 取回详细规范并按本镜头文案与画面改写；条目声明 renderer_skill 时，一并写入该镜头的 plugin_skills。
全部本地查询、不联网。`,
});

defineOp({
  name: 'motion_effect_list',
  cli: ['motion-effect', 'list'],
  summary: '列出或按关键词检索内置与插件动效库',
  description: `按来源、分类或关键词检索动效目录，默认输出每行一条的精简清单（标识、名称、分类与一句说明）。
支持同时用 source、category、query 组合筛选（query 按空格分词，须全部命中名称、别名、摘要或编号）；"json": true 输出完整结构化列表。不联网。`,
  examples: [
    'motion_effect_list()',
    'motion_effect_list({"query": "遮罩"})',
    'motion_effect_list({"category": "动态图形"})',
    'motion_effect_list({"source": "motion-prompt", "query": "counter"})',
    'motion_effect_list({"json": true})',
  ],
  params: {
    query: { type: 'string', description: '按关键词筛选（匹配标识、名称、英文别名、分类与说明）' },
    category: { type: 'string', description: '按分类筛选（子串匹配，如「动态图形」「运镜与转场」）' },
    source: { type: 'string', description: '只列指定来源（内置为 motion-prompt，或第三方插件 id）' },
    json: { type: 'boolean', description: '以 JSON 输出' },
  },
  run: (p, { out }) => {
    const sources = flow.listMotionSources(currentEnvironment());
    const sourceFilter = str(p.source).trim();
    if (sourceFilter && !sources.some((s) => s.id.toLowerCase() === sourceFilter.toLowerCase())) {
      const known = sources.map((s) => `${s.id}（${s.name}）`).join('、');
      throw new Error(`没有动效来源 "${sourceFilter}"。可用来源：${known}`);
    }
    const hits = flow.filterMotionEffects(sources, {
      source: sourceFilter,
      category: str(p.category),
      query: str(p.query),
    });
    const items = hits.map(({ ref, source, effect }) => ({
      ref,
      id: effect.id,
      name: effect.name,
      category: effect.category,
      summary: effect.summary,
      source: source.id,
      source_name: source.name,
      version: source.version,
      ...(effect.renderer_skill ? { renderer_skill: `${source.id}/${effect.renderer_skill}` } : {}),
    }));
    if (bool(p.json)) {
      out.write(encodeLine(items, { indent: '  ' }));
      return { data: { count: items.length, effects: items } };
    }
    if (items.length === 0) {
      out.write('没有匹配的动效条目。\n');
      return { data: { count: 0, effects: [] } };
    }
    out.write(`共 ${items.length} 条动效（用 motion_effect_show({"ref": "<标识>"}) 查看参数规范）：\n`);
    for (const item of items) {
      const skill = item.renderer_skill ? ` [技能: ${item.renderer_skill}]` : '';
      out.write(`- ${item.ref} | ${item.name}（${item.category}）— ${item.summary}${skill}\n`);
    }
    return { data: { count: items.length, effects: items } };
  },
});

defineOp({
  name: 'motion_effect_show',
  cli: ['motion-effect', 'show'],
  summary: '查看某条动效的详细说明、用法示例与参数规范',
  description: `按完整标识（如 motion-prompt:005）、唯一编号（如 005）、中文名（如 遮罩显现）或别名查看一条动效的完整规范（summary、example、spec 与可选的 renderer_skill）。
适合在编写某镜头 prompt.md 前取回具体节奏、曲线与构造细节并替换成该镜头的内容。不联网。`,
  examples: [
    'motion_effect_show({"ref": "motion-prompt:005"})',
    'motion_effect_show({"ref": "遮罩显现"})',
    'motion_effect_show({"ref": "007", "json": true})',
  ],
  params: {
    ref: {
      type: 'string',
      description: '动效标识（如 motion-prompt:005）、编号、中文名或别名',
      required: true,
      positional: 0,
    },
    json: { type: 'boolean', description: '以 JSON 输出' },
  },
  run: (p, { out }) => {
    const sources = flow.listMotionSources(currentEnvironment());
    const hit = flow.lookupMotionEffect(str(p.ref), sources);
    const skill = hit.effect.renderer_skill ? `${hit.source.id}/${hit.effect.renderer_skill}` : '';
    const data = {
      ref: hit.ref,
      source: hit.source.id,
      source_name: hit.source.name,
      version: hit.source.version,
      ...hit.effect,
      ...(skill ? { plugin_skill: skill } : {}),
    };
    if (bool(p.json)) {
      out.write(encodeLine(data, { indent: '  ' }));
      return { data };
    }
    out.write(`${hit.effect.name}（${hit.ref}，来源 ${hit.source.name} / 版本 ${hit.source.version}）\n`);
    out.write(`分类：${hit.effect.category}\n`);
    out.write(`简介：${hit.effect.summary}\n`);
    if (hit.effect.example) out.write(`示例：${hit.effect.example}\n`);
    if (skill) out.write(`配套渲染技能：${skill}（使用该动效时写入镜头 plugin_skills）\n`);
    if (hit.effect.example_url) out.write(`在线示例：${hit.effect.example_url}\n`);
    if (hit.effect.spec && hit.effect.spec.length > 0) {
      out.write('参考规范（写入镜头 prompt.md 时将示例元素替换成本镜头内容）：\n');
      for (const line of hit.effect.spec) out.write(`- ${line}\n`);
    }
    return { data };
  },
});
