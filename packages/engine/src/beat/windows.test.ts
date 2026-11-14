import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { envMap, windowsPython } from '../envutil';
import { BasePythonEnv, beatRuntimeEnv, ensureEnv, envPython, envReady } from './env';

it('keeps POSIX environment bytes and places Windows model cache with prepared resources', () => {
  const env = { ONSET_WINDOWS_RESOURCES_DIR: 'E:/resources', PATH: '' };
  expect(beatRuntimeEnv(env, 'darwin')).toBe(env);
  expect(beatRuntimeEnv(env, 'linux')).toBe(env);
  expect(beatRuntimeEnv(env, 'win32').TORCH_HOME).toBe(path.join(env.ONSET_WINDOWS_RESOURCES_DIR, 'cache/torch'));
});

const python = process.platform === 'win32' ? windowsPython(envMap()) : '';
it.skipIf(python === '')('installs a local wheel into a real Windows venv and warms before marking ready', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-beat-windows-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const wheel = path.join(root, 'onset_beat_fixture-1.0-py3-none-any.whl');
  const make = `import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n z.writestr('onset_beat_fixture.py', 'READY=True\\n')\n z.writestr('onset_beat_fixture-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: onset-beat-fixture\\nVersion: 1.0\\n')\n z.writestr('onset_beat_fixture-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')\n z.writestr('onset_beat_fixture-1.0.dist-info/RECORD', '')\n`;
  execFileSync(python, ['-c', make, wheel], { windowsHide: true });
  const env = { ...envMap(), ONSET_WINDOWS_RESOURCES_DIR: root, ONSET_BEAT_ENV_DIR: path.join(root, '中文 环境'), [BasePythonEnv]: python, PIP_NO_INDEX: '1' };
  const warmed = path.join(root, 'warmed');
  const dir = await ensureEnv({ env, package: wheel, warmScript: `import onset_beat_fixture,pathlib;assert onset_beat_fixture.READY;pathlib.Path(${JSON.stringify(warmed)}).write_text('final0',encoding='utf-8')` });
  expect(envReady(dir)).toBe(true);
  expect(envPython(dir)).toBe(path.join(dir, 'Scripts', 'python.exe'));
  expect(fs.readFileSync(warmed, 'utf8')).toBe('final0');
});
