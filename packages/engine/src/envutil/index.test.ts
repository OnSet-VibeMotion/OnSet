import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addToolsLocation, agentBinDir, ClientShimMarker, envList, envMap, lookPath, MissingToolPrefix, parsePassthrough } from './index';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onset-envutil-'));
const saved = process.env.PATH;
afterEach(() => {
  process.env.PATH = saved;
  delete process.env.ONSET_TEST_KEY;
});

describe('envutil', () => {
  it('envMap includes the environment', () => {
    process.env.ONSET_TEST_KEY = 'hello';
    expect(envMap().ONSET_TEST_KEY).toBe('hello');
  });

  it('envList round-trips', () => {
    expect(new Set(envList({ A: '1', B: '2' }))).toEqual(new Set(['A=1', 'B=2']));
  });

  it('parsePassthrough splits on commas and spaces', () => {
    for (const [input, want] of [['USER,LOGNAME', 2], ['USER LOGNAME', 2], ['USER, LOGNAME', 2], ['', 0], ['  ', 0]] as const) {
      expect(parsePassthrough(input)).toHaveLength(want);
    }
  });

  it('lookPath uses the given PATH, not the process PATH', () => {
    const dir = temp();
    const other = temp();
    const target = path.join(dir, 'onset-fake-tool');
    fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = dir;
    expect(() => lookPath('onset-fake-tool', other)).toThrow();
    expect(lookPath('onset-fake-tool', other + path.delimiter + dir)).toBe(target);
  });

  it('lookPath skips non-executables and directories', () => {
    const dir = temp();
    fs.writeFileSync(path.join(dir, 'onset-fake-tool'), 'data', { mode: 0o644 });
    expect(() => lookPath('onset-fake-tool', dir)).toThrow();
    fs.mkdirSync(path.join(dir, 'onset-fake-dir'));
    expect(() => lookPath('onset-fake-dir', dir)).toThrow();
  });

  it('missing tools carry the exit-127 marker and name the tool', () => {
    expect(() => lookPath('onset-definitely-not-installed', temp())).toThrow(MissingToolPrefix);
    expect(() => lookPath('onset-definitely-not-installed', temp())).toThrow('onset-definitely-not-installed');
  });
});

describe('addToolsLocation', () => {
  // agent 只能经工具服务调用 onset：最前面放一个只有 onset 的目录遮住别处的 onset，但不拿掉任何目录——
  // 以前装 onset 启动脚本的 ~/.local/bin 里还有 claude，整个拿掉就报「缺少必需工具：claude」。
  it('shadows onset without dropping the directories that hold the agents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-envutil-'));
    const shimDir = path.join(root, 'local-bin');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, 'onset'), `#!/bin/sh\n# ${ClientShimMarker}：用客户端自带的运行时执行 onset 命令行。\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(shimDir, 'claude'), '#!/bin/sh\necho claude\n', { mode: 0o755 });
    const env: Record<string, string> = { PATH: [shimDir, '/usr/bin'].join(path.delimiter), HOME: path.join(root, 'home'), ONSET_BIN_DIR: path.join(root, 'tools') };
    addToolsLocation(env);
    const blocker = agentBinDir(env);
    expect(env.PATH.split(path.delimiter)).toEqual([blocker, shimDir, '/usr/bin', path.join(root, 'tools')]);
    expect(lookPath('claude', env.PATH)).toBe(path.join(shimDir, 'claude'));
    expect(lookPath('onset', env.PATH)).toBe(path.join(blocker, 'onset'));
    const ran = spawnSync(path.join(blocker, 'onset'), ['scene', 'run'], { encoding: 'utf8' });
    expect(ran.status).toBe(127);
    expect(ran.stderr).toContain('工具服务');
    // 再调一次不会重复加。
    addToolsLocation(env);
    expect(env.PATH.split(path.delimiter).filter((d) => d === blocker)).toHaveLength(1);
  });
});
