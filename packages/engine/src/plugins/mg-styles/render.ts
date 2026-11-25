/**
 * 将 MG 风格条目渲染为整片风格契约文件：STYLE.md、SKILL.md、style.json 与 ATTRIBUTION.md。
 */
import { RefsDirEnv } from '../../filmstyle';
import { marshalIndent } from '../../gojson';
import { LicenseName, type MgStyleEntry, PinnedVersion, SourceID, SourceName, UpstreamRepo } from './mg';

function engineLabel(engine: string): string {
  switch (engine) {
    case 'threejs':
      return 'Three.js 真 3D（必须引入/使用 three 或 THREE，严禁 CSS 3D 伪装）';
    case 'webgl2':
      return 'WebGL2 / GLSL 着色器（必须调用 getContext("webgl2") 或 WebGL shader 编译，严禁 CSS backdrop-filter / filter: blur 伪装）';
    case 'canvas2d':
      return 'Canvas2D 逐帧绘制（推荐使用 getContext("2d") 逐帧绘制，避免退化为纯静态 DOM 拼贴）';
    default:
      return engine;
  }
}

/** 渲染 STYLE.md（整片风格不变量：视觉规格、色板、效果配方表、动效推荐与渲染引擎契约）。 */
export function renderStyleMD(entry: MgStyleEntry): string {
  const engines = entry.engine_contract.required.map(engineLabel).join('；');
  const severity = entry.engine_contract.severity === 'error' ? '阻断级强契约（error）' : '建议级提醒（warn）';
  const lines = [
    `# ${entry.cn}（${entry.en}）`,
    '',
    `> 来源：${SourceName}（\`${SourceID}/${entry.slug}\`，衍生自 MIT 项目 \`${UpstreamRepo}\`）`,
    '',
    entry.summary,
    '',
    '## 1. 渲染引擎契约',
    `- **要求引擎**：${engines}`,
    `- **门禁级别**：${severity}`,
    ...(entry.engine_contract.note ? [`- **执行说明**：${entry.engine_contract.note}`] : []),
    '- **显式偏离豁免**：若单镜确有充分创意理由需要降级或改用其他引擎，必须在镜头源码顶部注释写入 `// onset-engine-deviation: <engine> -> <replacement> | reason: <具体理由>`，或在镜头配置中显式声明偏离与理由，门禁将降级为带理由留痕的警告放行。',
    '',
    '## 2. 推荐动效组合（`motion_effects`）',
    `- 推荐标识：${entry.motion_effects.map((id) => `\`${id}\``).join('、')}`,
    '- 分镜阶段可直接填入该镜头的 `motion_effects`（每镜最多 3 条），由宿主自动展开配方并校验目录存在性。',
    '',
    '## 3. 核心色板',
    '| 角色 | 色值 | 用途 |',
    '|---|---|---|',
    `| 背景 Background | \`${entry.palette.bg}\` | 主画布底色 |`,
    `| 载体 Surface | \`${entry.palette.surface}\` | 面板、次级块面与衬底 |`,
    `| 主色 Primary | \`${entry.palette.primary}\` | 核心图形与视觉焦点 |`,
    `| 辅色 Secondary | \`${entry.palette.secondary}\` | 层次对比与辅线元素 |`,
    `| 强调 Accent | \`${entry.palette.accent}\` | 高光、节拍重音与标注 |`,
    `| 文字 Ink | \`${entry.palette.ink}\` | 标题、正文与高对比描边 |`,
    '',
    '## 4. 视觉规格',
    `- **排版气质**：${entry.typography}`,
    `- **构图原则**：${entry.composition}`,
    `- **质感材质**：${entry.texture}`,
    `- **动效语法**：${entry.motion_grammar}`,
    '',
    '## 5. 效果配方表',
    '| 维度 | 本风格配方 |',
    '|---|---|',
    `| 转场 Transition | ${entry.recipes.transition} |`,
    `| 冲击 Impact | ${entry.recipes.impact} |`,
    `| 相机 Camera | ${entry.recipes.camera} |`,
    `| 颗粒 Grain | ${entry.recipes.grain} |`,
    `| 二次运动 Secondary | ${entry.recipes.secondary} |`,
    '',
    '## 6. 风格禁忌',
    ...entry.taboos.map((item) => `- ${item}`),
    '',
  ];
  return lines.join('\n');
}

/** 渲染 SKILL.md（HyperFrames 接入指引、确定性要求与离线参考帧提示）。 */
export function renderSkillMD(entry: MgStyleEntry): string {
  const req = entry.engine_contract.required.join(', ');
  const lines = [
    `# ${entry.cn}（${entry.en}）— HyperFrames 实现指南`,
    '',
    `本风格来自内置「${SourceName}」（\`${SourceID}/${entry.slug}\`，${LicenseName} 许可，源自 \`${UpstreamRepo}\`）。`,
    '',
    '## 动手前必读',
    '1. 完整遵守同目录 `STYLE.md` 的色板、排版、构图、质感、效果配方表与禁忌；若项目另有「全片配色」，以全片配色为准但保留本风格的明度层级与材质规律。',
    `2. **渲染引擎契约（${req} / ${entry.engine_contract.severity}）**：渲染验收将静态检查合成源码是否真实使用约定引擎。${entry.engine_contract.note ?? ''}`,
    '3. **确定性要求**：所有动画、抖动、粒子与着色器时间必须由 HyperFrames 的 `hf-seek` / 时间轴 `t` 确定性驱动；严禁 `Math.random()`、`Date.now()`、`performance.now()` 或 `requestAnimationFrame`。',
    `4. **离线视觉参考帧（可选）**：若本机配置了环境变量 \`${RefsDirEnv}\`，可通过 \`film_style_refs({"style": "${SourceID}/${entry.slug}"})\` 查看该风格的本地离线参考帧清单。`,
    '',
    '## 显式偏离声明格式',
    '确因镜头创意需要偏离引擎契约时，在入口 HTML 或主脚本顶部 50 行内添加注释：',
    '```js',
    `// onset-engine-deviation: ${entry.engine_contract.required[0]} -> canvas2d | reason: <写明本镜头的具体理由>`,
    '```',
    '',
  ];
  return lines.join('\n');
}

/** 渲染 style.json（供渲染前引擎契约门禁与工具读取的结构化元数据）。 */
export function renderStyleJSON(entry: MgStyleEntry): string {
  const body = marshalIndent({
    source: SourceID,
    slug: entry.slug,
    order: entry.order,
    cn: entry.cn,
    en: entry.en,
    category_cn: entry.category_cn,
    category_en: entry.category_en,
    uses: entry.uses,
    summary: entry.summary,
    tags: entry.tags,
    license: LicenseName,
    upstream: UpstreamRepo,
    version: PinnedVersion,
    motion_effects: entry.motion_effects,
    engine_contract: entry.engine_contract,
    palette: entry.palette,
  });
  return body + '\n';
}

/** 渲染 ATTRIBUTION.md（MIT 许可与上游来源署名）。 */
export function renderAttributionMD(entry: MgStyleEntry): string {
  return [
    '# Attribution & License',
    '',
    `- Style: ${entry.cn} / ${entry.en} (\`${SourceID}/${entry.slug}\`)`,
    `- Upstream inspiration & specifications: \`${UpstreamRepo}\``,
    `- License: ${LicenseName} License`,
    `- Pack version: \`${PinnedVersion}\``,
    '',
    'Offline reference frames are intentionally excluded from the repository and loaded locally when `ONSET_FILM_STYLE_REFS_DIR` is configured.',
    '',
  ].join('\n');
}
