/**
 * validate 组。组下的 video、beat、reads 在各自的文件里定义，
 * validate cast、song、publish 由内置插件登记（engine 的 plugins/），都由 mountOps 挂进同一个组。
 */
import { defineGroup } from './ops/cli';
// 这个文件只登记操作，没有别的地方 import 它。
import './reads_cmd';

defineGroup({
  path: ['validate'],
  summary: '校验发布配置',
  description: `只读校验，不修改任何项目文件。
校验通过时给出一行结论，失败时把具体不符项一次列全。`,
});
