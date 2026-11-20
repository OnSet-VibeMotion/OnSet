/**
 * shared_component_promote：把渲染器在代表镜头里做好的共用组件登记进项目（scene/components.ts）。
 */
import path from 'node:path';
import * as scene from '@onset/engine/scene';
import { bool, str } from './ops/common';
import { defineGroup } from './ops/cli';
import { defineOp } from './ops/op';

defineGroup({
  path: ['component'],
  summary: '共用组件',
  description: '跨镜头保持同一个样子的物件，由一个渲染器做一次、登记进项目，其余镜头在 scene.json 的 components 里引用。',
});

defineOp({
  name: 'shared_component_promote',
  cli: ['component', 'promote'],
  summary: '把渲染器做好的共用组件登记进项目，供其他镜头引用',
  description: `跨镜头要保持同一个样子的物件（同一个角色、铭牌、图标、图表外壳），由一个渲染器做一次，其余镜头直接引用，
不要在每个镜头的 prompt.md 里各写一遍、让各个渲染器各画各的。

做法：
  1. 在代表镜头的 prompt.md 里要求渲染器把这个物件做成独立模块，放在镜头目录的 ${scene.ComponentExportDir}/<名字>/：
     入口文件（.js / .mjs / .css）加 ${scene.ComponentReadme}，写清怎么引用、能传什么参数、长什么样；
     本镜头自己也从那里引用。
  2. 这个镜头验收通过后，用本工具登记：onset 把它复制到项目的 ${scene.ComponentsDir}/<名字>/。
  3. 整片计划已声明的使用镜头自动挂载 ${scene.ComponentMountDir}/<名字>/。没有整片计划的旧项目仍可在 scene.json 声明 components。

组件的代码始终出自渲染器，这里只做登记。已登记的组件内容不同时要 replace：换掉它，引用它的镜头输入
随之变化，都要重渲染。只收普通文件（不收符号链接），上限 ${scene.MaxComponentBytes / 1024 / 1024} MB。`,
  examples: [
    'shared_component_promote({"scene": "scenes/scene-004", "name": "cube-badge"})',
    '# 组件不在默认的 export/<名字>/',
    'shared_component_promote({"scene": "scenes/scene-004", "name": "cube-badge", "from": "parts/badge"})',
    '# 修好后换掉已登记的版本',
    'shared_component_promote({"scene": "scenes/scene-004", "name": "cube-badge", "replace": true})',
  ],
  params: {
    scene: { type: 'string', description: '做出组件的镜头目录', required: true, positional: 0 },
    name: { type: 'string', description: '组件名：小写字母开头，只用小写字母、数字与 -', required: true },
    from: { type: 'string', description: `组件在镜头目录里的位置，缺省 ${scene.ComponentExportDir}/<名字>` },
    replace: { type: 'boolean', description: '已登记的同名组件内容不同时换掉它（引用它的镜头都要重渲染）' },
  },
  run: (p, { out }) => {
    const dir = path.resolve(str(p.scene));
    const root = scene.findProjectRoot(dir);
    if (!root) throw new Error(`找不到 ${dir} 所在的项目（没有 onset.conf）`);
    const name = str(p.name);
    const result = scene.promoteComponent(root, dir, name, str(p.from), bool(p.replace));
    if (result.unchanged) out.write(`共用组件 ${name} 已经是这个内容，没有改动：${result.dir}\n`);
    else out.write(`${result.replaced ? '已换掉' : '已登记'}共用组件 ${name}：${result.dir}（${result.files} 个文件，${result.bytes} 字节）\n`);
    const assignment = scene.loadComponentPlan(root).find(row => row.name === name);
    if (assignment) out.write(`计划中的使用镜头会自动挂载：${assignment.scenes.join('、')}\n`);
    else out.write(`其余镜头在 scene.json 写 "components": ["${name}"] 即可引用。\n`);
    return { data: result };
  },
});
