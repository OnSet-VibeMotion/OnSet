/**
 * 预设生成器的命令行入口（替代 go generate ./internal/preset/）。在仓库任意位置运行：
 *
 *   npm run generate -w @am/engine
 *   npm run generate -w @am/engine -- -examples -style pixel-arcade-v1 -preset vertical-9x16
 *
 * 不带参数时只写文本产物（CI 的 generated-assets 门禁要求重跑后 git diff 为空）；
 * -examples 另用 rsvg-convert 重渲染示例 PNG，配合 -style / -preset 限定范围，免得给没改过的风格带来二进制 diff。
 */
import { generate, repoRoot, selectStyles, selectTargets } from './gen';

function flag(name: string): string {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `-${name}` || a === `--${name}` || a.startsWith(`-${name}=`) || a.startsWith(`--${name}=`));
  if (i < 0) return '';
  const a = args[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[i + 1] ?? '');
}

const examples = process.argv.slice(2).some((a) => a === '-examples' || a === '--examples');

try {
  const repo = repoRoot();
  generate(repo, repo, selectTargets(flag('preset')), selectStyles(flag('style')), examples, { write: (t) => process.stdout.write(t) });
} catch (err) {
  process.stderr.write(`错误: ${(err as Error).message}\n`);
  process.exit(1);
}
