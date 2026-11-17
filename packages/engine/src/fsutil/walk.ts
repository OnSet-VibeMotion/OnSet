// 项目树的遍历：Studio 的轮次快照（studio/turns.ts）与第三方站操作的越界检查（flow/scope.ts）共用。
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';

/**
 * 项目树遍历时不进入的目录（Studio 的轮次快照、文件树与第三方站操作的越界检查共用）：
 * attempts 与 .studio-frames 是渲染与抽帧的副产物，.agents 是技能树，.qoder、.claude、.codex、
 * .codebuddy、.opencode、.minimax 是各家渲染工具自己的目录（渲染时 scene.stageRendererSkills 在镜头目录里放技能链接，渲染完删掉，
 * 不算项目文件的改动），.onset 是引擎管理的共享资源（随项目保存，但不参与对话回退），其余是依赖与工具缓存。
 */
export const ProjectSkippedDirs: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'attempts',
  '.studio-frames',
  '.agents',
  '.onset',
  '.qoder',
  '.claude',
  '.codex',
  '.codebuddy',
  '.opencode',
  '.minimax',
  '__pycache__',
  '.venv',
  '.cache',
]);

/** 同步遍历（filepath.WalkDir 的词法顺序）。visit 返回 'skip' 跳过目录。 */
export function walkDir(root: string, visit: (file: string, entry: fs.Dirent | null, isRoot: boolean) => 'skip' | 'stop' | void): void {
  let stopped = false;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareBytes(a.name, b.name));
    for (const entry of entries) {
      if (stopped) return;
      const full = path.join(dir, entry.name);
      const result = visit(full, entry, false);
      if (result === 'stop') {
        stopped = true;
        return;
      }
      if (entry.isDirectory() && result !== 'skip') walk(full);
    }
  };
  walk(root);
}
