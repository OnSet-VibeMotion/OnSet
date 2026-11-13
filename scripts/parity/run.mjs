#!/usr/bin/env node
/**
 * Go 版与 TS 版 am 的双跑对照。
 *
 * 每个用例：先用 Go 版 am 按 setup 建一个样例项目，复制成两份；同一条命令分别用 Go 版与 TS 版
 * 各跑一份，比对退出码、stdout、stderr（临时目录路径统一换成 <PROJECT>）与两份目录里每个文件的内容。
 * 用户已有的项目都是 Go 版写的，TS 版写出的文件差一个字节，指纹与记忆库就会对不上。
 *
 * 用法：
 *   node scripts/parity/run.mjs [用例名过滤…]
 * 环境变量：
 *   AM_GO   Go 版 am（默认 ~/.local/bin/am；也可以是 `go run ./cmd/am` 构建出的二进制）
 *   AM_TS   TS 版 am 的入口（默认 packages/cli/dist/am.cjs，用 node 运行）
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './cases.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const goAm = process.env.AM_GO || path.join(os.homedir(), '.local/bin/am');
const tsAm = process.env.AM_TS || path.join(repo, 'packages/cli/dist/am.cjs');

/** 两边共用的环境：隔离 HOME 与记忆库，关掉颜色，固定语言。 */
function env(home) {
  return {
    ...process.env,
    HOME: home,
    AM_MEMORY_DIR: path.join(home, 'memory'),
    AM_ASSETS_DIR: path.join(repo, 'assets'),
    NO_COLOR: '1',
    LANG: 'C.UTF-8',
  };
}

function run(which, args, cwd, home, input) {
  const [cmd, argv] = which === 'go' ? [goAm, args] : [process.execPath, [tsAm, ...args]];
  const result = spawnSync(cmd, argv, { cwd, env: env(home), input, encoding: 'utf8', timeout: 120_000 });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 目录下全部文件 → 内容摘要；忽略用户级缓存与本次运行必然不同的文件（由用例声明）。 */
function snapshot(dir, ignore) {
  const out = new Map();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (ignore.some((pattern) => pattern.test(child))) continue;
      if (entry.isDirectory()) walk(child);
      else out.set(child, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, child))).digest('hex'));
    }
  };
  walk('');
  return out;
}

function normalize(text, dir) {
  return text.split(fs.realpathSync(dir)).join('<PROJECT>').split(dir).join('<PROJECT>');
}

const filters = process.argv.slice(2);
let failed = 0;
for (const c of cases) {
  if (filters.length && !filters.some((f) => c.name.includes(f))) continue;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-parity-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const base = path.join(root, 'base');
  fs.mkdirSync(base);
  for (const step of c.setup ?? []) {
    const r = run('go', step, base, home);
    if (r.code !== 0) throw new Error(`用例 ${c.name} 的准备步骤失败：am ${step.join(' ')}\n${r.stderr}`);
  }
  c.prepare?.(base);
  const problems = [];
  for (const args of c.commands) {
    const goDir = path.join(root, 'go');
    const tsDir = path.join(root, 'ts');
    fs.rmSync(goDir, { recursive: true, force: true });
    fs.rmSync(tsDir, { recursive: true, force: true });
    fs.cpSync(base, goDir, { recursive: true });
    fs.cpSync(base, tsDir, { recursive: true });
    const g = run('go', args, goDir, home, c.stdin);
    const t = run('ts', args, tsDir, home, c.stdin);
    const label = `am ${args.join(' ')}`;
    if (g.code !== t.code) problems.push(`${label}：退出码 Go=${g.code} TS=${t.code}`);
    for (const stream of ['stdout', 'stderr']) {
      const a = normalize(g[stream], goDir);
      const b = normalize(t[stream], tsDir);
      if (a !== b) problems.push(`${label}：${stream} 不同\n--- Go\n${a}\n--- TS\n${b}`);
    }
    const ignore = [/^\.git\//, ...(c.ignore ?? [])];
    const ga = snapshot(goDir, ignore);
    const ta = snapshot(tsDir, ignore);
    for (const file of new Set([...ga.keys(), ...ta.keys()])) {
      if (ga.get(file) !== ta.get(file)) problems.push(`${label}：文件 ${file} ${!ga.has(file) ? '只有 TS 写了' : !ta.has(file) ? '只有 Go 写了' : '内容不同'}`);
    }
  }
  if (problems.length) {
    failed++;
    console.log(`✗ ${c.name}\n  ${problems.join('\n  ')}`);
  } else {
    console.log(`✓ ${c.name}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
