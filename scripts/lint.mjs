import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIOME_BIN = path.join(ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');

export const MAX_FILE_LINES = 400;
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
const SOURCE_SCAN_ROOTS = [
  'packages/engine/src',
  'packages/cli/src',
  'apps/desktop/src',
  'apps/desktop/e2e',
  'scripts',
];
const MAX_LINE_ROOTS = ['packages/engine/src', 'packages/cli/src', 'apps/desktop/src', 'scripts'];
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'out', 'release', 'testdata', 'test-results', 'vendor']);
const BIOME_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.jsonc']);
const LINE_SEP_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.json']);
const MAX_LINE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const TEST_FILE_RE = /\.(test|spec)\.[^.]+$/;
const EXCLUDED_FILES = new Set(['packages/cli/src/agent/import-meta-url.cjs']);

function walkSourceFiles(rootDir, scanRoots, exts) {
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile() || !exts.has(path.extname(entry.name))) continue;
      files.push({ full, rel: path.relative(rootDir, full).replace(/\\/g, '/') });
    }
  }
  for (const rel of scanRoots) walk(path.join(rootDir, rel));
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function countLines(content) {
  if (content.length === 0) return 0;
  const lines = content.split('\n');
  return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** 扫描源码目录中禁止出现的裸 U+2028 / U+2029 行分隔符（见 packages/engine/CONVENTIONS.md）。 */
export function checkLineSeparators(rootDir = ROOT, scanRoots = SOURCE_SCAN_ROOTS) {
  const violations = [];
  for (const { full, rel } of walkSourceFiles(rootDir, scanRoots, LINE_SEP_EXTS)) {
    const content = fs.readFileSync(full, 'utf8');
    if (!/[\u2028\u2029]/.test(content)) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines[i].length; j++) {
        const code = lines[i].charCodeAt(j);
        if (code === 0x2028 || code === 0x2029) {
          violations.push({ file: rel, line: i + 1, column: j + 1, codePoint: `U+${code.toString(16).toUpperCase()}` });
        }
      }
    }
  }
  return violations;
}

/** 校验全仓业务源码单文件行数硬上限（≤ 400 行，无历史豁免；豁免 CSS 与测试文件）。 */
export function checkMaxFileLines(rootDir = ROOT, { maxLines = MAX_FILE_LINES, scanRoots = MAX_LINE_ROOTS } = {}) {
  const violations = [];
  for (const { full, rel } of walkSourceFiles(rootDir, scanRoots, MAX_LINE_EXTS)) {
    if (TEST_FILE_RE.test(rel)) continue;
    const lines = countLines(fs.readFileSync(full, 'utf8'));
    if (lines > maxLines) {
      violations.push({ file: rel, lines, limit: maxLines });
    }
  }
  return violations;
}

/** 校验 package-lock.json 中所有外部包的 resolved 均指向官方 npmjs registry。 */
export function checkLockfileRegistry(lockfilePath = path.join(ROOT, 'package-lock.json')) {
  if (!fs.existsSync(lockfilePath)) return [];
  const lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  const violations = [];

  if (lock.packages && typeof lock.packages === 'object') {
    for (const [pkg, meta] of Object.entries(lock.packages)) {
      if (!meta || typeof meta !== 'object' || meta.link) continue;
      if (typeof meta.resolved === 'string' && !meta.resolved.startsWith(OFFICIAL_REGISTRY)) {
        violations.push({ pkg: pkg || '<root>', resolved: meta.resolved });
      }
    }
  }

  function walkLegacyDeps(deps) {
    if (!deps || typeof deps !== 'object') return;
    for (const [pkg, meta] of Object.entries(deps)) {
      if (!meta || typeof meta !== 'object') continue;
      if (typeof meta.resolved === 'string' && !meta.resolved.startsWith(OFFICIAL_REGISTRY)) {
        violations.push({ pkg, resolved: meta.resolved });
      }
      if (meta.dependencies) walkLegacyDeps(meta.dependencies);
    }
  }
  walkLegacyDeps(lock.dependencies);

  return violations;
}

/** 将候选路径过滤为 Biome 管辖范围内且存在的文件。 */
export function filterBiomeFiles(paths, rootDir = null) {
  const out = new Set();
  for (const raw of paths) {
    const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel) continue;
    const isRootConfig = rel === 'package.json' || rel === 'biome.json';
    const inScope =
      isRootConfig || rel.startsWith('packages/') || rel.startsWith('apps/') || rel.startsWith('scripts/');
    if (!inScope || EXCLUDED_FILES.has(rel) || rel.endsWith('.tmpl')) continue;
    if (rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) continue;
    if (!BIOME_EXTS.has(path.extname(rel))) continue;
    if (rootDir && !fs.existsSync(path.join(rootDir, rel))) continue;
    out.add(rel);
  }
  return [...out].sort();
}

function gitLines(args, cwd) {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** 根据本地工作区或 CI 上下文解析增量改动文件列表。 */
export function resolveChangedFiles({ rootDir = ROOT, base = '', env = process.env } = {}) {
  const candidates = new Set();
  if (base) {
    const diff = gitLines(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], rootDir);
    if (diff === null) throw new Error(`无法计算与基准 ${base} 的 git diff`);
    for (const file of diff) candidates.add(file);
  } else if (env.GITHUB_BASE_REF) {
    const baseRef = `origin/${env.GITHUB_BASE_REF}`;
    const diff =
      gitLines(['diff', '--name-only', '--diff-filter=ACMR', `${baseRef}...HEAD`], rootDir) ??
      gitLines(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD~1...HEAD'], rootDir) ??
      [];
    for (const file of diff) candidates.add(file);
  } else if (env.CI === 'true') {
    const diff = gitLines(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD~1...HEAD'], rootDir) ?? [];
    for (const file of diff) candidates.add(file);
  }

  if (!env.CI || base) {
    const working = gitLines(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'], rootDir) ?? [];
    const untracked = gitLines(['ls-files', '--others', '--exclude-standard'], rootDir) ?? [];
    for (const file of [...working, ...untracked]) candidates.add(file);
  }
  return filterBiomeFiles([...candidates], rootDir);
}

function runBiome(args, rootDir = ROOT) {
  const result = spawnSync(process.execPath, [BIOME_BIN, ...args], { cwd: rootDir, stdio: 'inherit' });
  return result.status ?? 1;
}

function parseCliArgs(argv) {
  const [command = 'lint', ...rest] = argv;
  let all = false;
  let verbose = false;
  let base = '';
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--all') all = true;
    else if (arg === '--verbose') verbose = true;
    else if (arg === '--base' && i + 1 < rest.length) base = rest[++i];
    else if (arg.startsWith('--base=')) base = arg.slice('--base='.length);
    else if (!arg.startsWith('-')) files.push(arg);
  }
  return { command, all, verbose, base, files };
}

function runRepoGates(rootDir = ROOT) {
  let ok = true;

  const sepViolations = checkLineSeparators(rootDir);
  if (sepViolations.length > 0) {
    ok = false;
    console.error(
      `\n[onset-lint] 发现 ${sepViolations.length} 处裸 U+2028/U+2029 行分隔符（请改用 \\u2028 / \\u2029 转义）：`,
    );
    for (const v of sepViolations) console.error(`  - ${v.file}:${v.line}:${v.column} (${v.codePoint})`);
  }

  const lineViolations = checkMaxFileLines(rootDir);
  if (lineViolations.length > 0) {
    ok = false;
    console.error(`\n[onset-lint] 发现 ${lineViolations.length} 个业务源码文件超过 ${MAX_FILE_LINES} 行上限：`);
    for (const v of lineViolations) {
      console.error(`  - ${v.file}: ${v.lines} 行（上限 ${v.limit}，请拆分为更小模块）`);
    }
  }

  const lockViolations = checkLockfileRegistry(path.join(rootDir, 'package-lock.json'));
  if (lockViolations.length > 0) {
    ok = false;
    console.error(
      `\n[onset-lint] package-lock.json 存在 ${lockViolations.length} 个非官方 registry 地址（必须指向 ${OFFICIAL_REGISTRY}）：`,
    );
    for (const v of lockViolations.slice(0, 20)) console.error(`  - ${v.pkg}: ${v.resolved}`);
    if (lockViolations.length > 20) console.error(`  ... 其余 ${lockViolations.length - 20} 条已省略`);
  }

  return ok;
}

function main() {
  const { command, all, verbose, base, files } = parseCliArgs(process.argv.slice(2));

  if (command === 'lint') {
    const levelArgs = verbose ? [] : ['--diagnostic-level=error'];
    const biomeStatus = runBiome(['lint', ...levelArgs, ...files]);
    const gatesOk = runRepoGates(ROOT);
    if (biomeStatus !== 0 || !gatesOk) process.exit(1);
    console.log('[onset-lint] Biome lint 与仓库静态检查全部通过。');
    return;
  }

  if (command === 'lint:fix') {
    if (all) process.exit(runBiome(['lint', '--write']));
    const targets = files.length > 0 ? filterBiomeFiles(files, ROOT) : resolveChangedFiles({ rootDir: ROOT, base });
    if (targets.length === 0) {
      console.log('[onset-lint] 没有需要修复的改动文件。');
      return;
    }
    process.exit(runBiome(['lint', '--write', '--no-errors-on-unmatched', ...targets]));
  }

  if (command === 'format:check' || command === 'format') {
    const writeFlag = command === 'format' ? ['--write'] : [];
    const checkArgs = ['check', '--linter-enabled=false', '--formatter-enabled=true', '--assist-enabled=true'];
    if (all) process.exit(runBiome([...checkArgs, ...writeFlag]));
    const targets = files.length > 0 ? filterBiomeFiles(files, ROOT) : resolveChangedFiles({ rootDir: ROOT, base });
    if (targets.length === 0) {
      console.log(`[onset-lint] ${command}: 没有需要处理的改动文件。`);
      return;
    }
    const status = runBiome([...checkArgs, ...writeFlag, '--no-errors-on-unmatched', ...targets]);
    if (status !== 0 && command === 'format:check') {
      console.error('\n[onset-lint] 以上改动文件格式或 import 顺序不符合规范，运行 `npm run format` 自动修复。');
    }
    process.exit(status);
  }

  console.error(`未知子命令: ${command}（支持 lint | lint:fix | format:check | format）`);
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
