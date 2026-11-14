import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);

function fixture(t, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset packaging '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(new URL(script, import.meta.url), path.join(root, 'scripts', script));
  return root;
}

for (const platform of ['mac', 'windows']) {
  test(`afterPack includes npm and its dependencies in ${platform} resources`, async (t) => {
    const root = fixture(t, 'afterpack.cjs');
    const npm = path.join(root, 'vendor', 'npm');
    fs.mkdirSync(path.join(npm, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(npm, 'node_modules', 'dependency'), { recursive: true });
    fs.writeFileSync(path.join(npm, 'bin', 'npm-cli.js'), 'npm entry');
    fs.writeFileSync(path.join(npm, 'node_modules', 'dependency', 'index.js'), 'dependency');
    fs.writeFileSync(path.join(npm, '.onset-vendor'), 'marker');
    const appOutDir = path.join(root, 'output');
    const resources = platform === 'mac'
      ? path.join(appOutDir, '片场.app', 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');
    const context = {
      appOutDir,
      packager: {
        appInfo: { productFilename: '片场' },
        getResourcesDir: (out) => { assert.equal(out, appOutDir); return resources; },
      },
    };
    await require(path.join(root, 'scripts', 'afterpack.cjs')).default(context);
    assert.equal(fs.readFileSync(path.join(resources, 'npm', 'bin', 'npm-cli.js'), 'utf8'), 'npm entry');
    assert.equal(fs.readFileSync(path.join(resources, 'npm', 'node_modules', 'dependency', 'index.js'), 'utf8'), 'dependency');
    assert.equal(fs.existsSync(path.join(resources, 'npm', '.onset-vendor')), false);
  });
}

test('afterPack rejects an unprepared npm bundle', async (t) => {
  const root = fixture(t, 'afterpack.cjs');
  await assert.rejects(require(path.join(root, 'scripts', 'afterpack.cjs')).default({}), /npm run vendor/);
});

test('vendor uses npm’s JS entry with spaces in its path and keeps dependencies', (t) => {
  const root = fixture(t, 'vendor.mjs');
  // A real archive and a fake npm JS entry keep this regression test offline.
  const payload = path.join(root, 'package');
  fs.mkdirSync(path.join(payload, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(payload, 'node_modules', 'dependency'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'bin', 'npm-cli.js'), 'entry');
  fs.writeFileSync(path.join(payload, 'node_modules', 'dependency', 'index.js'), 'dependency');
  const archive = path.join(root, 'fixture.tgz');
  execFileSync('tar', ['-czf', 'fixture.tgz', 'package'], { cwd: root });
  const npmEntry = path.join(root, 'fake npm.cjs');
  fs.writeFileSync(npmEntry, `
    const fs = require('node:fs');
    require('node:assert/strict').deepEqual(process.argv.slice(2), ['pack', 'npm@11.6.2', '--silent']);
    fs.copyFileSync(process.env.TEST_NPM_ARCHIVE, 'npm-fixture.tgz');
    console.log('npm-fixture.tgz');
  `);
  const options = { encoding: 'utf8', env: { ...process.env, npm_execpath: npmEntry, TEST_NPM_ARCHIVE: archive } };
  execFileSync(process.execPath, [path.join(root, 'scripts', 'vendor.mjs')], options);
  const target = path.join(root, 'vendor', 'npm');
  assert.equal(fs.readFileSync(path.join(target, 'bin', 'npm-cli.js'), 'utf8'), 'entry');
  assert.equal(fs.readFileSync(path.join(target, 'node_modules', 'dependency', 'index.js'), 'utf8'), 'dependency');
  // Reusing the prepared bundle must not invoke npm again.
  fs.rmSync(npmEntry);
  assert.match(execFileSync(process.execPath, [path.join(root, 'scripts', 'vendor.mjs')], options), /已是/);
});
