// 移植自 internal/project/rules.go。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goPathError } from '../gofmt';
import { rejectSymlinkPath } from './init';

/**
 * RulesTemplate 是项目规则模板在项目内的相对路径。
 * 模板随 am init 下发，用户可以按项目改写；生成的指令文件永远由它派生。
 */
export const RulesTemplate = 'templates/project-rules.md';

/**
 * writeRules 把项目规则模板渲染成 filename —— 编排工具会自动读取的项目级指令文件。
 *
 * 各家 AI CLI 都从工作目录向上递归读取这类文件，但文件名互不相同，且写错时
 * 不报错只静默失效，所以文件名由 tools.projectRulesFilename 解析后传进来。
 *
 * 模板缺失时返回空路径且不报错：老版本 am init 出来的项目没有这份模板，
 * 缺规则不该阻断整条制作流程，由调用方降级告警。
 *
 * 目标已存在且内容不同时报错而不是覆盖：那多半是用户自己写的指令文件，
 * 静默覆盖会连人带规则一起丢。这与 initialize 拒绝覆盖异内容文件的行为一致。
 */
export function writeRules(root: string, filename: string): string {
  root = path.resolve(root);
  const source = path.join(root, ...RulesTemplate.split('/'));
  let body: Buffer;
  try {
    body = fs.readFileSync(source);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '';
    throw new Error(`读取 ${RulesTemplate}: ${goPathError(code === 'EISDIR' ? 'read' : 'open', source, err)}`, { cause: err });
  }

  const destination = path.join(root, filename);
  rejectSymlinkPath(root, destination);
  let existing: Buffer | null = null;
  try {
    existing = fs.readFileSync(destination);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(`检查 ${destination}: ${goPathError(code === 'EISDIR' ? 'read' : 'open', destination, err)}`, { cause: err });
    }
  }
  if (existing !== null) {
    if (existing.equals(body)) return destination;
    throw new Error(
      `${destination} 已存在且内容与 ${RulesTemplate} 不同：如果它是上一次生成的，删除后重跑；如果是你自己写的规则，把内容并进模板`,
    );
  }

  atomicWrite(destination, body, 0o644);
  return destination;
}
