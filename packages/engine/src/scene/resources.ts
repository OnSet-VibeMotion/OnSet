/** 只消费技能与风格来源的声明，不依赖任何具体风格插件。 */
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '../filmstyle';
import * as renderassets from '../renderassets';
import { compareBytes } from '../gojson';
import { componentMounts } from './components';
import { missingComponents, sceneComponentPlan } from './component-plan';
import { VerificationError } from './verification';
import { allSkills, FilmStyleOwnKey } from './skills';
import { findProjectRoot, type Scene } from './scene';

export function resourceFiles(s: Scene, resolved: Record<string, string>): renderassets.Resource[] {
  const root = findProjectRoot(s.directory);
  if (!root || path.resolve(root) === path.resolve(s.directory)) return [];
  const mounts: renderassets.Mount[] = [
    { from: path.join(root, 'assets/fonts'), to: 'assets/fonts' },
    { from: path.join(root, 'assets/vendor'), to: 'vendor' },
    ...componentMounts(root, sceneComponentPlan(s, root).names),
  ];
  for (const skill of allSkills()) {
    const dir = resolved[skill.name];
    if (!dir) continue;
    for (const rel of skill.runtimeAssets ?? []) mounts.push({ from: path.join(dir, skill.name, rel), to: rel });
  }
  const style = s.film_style === ''
    ? resolved[filmstyle.SkillName] ? path.join(resolved[filmstyle.SkillName]!, filmstyle.SkillName) : ''
    : s.film_style === filmstyle.NoFilmStyle ? '' : resolved[FilmStyleOwnKey] ?? '';
  if (style) {
    const manifest = filmstyle.readManifest(path.join(style, filmstyle.ManifestFile));
    const source = manifest ? filmstyle.sourceByID(manifest.source) : undefined;
    for (const rel of source?.runtimeAssets ?? []) mounts.push({ from: path.join(style, rel), to: rel });
  }
  return renderassets.collect(mounts);
}

/** 返回本次实际挂载的字节指纹；启动前与输入指纹对照，防止准备期间来源被改写。 */
export function prepareResources(s: Scene, resolved: Record<string, string>): Record<string, string> {
  const pending = missingComponents(s).filter(component => component.source_scene !== '');
  if (pending.length) {
    throw new VerificationError(s.directory, pending.map(({ name, source_scene }) =>
      `共用组件 ${name} 还没有登记${source_scene ? `，先验收产出镜头 ${source_scene}` : ''}，再调用 shared_component_promote()。`));
  }
  const files = resourceFiles(s, resolved);
  if (files.length > 0) renderassets.prepare(findProjectRoot(s.directory), s.directory, files);
  renderassets.verify(s.directory);
  return renderassets.inputs(s.directory, []);
}

/** 未启用共享资源的旧镜头逐字不变，不因升级被判 Stale；run 准备后才注入。 */
export function resourceSection(s: Scene, resolved: Record<string, string>, directorBrief = false): string {
  if (!fs.existsSync(path.join(s.directory, renderassets.ManifestFile))) return '';
  const files = resourceFiles(s, resolved);
  const paths = [...files.map((file) => file.path), ...renderassets.paths(s.directory)];
  const locations = [...new Set(paths.map((rel) => {
    const parts = rel.split('/');
    return parts.length === 1 ? rel : parts.slice(0, parts[0] === 'assets' || parts[0] === 'node_modules' ? 2 : 1).join('/') + '/';
  }))].sort(compareBytes);
  const readyFiles = directorBrief ? [...new Set(paths)].filter(rel =>
    /^assets\/fonts\/[^\r\n`]+\.(?:woff2?|ttf|otf)$/i.test(rel)
    || /^vendor\/[^\r\n`]+\.(?:m?js|css)$/i.test(rel)
    || /^(?:[^/\r\n`]+\/)*[^/\r\n`]+\.(?:m?js|css)$/i.test(rel),
  ).sort(compareBytes).slice(0, 12) : [];
  return '\n共享渲染资源（强制，优先于技能里的复制说明）：\n' +
    '- 引擎已在本镜头准备这些相对路径：' + locations.join('、') + '。文件清单见 ' + renderassets.ManifestFile + '。\n' +
    (readyFiles.length ? '- 已挂载的字体和库可直接引用：' + readyFiles.map(file => '`' + file + '`').join('、') + '。\n' : '') +
    '- 这些文件通过相对链接共用项目内的固定内容（不支持链接时是副本），不要再次复制、下载或改写，也不要删除链接。HTML、CSS 与 import 仍引用上面的镜头内路径，不引用链接目标。\n' +
    '- 要改某个库时，另存为本镜头自己的新文件并改引用；模板可以读出来另写 index.html。镜头自己的 scene.js、onset-scene.js 与合成代码不共享。\n';
}
