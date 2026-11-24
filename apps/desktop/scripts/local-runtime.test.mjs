import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset local profile 中文 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compiled = path.join(root, 'local-runtime.cjs');
  buildSync({
    entryPoints: [fileURLToPath(new URL('../src/main/localRuntime.ts', import.meta.url))],
    outfile: compiled,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const { configureInstalledRuntime } = require(compiled);
  const install = path.join(root, 'OnSet');
  const runtime = path.join(root, '.onset-local');
  fs.mkdirSync(install);
  fs.mkdirSync(path.join(runtime, 'studio'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'settings.conf'), 'TTS_PROVIDER=edge\n');
  fs.writeFileSync(path.join(runtime, 'studio/projects.json'), '{"schema":1,"projects":[{"name":"existing project"}]}');
  const profile = path.join(install, 'onset-runtime.json');
  return { configureInstalledRuntime, root, runtime, profile, executable: path.join(install, '片场.exe') };
}

test('normal installs and other platforms keep their existing data paths', (t) => {
  const f = fixture(t);
  const env = { LOCALAPPDATA: 'local', APPDATA: 'roaming', Path: 'system' };
  const before = { ...env };
  assert.equal(f.configureInstalledRuntime(f.executable, env, 'win32'), false);
  assert.deepEqual(env, before);
  fs.writeFileSync(f.profile, '{"schema":1,"runtime_dir":"../.onset-local"}');
  assert.equal(f.configureInstalledRuntime(f.executable, env, 'darwin'), false);
  assert.deepEqual(env, before);
});

test('direct exe startup reconnects existing projects, tools, settings and userData before lock selection', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, '{"schema":1,"runtime_dir":"../.onset-local"}');
  fs.mkdirSync(path.join(f.runtime, 'verification'));
  fs.writeFileSync(path.join(f.runtime, 'verification/local-resources.json'), '{}');
  const before = fs.readFileSync(path.join(f.runtime, 'studio/projects.json'));
  const env = { Path: path.join(f.root, 'system') };
  assert.equal(f.configureInstalledRuntime(f.executable, env, 'win32'), true);
  for (const [key, relative] of Object.entries({
    ONSET_STUDIO_CONFIG: 'studio/projects.json',
    ONSET_DESKTOP_USER_DATA: 'desktop',
    ONSET_SETTINGS_FILE: 'settings.conf',
    ONSET_BIN_DIR: 'bin',
    ONSET_MEMORY_DIR: 'memory',
    ONSET_AGENT_DIR: 'agent',
    ONSET_VOICES_DIR: 'voices',
    ONSET_SERIES_DIR: 'series',
    ONSET_STATIONS_DIR: 'stations',
    ONSET_HYPERFRAMES_CLI_DIR: 'hyperframes',
    XDG_DATA_HOME: 'data',
  }))
    assert.equal(env[key], path.join(f.runtime, relative));
  assert.deepEqual(env.PATH.split(path.delimiter), [path.join(f.root, 'system'), path.join(f.runtime, 'bin')]);
  assert.equal(env.Path, undefined);
  assert.deepEqual(fs.readFileSync(env.ONSET_STUDIO_CONFIG), before);
  assert.equal(f.configureInstalledRuntime(f.executable, env, 'win32'), true);
  assert.equal(env.PATH.split(path.delimiter).filter((p) => p === env.ONSET_BIN_DIR).length, 1);
});

test('explicit environment overrides remain isolated, including tests and alternate data roots', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, '{"schema":1,"runtime_dir":"../.onset-local"}');
  const env = {
    ONSET_STUDIO_CONFIG: 'test-projects',
    ONSET_DESKTOP_USER_DATA: 'test-user-data',
    ONSET_BIN_DIR: 'test-bin',
    XDG_DATA_HOME: 'test-data',
    ONSET_PASSTHROUGH_ENV: 'TEST_FLAG',
  };
  f.configureInstalledRuntime(f.executable, env, 'win32');
  assert.equal(env.ONSET_STUDIO_CONFIG, 'test-projects');
  assert.equal(env.ONSET_DESKTOP_USER_DATA, 'test-user-data');
  assert.equal(env.ONSET_BIN_DIR, 'test-bin');
  assert.equal(env.XDG_DATA_HOME, 'test-data');
  assert.ok(env.ONSET_PASSTHROUGH_ENV.split(',').includes('TEST_FLAG'));
});

test('broken explicit profiles fail without silently creating an empty project registry', (t) => {
  const f = fixture(t);
  for (const contents of [
    '{}',
    '{"schema":2,"runtime_dir":"../.onset-local"}',
    '{"schema":1,"runtime_dir":"../missing"}',
  ]) {
    fs.writeFileSync(f.profile, contents);
    const env = {};
    assert.throws(() => f.configureInstalledRuntime(f.executable, env, 'win32'));
    assert.deepEqual(env, {});
  }
  assert.equal(fs.existsSync(path.join(f.root, 'missing')), false);
});

test('Windows process.env keeps PATH after applying the profile', { skip: process.platform !== 'win32' }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, '{"schema":1,"runtime_dir":"../.onset-local"}');
  const script = `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const { configureInstalledRuntime } = require(process.argv[1]);
    process.env.Path = process.argv[3];
    configureInstalledRuntime(process.argv[2], process.env);
    assert.ok(process.env.PATH.split(path.delimiter).includes(process.argv[3]));
    assert.ok(process.env.PATH.split(path.delimiter).includes(process.env.ONSET_BIN_DIR));
  `;
  execFileSync(
    process.execPath,
    ['-e', script, path.join(f.root, 'local-runtime.cjs'), f.executable, path.join(f.root, 'system')],
    { windowsHide: true },
  );
});

test('Start Menu PATH with only an older npm Codex uses the explicitly selected desktop CLI', (t) => {
  const f = fixture(t);
  const older = path.join(f.root, 'npm-bin');
  const desktop = path.join(f.root, 'desktop Codex 中文');
  fs.mkdirSync(older);
  fs.mkdirSync(desktop);
  fs.writeFileSync(path.join(older, 'codex.cmd'), 'older CLI');
  fs.writeFileSync(path.join(desktop, 'codex.exe'), 'desktop CLI');
  fs.writeFileSync(
    f.profile,
    JSON.stringify({ schema: 1, runtime_dir: '../.onset-local', codex_dir: '../desktop Codex 中文' }),
  );
  const env = { Path: older };
  f.configureInstalledRuntime(f.executable, env, 'win32');
  const resolved = env.PATH.split(path.delimiter)
    .flatMap((dir) => ['codex.exe', 'codex.cmd'].map((name) => path.join(dir, name)))
    .find((file) => fs.existsSync(file));
  assert.equal(resolved, path.join(desktop, 'codex.exe'));
  assert.ok(env.PATH.split(path.delimiter).includes(older));
  fs.rmSync(path.join(desktop, 'codex.exe'));
  const nextEnv = { Path: older };
  assert.throws(() => f.configureInstalledRuntime(f.executable, nextEnv, 'win32'), /codex_dir/);
  assert.deepEqual(nextEnv, { Path: older });
});
