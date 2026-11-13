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
 *
 * 用例声明 memory: true 时，记忆库也参与比对：准备阶段写进 <HOME>/memory 的记忆库在每条命令前
 * 复制成两份，Go 与 TS 各用一份（AM_MEMORY_DIR），跑完比对两份记忆库的文件树。这类用例的
 * 项目目录三份都叫 proj（记忆按项目目录名区分项目，两边的名字必须相同）。
 * scrub 是 [正则, 替换] 列表，比对前作用于 stdout、stderr、文件路径与文件内容，用来抹掉时间戳、
 * 随机编号这类每次运行必然不同的部分。
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

function run(which, args, cwd, home, input, extraEnv = {}) {
  const [cmd, argv] = which === 'go' ? [goAm, args] : [process.execPath, [tsAm, ...args]];
  const result = spawnSync(cmd, argv, { cwd, env: { ...env(home), ...extraEnv }, input, encoding: 'utf8', timeout: 120_000 });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * 目录下全部文件 → 内容摘要；忽略用户级缓存与本次运行必然不同的文件（由用例声明）。
 * clean 非空时先用它清洗路径与内容（同一路径清洗后撞名的，摘要排序后拼在一起）。
 */
function snapshot(dir, ignore, clean = null) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (ignore.some((pattern) => pattern.test(child))) continue;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      let body = fs.readFileSync(path.join(dir, child));
      let key = child;
      if (clean) {
        key = clean(child);
        body = clean(body.toString('utf8'));
      }
      const digest = crypto.createHash('sha256').update(body).digest('hex');
      out.set(key, [...(out.get(key) ?? []), digest]);
    }
  };
  walk('');
  for (const [key, list] of out) out.set(key, list.sort().join('+'));
  return out;
}

function replacePath(text, dir, label) {
  return text.split(fs.realpathSync(dir)).join(label).split(dir).join(label);
}

function normalize(text, dir, memoryDir = '', scrub = []) {
  let out = replacePath(text, dir, '<PROJECT>');
  if (memoryDir && fs.existsSync(memoryDir)) out = replacePath(out, memoryDir, '<MEMORY>');
  for (const [pattern, replacement] of scrub) out = out.replace(pattern, replacement);
  return out;
}

const filters = process.argv.slice(2);
let failed = 0;
for (const c of cases) {
  if (filters.length && !filters.some((f) => c.name.includes(f))) continue;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-parity-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const leaf = (side) => (c.memory ? path.join(root, side, 'proj') : path.join(root, side));
  const base = leaf('base');
  fs.mkdirSync(base, { recursive: true });
  for (const step of c.setup ?? []) {
    const r = run('go', step, base, home);
    if (r.code !== 0) throw new Error(`用例 ${c.name} 的准备步骤失败：am ${step.join(' ')}\n${r.stderr}`);
  }
  const baseMemory = path.join(home, 'memory');
  c.prepare?.(base, { home, memory: baseMemory, env: env(home) });
  const scrub = c.scrub ?? [];
  const problems = [];
  for (const args of c.commands) {
    const goDir = leaf('go');
    const tsDir = leaf('ts');
    const goMemory = path.join(root, 'go-memory');
    const tsMemory = path.join(root, 'ts-memory');
    for (const dir of [goDir, tsDir, goMemory, tsMemory]) fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(base, goDir, { recursive: true });
    fs.cpSync(base, tsDir, { recursive: true });
    if (c.memory && fs.existsSync(baseMemory)) {
      fs.cpSync(baseMemory, goMemory, { recursive: true });
      fs.cpSync(baseMemory, tsMemory, { recursive: true });
    }
    const g = run('go', args, goDir, home, c.stdin, c.memory ? { AM_MEMORY_DIR: goMemory } : {});
    const t = run('ts', args, tsDir, home, c.stdin, c.memory ? { AM_MEMORY_DIR: tsMemory } : {});
    const label = `am ${args.join(' ')}`;
    if (g.code !== t.code) problems.push(`${label}：退出码 Go=${g.code} TS=${t.code}`);
    for (const stream of ['stdout', 'stderr']) {
      const a = normalize(g[stream], goDir, c.memory ? goMemory : '', scrub);
      const b = normalize(t[stream], tsDir, c.memory ? tsMemory : '', scrub);
      if (a !== b) problems.push(`${label}：${stream} 不同\n--- Go\n${a}\n--- TS\n${b}`);
    }
    const ignore = [/^\.git\//, ...(c.ignore ?? [])];
    const pairs = [[goDir, tsDir, '']];
    if (c.memory) pairs.push([goMemory, tsMemory, '记忆库 ']);
    for (const [goRoot, tsRoot, prefix] of pairs) {
      const cleanFor = (dir, mem) => (scrub.length || c.memory ? (text) => normalize(text, dir, mem, scrub) : null);
      const ga = snapshot(goRoot, ignore, cleanFor(goDir, c.memory ? goMemory : ''));
      const ta = snapshot(tsRoot, ignore, cleanFor(tsDir, c.memory ? tsMemory : ''));
      for (const file of new Set([...ga.keys(), ...ta.keys()])) {
        if (ga.get(file) !== ta.get(file)) problems.push(`${label}：${prefix}文件 ${file} ${!ga.has(file) ? '只有 TS 写了' : !ta.has(file) ? '只有 Go 写了' : '内容不同'}`);
      }
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
