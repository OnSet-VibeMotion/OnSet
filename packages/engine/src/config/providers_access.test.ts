import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { load, newConfig } from './config';
import { Aligners, TTSProviders, orchestratorAccess, orchestratorBaseCommands } from './providers';

describe('orchestrator access', () => {
  it('names a command for every provider', () => {
    for (const provider of TTSProviders) expect(provider.command, `TTS ${provider.id} 没有登记命令`).not.toBe('');
    for (const aligner of Aligners) expect(aligner.command, `对齐工具 ${aligner.id} 没有登记命令`).not.toBe('');
  });

  it('follows the config', () => {
    const cfg = newConfig({ ttsProvider: 'edge', alignProvider: 'mlx' });
    const got = orchestratorAccess(cfg, 'npx --yes hyperframes@1.0.0', 'ffmpeg').commands;
    expect(got).toEqual([...orchestratorBaseCommands, 'mlx_audio.stt.generate', 'npx --yes hyperframes@1.0.0']);
    const again = orchestratorAccess(cfg).commands!;
    expect(again.length, '基础清单被上一次调用改写了').toBe(orchestratorBaseCommands.length + 1);
    // onset 不在白名单里：编排工具只经 onset 的工具服务（MCP）调用它。
    expect(again).not.toContain('onset');
    for (const provider of TTSProviders) expect(again).not.toContain(provider.command);
    expect(again[0]).toBe('ffmpeg');
  });

  // 基础清单是给编排工具的常用命令：shell 本身、删除与改权限、安装与提权一律不进。
  it('keeps the base commands harmless', () => {
    const forbidden = ['sh', 'bash', 'zsh', 'rm', 'chmod', 'chown', 'sudo', 'brew', 'pip', 'pip3', 'npm', 'npx', 'uv', 'git', 'eval', 'env', 'xargs'];
    for (const command of orchestratorBaseCommands) expect(forbidden, `基础清单里不能有 ${command}`).not.toContain(command);
    for (const need of ['cat', 'head', 'echo', 'shasum', 'curl', 'git status', 'python3', 'node']) {
      expect(orchestratorBaseCommands, `基础清单缺 ${need}：编排工具会被拦下（实测）`).toContain(need);
    }
  });

  it('extends the allowlist with ORCHESTRATOR_ALLOW_COMMANDS', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-config-'));
    const writeConf = (body: string) =>
      fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=claude\nRENDERER=claude\n' + body);
    writeConf('ORCHESTRATOR_ALLOW_COMMANDS=uv run,  pnpm ,magick\n');
    const commands = orchestratorAccess(load(root, {})).commands!;
    for (const want of ['uv run', 'pnpm', 'magick']) expect(commands, `补充的命令 ${want} 没有放行`).toContain(want);
    for (const bad of ['rm -rf /; ls', 'a && b', '$(evil)', 'x | y']) {
      writeConf('ORCHESTRATOR_ALLOW_COMMANDS=' + bad + '\n');
      expect(() => load(root, {}), bad).toThrow('ORCHESTRATOR_ALLOW_COMMANDS');
    }
  });

  it('makes the memory directory writable when memory is on', () => {
    expect(orchestratorAccess(newConfig({ memory: { enabled: true, dir: '/m' } })).writableDirs).toEqual(['/m']);
    expect(orchestratorAccess(newConfig({ memory: { enabled: false, dir: '/m' } })).writableDirs).toBeUndefined();
  });
});
