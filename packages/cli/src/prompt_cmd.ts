/**
 * prompt_show：打印这个项目现在组合出的整片制作提示词。
 *
 * 项目里不放提示词文件，提示词在开工时按锁文件记的流程从段落组合（project.runPrompt）。想看全文时用它：
 * 与客户端「开始制作」发给编排工具的是同一份。只给命令行与客户端后端（scopes 只有 cli）。
 */
import path from 'node:path';
import * as project from '@am/engine/project';
import { defineGroup } from './ops/cli';
import { projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['prompt'],
  summary: '整片制作提示词：看这个项目现在组合出的全文',
  description: `项目里不放提示词文件：开工时按 article-to-motion.flow.json 记的流程（口播、卡点、歌曲讲解或第三方流程）与画幅，
把 am 自带的段落组合成整片制作提示词。这一组命令只给命令行与客户端后端，用来看全文。`,
});

defineOp({
  name: 'prompt_show',
  cli: ['prompt', 'show'],
  summary: '打印这个项目现在组合出的整片制作提示词',
  description:
    '按项目 article-to-motion.flow.json 记的流程与画幅，把制作提示词的段落组合出来原样打印：关掉的内置功能不出现，第三方站的补充与说明照样插进去，与「开始制作」发给编排工具的是同一份。没有流程记录的目录直接报错。',
  examples: ['prompt_show({})'],
  scopes: ['cli'],
  params: { project_root: projectRoot },
  run: (p, { out }) => {
    const { prompt, label } = project.runPrompt(path.resolve(str(p.project_root)), '');
    const text = prompt.toString('utf8');
    out.write(text);
    return { data: { flow: label, bytes: prompt.length } };
  },
});
