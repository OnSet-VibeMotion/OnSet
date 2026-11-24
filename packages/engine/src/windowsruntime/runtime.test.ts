import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { agentBinDir, envMap, windowsPython } from '../envutil';
import { type ExitError, start } from '../procgroup';
import { withWindowsInstructions } from './index';

it('leaves macOS and Linux prompts byte-for-byte unchanged', () => {
  for (const platform of ['darwin', 'linux'] as const)
    expect(withWindowsInstructions('original\n原稿', 'orchestrator', platform)).toBe('original\n原稿');
});

it('supplies Windows execution guidance only at invocation time', () => {
  const prompt = withWindowsInstructions('approved creative prompt', 'orchestrator', 'win32');
  expect(prompt.startsWith('approved creative prompt\n')).toBe(true);
  for (const tool of ['windows_inspect()', 'source_download()', 'scene_run_all']) expect(prompt).toContain(tool);
  expect(withWindowsInstructions('scene', 'renderer', 'win32')).not.toContain('source_download(');
});

it.skipIf(process.platform !== 'win32' || windowsPython(envMap()) === '')(
  'executes the python3 alias with Unicode paths and preserves its exit status',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-python-alias-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const environment = { ...envMap(), XDG_DATA_HOME: root, ONSET_AGENT_BIN_DIR: path.join(root, 'bin') };
    const directory = agentBinDir(environment);
    const file = path.join(root, '中文 脚本.py');
    fs.writeFileSync(file, 'import sys\nprint("中文参数=" + sys.argv[1])\nsys.exit(7)\n');
    let output = '';
    const child = await start(path.join(directory, 'python3.cmd'), [file, '测试 参数'], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.child.stdout!.on('data', (data) => {
      output += data;
    });
    await expect(child.wait()).rejects.toMatchObject<Partial<ExitError>>({ code: 7 });
    expect(output).toContain('中文参数=测试 参数');
  },
);
