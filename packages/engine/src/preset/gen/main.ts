/**
 * 画幅生成器的命令行入口。在仓库任意位置运行：
 *
 *   npm run generate -w @onset/engine
 *   npm run generate -w @onset/engine -- -preset vertical-9x16
 *
 * CI 的 generated-assets 门禁要求重跑后 git diff 为空。
 */
import { generate, repoRoot, selectTargets } from './gen';

function flag(name: string): string {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `-${name}` || a === `--${name}` || a.startsWith(`-${name}=`) || a.startsWith(`--${name}=`));
  if (i < 0) return '';
  const a = args[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[i + 1] ?? '');
}

try {
  const repo = repoRoot();
  generate(repo, repo, selectTargets(flag('preset')), { write: (t) => process.stdout.write(t) });
} catch (err) {
  process.stderr.write(`错误: ${(err as Error).message}\n`);
  process.exit(1);
}
