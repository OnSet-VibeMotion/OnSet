import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMissing } from '../prereq';
import { pythonFor } from './analyze';
import { BasePythonEnv, EnvDirEnv, ensureEnv, envDir, envPython, envReady, requireEnv } from './env';
import { ConfigFile, DefaultConfig, loadConfig } from './store';

/**
 * 假的基础 Python：`-m venv DIR` 把自己拷成 DIR/bin/python，`-m pip install` 记一行日志，
 * `-c 脚本 checkpoint` 记下 checkpoint；FAIL_PIP_ONCE 指向的文件不存在时 pip 失败一次。
 */
function fakePython(dir: string): string {
  const file = path.join(dir, 'python3.12');
  fs.writeFileSync(
    file,
    `#!/bin/sh
log="$FAKE_LOG"
if [ "$1" = "-c" ] && [ "$#" -eq 2 ]; then echo "3.12"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then mkdir -p "$3/bin" && cp "$0" "$3/bin/python" && echo "venv $3" >> "$log"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  if [ -n "$FAIL_PIP_ONCE" ] && [ ! -e "$FAIL_PIP_ONCE" ]; then touch "$FAIL_PIP_ONCE"; echo "network down" >&2; exit 1; fi
  echo "pip $6" >> "$log"; exit 0
fi
if [ "$1" = "-c" ]; then echo "warm $3 proxy=$HTTPS_PROXY" >> "$log"; exit 0; fi
exit 2
`,
    { mode: 0o755 },
  );
  return file;
}

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-beat-env-')));
}

describe('beat analysis environment', () => {
  it('lives under the user data directory, keyed by the analyzer version', () => {
    expect(envDir({ HOME: '/home/u' })).toBe('/home/u/.local/share/am/beat/venv-1.1.0');
    expect(envDir({ HOME: '/home/u', XDG_DATA_HOME: '/data' })).toBe('/data/am/beat/venv-1.1.0');
    expect(envDir({ HOME: '/home/u', [EnvDirEnv]: '/opt/beat' })).toBe('/opt/beat');
    expect(envDir({})).toBe('');
  });

  it('is missing until am setup installs it, and never installs on its own', () => {
    const home = tempDir();
    let err: unknown;
    try {
      requireEnv({ HOME: home });
    } catch (e) {
      err = e;
    }
    expect(isMissing(err)).toBe(true);
    expect((err as Error).message).toContain('工具准备页');
    expect(fs.existsSync(path.join(home, '.local'))).toBe(false);
  });

  it('installs into the fixed directory, warms the default weights through the proxy, and retries', async () => {
    const root = tempDir();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const base = fakePython(bin);
    const log = path.join(root, 'log');
    const env = { HOME: root, PATH: bin + ':/usr/bin:/bin', FAKE_LOG: log, FAIL_PIP_ONCE: path.join(root, 'failed-once'), [BasePythonEnv]: base };
    const stages: string[] = [];
    const dir = await ensureEnv({ env, weightsEnv: { ...env, HTTPS_PROXY: 'http://127.0.0.1:7890' }, progress: (p) => stages.push(p.stage) });
    expect(dir).toBe(envDir(env));
    expect(envReady(dir)).toBe(true);
    expect(requireEnv(env)).toBe(envPython(dir));
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    // 第一次 pip 失败后整个环境删掉重建，再装、再下权重。
    expect(lines).toEqual([`venv ${dir}`, `venv ${dir}`, 'pip beat-this==1.1.0', 'warm final0 proxy=http://127.0.0.1:7890']);
    expect(stages.at(-1)).toBe('节拍分析环境已就绪');
    // 已就绪时不再动它。
    await ensureEnv({ env });
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('falls back to uv with its own Python when no suitable Python is on PATH', async () => {
    const root = tempDir();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // 假 uv：`uv venv --seed --python 3.12 … DIR` 把假 Python 拷进 DIR/bin，并记下 Python 的下载目录与代理。
    const python = fakePython(root);
    fs.writeFileSync(
      path.join(bin, 'uv'),
      `#!/bin/sh\nfor last; do :; done\nmkdir -p "$last/bin" && cp '${python}' "$last/bin/python" && echo "uv $* dir=$UV_PYTHON_INSTALL_DIR proxy=$HTTPS_PROXY" >> "$FAKE_LOG"\n`,
      { mode: 0o755 },
    );
    // 假程序要用的 mkdir、cp 从系统目录链进来：PATH 里不能有系统目录，否则会找到系统自带的 python3。
    for (const tool of ['mkdir', 'cp', 'touch']) fs.symlinkSync(fs.existsSync(`/bin/${tool}`) ? `/bin/${tool}` : `/usr/bin/${tool}`, path.join(bin, tool));
    const log = path.join(root, 'log');
    // PATH 里只有 uv，没有任何 python3.x。
    const env = { HOME: root, PATH: bin + ':/nonexistent', FAKE_LOG: log };
    const dir = await ensureEnv({ env, weightsEnv: { ...env, HTTPS_PROXY: 'http://127.0.0.1:7890' } });
    expect(envReady(dir)).toBe(true);
    const first = fs.readFileSync(log, 'utf8').trim().split('\n')[0];
    expect(first).toBe(
      `uv venv --seed --python 3.12 --python-preference only-managed ${dir} dir=${path.join(root, '.local', 'share', 'am', 'python')} proxy=http://127.0.0.1:7890`,
    );
  });

  it('asks for am setup when there is neither a suitable Python nor uv', async () => {
    const root = tempDir();
    await expect(ensureEnv({ env: { HOME: root, PATH: '/nonexistent' } })).rejects.toThrow(/工具准备页安装「音乐卡点」/);
  });

  it('beat.yaml without python uses the shared environment; with python uses the given one', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, ConfigFile), DefaultConfig);
    const config = loadConfig(root);
    expect(config.python).toBe('');
    let err: unknown;
    try {
      pythonFor(config, { HOME: root, PATH: '' });
    } catch (e) {
      err = e;
    }
    expect(isMissing(err)).toBe(true);
    const own = fakePython(root);
    expect(pythonFor({ ...config, python: own }, { HOME: root, PATH: '' })).toBe(own);
    expect(() => pythonFor({ ...config, python: '/missing/python' }, { HOME: root, PATH: '' })).toThrow(/删掉 python 这一行/);
  });
});
