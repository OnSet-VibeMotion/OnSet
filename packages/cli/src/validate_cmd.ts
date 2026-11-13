/**
 * 校验类操作：validate style。validate 组下的 video、beat、reads 在各自的文件里定义，
 * validate cast、song、publish 由内置插件登记（engine 的 plugins/），都由 mountOps 挂进同一个组。
 * style 移植自 internal/cli/cli.go 里内联定义的部分。
 */
import * as validate from '@am/engine/validate';
import { defineGroup } from './ops/cli';
import { bool, projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';
// 这个文件只登记操作，没有别的地方 import 它。
import './reads_cmd';

defineGroup({
  path: ['validate'],
  summary: '校验发布配置',
  description: `只读校验，不修改任何项目文件（唯一例外是 validate_style 的 regenerate_examples）。
校验通过时给出一行结论，失败时把具体不符项一次列全。`,
});

defineOp({
  name: 'validate_style',
  cli: ['validate', 'style'],
  summary: '校验旧版风格文件（兼容命令）',
  description: `校验旧项目留下的风格文件：画布规格、配色、字体层级、安全区，以及字体文件是否齐备。新项目的渲染不要求这些文件；画幅和确定性约束仍会在镜头校验中执行。

字体检查是重点：渲染机是一台干净的无头 Chrome，不装任何系统字体。字体栈里没有
@font-face 的字体族会静默回退——本地看着正常、成片排版却是错的。HyperFrames 会
自动内联一批字体，但其中没有任何简体中文字体，所以中文字形必须由项目自带文件提供。

regenerate_examples 会重新渲染 assets/style-guide/examples/ 下的示例 PNG，
这是本操作唯一会写文件的路径，出图在校验之前执行。内置风格以内置 SVG 为模板并
按项目配色重着色；自定义风格（旧版以 --style custom 新建的项目）直接渲染项目里的四张
SVG，草稿阶段也可以出图。它需要两个外部命令，缺任意一个都会失败：
  rsvg-convert   来自 librsvg，负责 SVG 转 PNG
  magick         来自 ImageMagick，负责把多张 PNG 拼成概览图

SVG 转 PNG 这一步不能用 ImageMagick 代替：多数 ImageMagick 构建自带内置 XML SVG
渲染器，会抢在 rsvg 委托之前接管 .svg，产出黑底无字的图却返回退出码 0。`,
  examples: ['validate_style()', '# 重新生成示例 PNG，需要 rsvg-convert 与 magick 都可用', 'validate_style({"regenerate_examples": true})'],
  params: {
    project_root: { ...projectRoot, description: '项目根目录，缺省为当前目录' },
    regenerate_examples: { type: 'boolean', description: '先重新生成风格示例 PNG 再校验，需要 rsvg-convert（librsvg）与 magick（ImageMagick）两个命令' },
  },
  run: (p, { out }) => {
    const rootDir = str(p.project_root) === '' ? '.' : str(p.project_root);
    // 先出图再校验：自定义风格的示例 PNG 要靠这一步生成，先校验的话
    // 会因为 PNG 还不存在而永远走不到出图。
    if (bool(p.regenerate_examples)) validate.regenerateExamples(rootDir, out);
    validate.style(rootDir);
    out.write('旧版风格文件校验通过\n');
    return { data: { ok: true } };
  },
});
