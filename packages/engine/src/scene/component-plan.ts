import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot, type Scene } from './scene';
import { componentDir, ComponentExportDir, ComponentMountDir, ComponentReadme, verifyComponentNames } from './components';
import { VerificationError } from './verification';

export const ComponentPlanFile = 'production/component-plan.json';

export interface ComponentAssignment {
  name: string;
  source_scene: string;
  scenes: string[];
}

export function parseComponentPlan(value: unknown, ids?: ReadonlySet<string>): ComponentAssignment[] {
  if (!Array.isArray(value)) throw new Error('shared_components 必须是数组');
  const plan: ComponentAssignment[] = [];
  const deps = new Map<string, Set<string>>();
  function validId(id: unknown): id is string {
    return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(id) && (!ids || ids.has(id));
  }
  for (const row of value) {
    if (typeof row?.name !== 'string' || !validId(row.source_scene) || !Array.isArray(row.scenes) ||
      row.scenes.length === 0 || !row.scenes.every(validId) || new Set(row.scenes).size !== row.scenes.length) {
      throw new Error('shared_components 的每项须填组件名 name、有效的产出镜头 source_scene 和非空且不重复的使用镜头 scenes');
    }
    const { name, source_scene, scenes } = row as ComponentAssignment;
    plan.push({ name, source_scene, scenes });
    for (const id of scenes) {
      const required = deps.get(id) ?? new Set<string>();
      required.add(source_scene);
      deps.set(id, required);
    }
  }
  verifyComponentNames(plan.map(row => row.name));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error(`共用组件有循环依赖：${[...visiting, id].join(' → ')}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const source of deps.get(id) ?? []) visit(source);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of deps.keys()) visit(id);
  return plan;
}

export function loadComponentPlan(root: string): ComponentAssignment[] {
  if (!root) return [];
  const file = path.join(root, ComponentPlanFile);
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info) return [];
  if (!info.isFile() || fs.lstatSync(path.dirname(file)).isSymbolicLink()) {
    throw new Error(`${ComponentPlanFile} 必须是项目内的普通文件`);
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.schema !== 1) throw new Error(`${ComponentPlanFile} 的 schema 必须为 1`);
  return parseComponentPlan(value.shared_components);
}

/** Apply film assignments only to the project's canonical scene directories. */
export function sceneComponentPlan(s: Pick<Scene, 'id' | 'directory' | 'components'>, root = findProjectRoot(s.directory)) {
  const film = root && path.resolve(s.directory) === path.resolve(root, 'scenes', s.id) ? loadComponentPlan(root) : [];
  const imports = film.filter(row => row.scenes.includes(s.id));
  return {
    imports,
    exports: film.filter(row => row.source_scene === s.id),
    names: [...new Set([...s.components, ...imports.map(row => row.name)])],
  };
}

export function missingComponents(s: Scene, root = findProjectRoot(s.directory)): { name: string; source_scene: string }[] {
  const { imports, names } = sceneComponentPlan(s, root);
  return names.filter(name => !root || !fs.existsSync(path.join(componentDir(root, name), ComponentReadme)))
    .map(name => ({ name, source_scene: imports.find(row => row.name === name)?.source_scene ?? '' }));
}

export function componentExportSection(exports: readonly ComponentAssignment[]): string {
  if (!exports.length) return '';
  return '\n本镜头负责产出整片共用组件：\n' + exports.map(({ name }) =>
    `- 在 ${ComponentExportDir}/${name}/ 交付入口（JS 或 CSS）与 ${ComponentReadme}，说明如何引用及可传参数；本镜头从该目录直接引用组件。把文案、位置、尺寸和帧区间留给各镜头传参。\n`,
  ).join('');
}

export function verifyComponentReferences(s: Scene, files: readonly string[]): void {
  const { imports, exports } = sceneComponentPlan(s);
  const required = [
    ...imports.map(row => `${ComponentMountDir}/${row.name}/`),
    ...exports.map(row => `${ComponentExportDir}/${row.name}/`),
  ];
  const problems = required.filter(dir => !files.some(file => file.startsWith(dir)))
    .map(dir => `合成入口必须实际引用共用组件 ${dir} 中的入口文件`);
  if (problems.length) throw new VerificationError(s.directory, problems);
}
