/**
 * prompt_show：打印这个项目现在组合出的整片制作提示词。
 *
 * 项目里不放提示词文件，提示词在开工时按锁文件记的流程从段落组合（project.runPrompt）。想看全文时用它：
 * 与客户端「开始制作」发给编排工具的是同一份。只给命令行与客户端后端（scopes 只有 cli）。
 */
import path from 'node:path';
import * as project from '@onset/engine/project';
import { defineGroup } from './ops/cli';
import { projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['prompt'],
  summary: '整片制作提示词：看这个项目现在组合出的全文',
  description: `项目里不放提示词文件：开工时按 onset.flow.json 记的流程（口播、卡点、歌曲讲解或第三方流程）与画幅，
把 onset 自带的段落组合成整片制作提示词。这一组命令只给命令行与客户端后端，用来看全文。`,
});

defineOp({
  name: 'prompt_show',
  cli: ['prompt', 'show'],
  summary: '打印这个项目现在组合出的整片制作提示词',
  description:
    '按项目 onset.flow.json 记的流程与画幅，把制作提示词的段落组合出来原样打印：已装的第三方插件的补充与说明照样插进去，与「开始制作」发给编排工具的是同一份。没有流程记录的目录直接报错。',
  examples: ['prompt_show({})'],
  scopes: ['cli'],
  params: { project_root: projectRoot },
  run: (p, { out }) => {
    const { prompt, label, warnings } = project.runPrompt(path.resolve(str(p.project_root)), '');
    const text = prompt.toString('utf8');
    out.write(text);
    // 读不出来、但这个项目用不到的插件：不混进提示词全文，放在结构化结果里。
    return { data: { flow: label, bytes: prompt.length, warnings } };
  },
});

defineOp({
  name: 'flow_guide',
  cli: ['prompt', 'guide'],
  summary: '读取当前项目某个制作阶段的规则与关卡',
  description: '沿用项目流程的原编号。stage 取制作路线列出的阶段 ID，例如 timeline、render 或 review。',
  examples: ['flow_guide({"stage":"render"})'],
  params: {
    project_root: projectRoot,
    stage: { type: 'string', description: '制作阶段 ID', required: true, positional: 0 },
  },
  run: (p, { out }) => {
    const stage = str(p.stage);
    if (!/^[a-z][a-z0-9-]*$/.test(stage)) throw new Error('stage 必须是制作路线中的阶段 ID');
    out.write(project.composeProjectPrompt(path.resolve(str(p.project_root)), stage, true).text);
  },
});
