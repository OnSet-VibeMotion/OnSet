/**
 * am validate：publish、style，以及挂在它下面的 video、cast、song、beat、reads。
 * publish 与 style 移植自 internal/cli/cli.go 里内联定义的部分。
 */
import * as validate from '@am/engine/validate';
import { newValidateBeatCommand } from './beat_cmd';
import { exactArgs, noArgs } from './cli';
import { Command, type Out, type Ref, ref } from './cobra';
import { newValidateVideoCommand } from './media';
import { newValidateReadsCommand } from './reads_cmd';
import { newValidateSongCommand } from './song_cmd';
import { newValidateCastCommand } from './validate_cast';

export function newValidateCommand(stdout: Out, projectRoot: Ref<string>): Command {
  const validateCmd = new Command({
    use: 'validate',
    short: '校验发布配置',
    long: `只读校验，不修改任何项目文件（唯一例外是 style --regenerate-examples）。
校验通过时打印一行结论并退出 0，失败时把具体不符项写到 stderr 并退出 1。`,
  });
  const publishCmd = new Command({
    use: 'publish PATH',
    args: exactArgs(1, 'PATH'),
    short: '校验 publish.md',
    long: `校验 PATH 指向的发布配置。

publish.md 必须以安全 YAML frontmatter 提供机器字段，并以固定 Markdown 章节
提供人工可复制内容。校验会核对字段完整性，以及它引用的产物是否与项目实际一致，
因此需要 --project-root 定位项目（缺省为当前目录）。

通过时打印 publish 校验通过：<路径>（<状态>）。`,
    example: `  am validate publish publish.md --project-root .`,
    runE: (_cmd, args) => {
      const rootDir = projectRoot.value === '' ? '.' : projectRoot.value;
      const data = validate.publish(args[0], rootDir);
      stdout.write(`publish 校验通过：${args[0]}（${validate.formatV(data.publish_status)}）\n`);
    },
  });
  publishCmd.flags().stringVar(projectRoot, 'project-root', '', '项目根目录，缺省为当前目录');
  validateCmd.addCommand(publishCmd);

  const regenerateExamples = ref(false);
  const styleCmd = new Command({
    use: 'style',
    args: noArgs,
    short: '校验旧版风格文件（兼容命令）',
    long: `校验旧项目留下的风格文件：画布规格、配色、字体层级、安全区，以及字体文件是否齐备。新项目的渲染不要求这些文件；画幅和确定性约束仍会在镜头校验中执行。

字体检查是重点：渲染机是一台干净的无头 Chrome，不装任何系统字体。字体栈里没有
@font-face 的字体族会静默回退——本地看着正常、成片排版却是错的。HyperFrames 会
自动内联一批字体，但其中没有任何简体中文字体，所以中文字形必须由项目自带文件提供。

--regenerate-examples 会重新渲染 assets/style-guide/examples/ 下的示例 PNG，
这是本命令唯一会写文件的路径，出图在校验之前执行。内置风格以内置 SVG 为模板并
按项目配色重着色；自定义风格（旧版以 --style custom 新建的项目）直接渲染项目里的四张
SVG，草稿阶段也可以出图。它需要两个外部命令，缺任意一个都会失败：
  rsvg-convert   来自 librsvg，负责 SVG 转 PNG
  magick         来自 ImageMagick，负责把多张 PNG 拼成概览图

SVG 转 PNG 这一步不能用 ImageMagick 代替：多数 ImageMagick 构建自带内置 XML SVG
渲染器，会抢在 rsvg 委托之前接管 .svg，产出黑底无字的图却返回退出码 0。`,
    example: `  am validate style --project-root .

  # 重新生成示例 PNG，需要 rsvg-convert 与 magick 都可用
  am validate style --project-root . --regenerate-examples`,
    runE: () => {
      const rootDir = projectRoot.value === '' ? '.' : projectRoot.value;
      // 先出图再校验：自定义风格的示例 PNG 要靠这一步生成，先校验的话
      // 会因为 PNG 还不存在而永远走不到出图。
      if (regenerateExamples.value) validate.regenerateExamples(rootDir, stdout);
      validate.style(rootDir);
      stdout.write('旧版风格文件校验通过\n');
    },
  });
  styleCmd.flags().stringVar(projectRoot, 'project-root', '', '项目根目录，缺省为当前目录');
  styleCmd.flags().boolVar(regenerateExamples, 'regenerate-examples', false, '先重新生成风格示例 PNG 再校验，需要 rsvg-convert（librsvg）与 magick（ImageMagick）两个命令');
  validateCmd.addCommand(styleCmd);
  validateCmd.addCommand(newValidateVideoCommand(stdout, projectRoot));
  validateCmd.addCommand(newValidateCastCommand(stdout));
  validateCmd.addCommand(newValidateSongCommand(stdout));
  validateCmd.addCommand(newValidateBeatCommand(stdout));
  validateCmd.addCommand(newValidateReadsCommand(stdout));
  return validateCmd;
}
