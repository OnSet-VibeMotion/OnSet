import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkLineSeparators, checkLockfileRegistry, checkMaxFileLines, filterBiomeFiles } from './lint.mjs';

test('checkLineSeparators detects bare U+2028 and U+2029 while ignoring escaped sequences', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-lint-sep-'));
  try {
    const srcDir = path.join(root, 'packages/engine/src/sample');
    const distDir = path.join(root, 'packages/engine/src/dist');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'clean.ts'), 'export const re = /[\\u2028\\u2029]/;\n');
    fs.writeFileSync(path.join(srcDir, 'bad.ts'), `const a = 'ok';\nconst b = 'line\u2028break\u2029';\n`);
    fs.writeFileSync(path.join(distDir, 'ignored.js'), `const x = '\u2028';\n`);

    const hits = checkLineSeparators(root, ['packages/engine/src']);
    assert.deepEqual(hits, [
      { file: 'packages/engine/src/sample/bad.ts', line: 2, column: 16, codePoint: 'U+2028' },
      { file: 'packages/engine/src/sample/bad.ts', line: 2, column: 22, codePoint: 'U+2029' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkMaxFileLines enforces strict 400-line cap on business source files while exempting CSS and tests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-lint-lines-'));
  try {
    const srcDir = path.join(root, 'packages/engine/src');
    fs.mkdirSync(srcDir, { recursive: true });

    const makeLines = (n) => `${Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`;
    fs.writeFileSync(path.join(srcDir, 'ok.ts'), makeLines(400));
    fs.writeFileSync(path.join(srcDir, 'too-big.ts'), makeLines(401));
    fs.writeFileSync(path.join(srcDir, 'exempt.test.ts'), makeLines(600));
    fs.writeFileSync(path.join(srcDir, 'exempt.spec.tsx'), makeLines(600));
    fs.writeFileSync(path.join(srcDir, 'exempt.css'), makeLines(600));

    const hits = checkMaxFileLines(root, { scanRoots: ['packages/engine/src'] });
    assert.deepEqual(hits, [{ file: 'packages/engine/src/too-big.ts', lines: 401, limit: 400 }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkLockfileRegistry enforces official npmjs registry and allows workspace links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-lint-lock-'));
  try {
    const lockPath = path.join(root, 'package-lock.json');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'onset' },
          'node_modules/@onset/engine': { resolved: 'packages/engine', link: true },
          'node_modules/good-pkg': { resolved: 'https://registry.npmjs.org/good-pkg/-/good-pkg-1.0.0.tgz' },
          'node_modules/mirror-pkg': { resolved: 'https://registry.npmmirror.com/mirror-pkg/-/mirror-pkg-1.0.0.tgz' },
        },
      }),
    );

    const hits = checkLockfileRegistry(lockPath);
    assert.deepEqual(hits, [
      {
        pkg: 'node_modules/mirror-pkg',
        resolved: 'https://registry.npmmirror.com/mirror-pkg/-/mirror-pkg-1.0.0.tgz',
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('filterBiomeFiles scopes to tracked source roots and drops ignored artifacts', () => {
  const filtered = filterBiomeFiles([
    'packages/engine/src/index.ts',
    'packages/cli/src/agent/import-meta-url.cjs',
    'packages/cli/dist/onset.cjs',
    'apps/desktop/src/renderer/App.tsx',
    'apps/desktop/out/main.js',
    'apps/desktop/e2e/smoke.spec.mjs',
    'scripts/lint.mjs',
    'assets/prompts/scene.md',
    'openmotion/src/index.ts',
    'docs/dev/ops.md',
    'package.json',
    'biome.json',
    'packages/engine/src/template.ts.tmpl',
  ]);

  assert.deepEqual(filtered, [
    'apps/desktop/e2e/smoke.spec.mjs',
    'apps/desktop/src/renderer/App.tsx',
    'biome.json',
    'package.json',
    'packages/engine/src/index.ts',
    'scripts/lint.mjs',
  ]);
});
