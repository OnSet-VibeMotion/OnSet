import fs from 'node:fs';
import path from 'node:path';
import { goExt } from '../../gofmt';
import { sortedEntries } from './library';

/**
 * 读出技能目录里 demo/ 与 core/ 下的脚本和页面（相对路径 → 内容），
 * 作为挑 three.js 模块与 core/assets 文件的依据。
 */
export function sourceTexts(skillDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const entry of sortedEntries(dir)) {
      const file = path.join(dir, entry.name);
      const childRel = rel + '/' + entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || (entry.name === 'assets' && rel === 'core')) continue;
        walk(file, childRel);
        continue;
      }
      switch (goExt(entry.name).toLowerCase()) {
        case '.js':
        case '.mjs':
        case '.html':
        case '.json':
          break;
        default:
          continue;
      }
      out.set(childRel, fs.readFileSync(file, 'utf8'));
    }
  };
  for (const sub of ['demo', 'core']) {
    const root = path.join(skillDir, sub);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      continue;
    }
    // 根是文件时 WalkDir 只看它自己，而 demo / core 没有扩展名，不会被收进来。
    if (!stat.isDirectory()) continue;
    walk(root, sub);
  }
  return out;
}

// 按引用挑 three.js 模块与素材的实现是通用的（第三方插件的风格库也用），在 filmstyle/select.ts。
export { referencedAssets, threeClosure } from '../../filmstyle/select';
