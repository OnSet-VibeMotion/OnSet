import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultMemoryExplore, DefaultMemoryRecallBudget, childEnvironment, describeSettings, load, newConfig, parseConfFile } from './config';
import { GlobalDefaults, SettingsFileEnv, writeGlobal } from './global';
import { defaultTTSProvider } from './providers';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onset-config-'));
}

describe('config', () => {
  it('resolves env > .env > conf', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\nSCENE_JOBS=2\n');
    fs.writeFileSync(path.join(root, '.env'), 'RENDERER=qoder\nSCENE_JOBS=4\n', { mode: 0o600 });
    const cfg = load(root, { ORCHESTRATOR: 'opencode' });
    expect(cfg.orchestrator).toBe('opencode');
    expect(cfg.renderer).toBe('qoder');
    expect(cfg.sceneJobs).toBe(4);
    expect(cfg.ttsProvider).toBe(defaultTTSProvider());
  });

  it('allows the same tool for both roles', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
    const cfg = load(root, {});
    expect(cfg.orchestrator).toBe('codex');
    expect(cfg.renderer).toBe('codex');
  });

  it('builds a safe child environment', () => {
    const cfg = newConfig({ orchestrator: 'codex', renderer: 'claude', ttsProvider: 'minimax', overlay: { MINIMAX_VOICE_ID: 'voice' } });
    const base = { PATH: '/bin', HOME: '/home/test', AWS_SECRET_ACCESS_KEY: 'secret', CUSTOM: 'ok' };
    expect(childEnvironment(cfg, base, false, ['CUSTOM'])).toEqual({
      PATH: '/bin',
      HOME: '/home/test',
      CUSTOM: 'ok',
      MINIMAX_VOICE_ID: 'voice',
      ORCHESTRATOR: 'codex',
      RENDERER: 'claude',
      TTS_PROVIDER: 'minimax',
    });
  });

  // USER 不是密钥，但 macOS 上 claude CLI 靠它定位 Keychain 凭据。
  // 白名单漏掉它时，渲染器会以「Not logged in」失败，且失败信息和权限隔离毫无关联。
  it('keeps identity variables in safe mode', () => {
    const cfg = newConfig({ orchestrator: 'codex', renderer: 'claude', ttsProvider: 'minimax' });
    const base: Record<string, string> = { PATH: '/bin', HOME: '/home/test', USER: 'test', LOGNAME: 'test', SHELL: '/bin/zsh' };
    const env = childEnvironment(cfg, base, false);
    for (const key of ['USER', 'LOGNAME', 'SHELL']) expect(env[key], `${key} must survive the allowlist`).toBe(base[key]);
    expect('AWS_SECRET_ACCESS_KEY' in env).toBe(false);
  });

  // CODEX_HOME 是 Codex 的数据目录：用户改过它时，缺了这个变量 Codex 读不到
  // 登录态，内置生图的产物也落到别处，定风格阶段拿不到氛围参照图。
  it('keeps CODEX_HOME in safe mode', () => {
    const cfg = newConfig({ orchestrator: 'codex', renderer: 'codex', ttsProvider: 'minimax' });
    const env = childEnvironment(cfg, { PATH: '/bin', CODEX_HOME: '/data/codex', OPENAI_API_KEY: 'secret' }, false);
    expect(env.CODEX_HOME).toBe('/data/codex');
    expect('OPENAI_API_KEY' in env, '凭据仍不得透传').toBe(false);
  });

  it('rejects secrets in .env', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=secret\n', { mode: 0o600 });
    expect(() => load(root, null)).toThrow('.env 不得保存密钥 OPENAI_API_KEY');
  });

  it.each([
    ['orchestrator', 'ORCHESTRATOR=gpt\nRENDERER=claude\n'],
    ['tts', 'ORCHESTRATOR=codex\nRENDERER=claude\nTTS_PROVIDER=bad\n'],
    ['align', 'ORCHESTRATOR=codex\nRENDERER=claude\nALIGN_PROVIDER=whisper\n'],
    ['jobs', 'ORCHESTRATOR=codex\nRENDERER=claude\nSCENE_JOBS=99\n'],
  ])('rejects invalid choices and jobs (%s)', (_name, body) => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), body);
    expect(() => load(root, {})).toThrow();
  });

  it('loads memory settings', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
    let cfg = load(root, { HOME: '/home/u' });
    expect(cfg.memory).toEqual({
      enabled: true,
      snapshot: 0,
      recallBudget: DefaultMemoryRecallBudget,
      explore: DefaultMemoryExplore,
      dir: path.join('/home/u', '.local', 'share', 'onset', 'memory'),
    });
    expect(load(root, { MEMORY: 'off' }).memory.enabled, 'MEMORY=off 应当关闭').toBe(false);
    cfg = load(root, { MEMORY: 'on', MEMORY_SNAPSHOT: '7', MEMORY_RECALL_BUDGET: '800', MEMORY_EXPLORE: '0', ONSET_MEMORY_DIR: '/tmp/mem' });
    expect(cfg.memory).toEqual({ enabled: true, snapshot: 7, recallBudget: 800, explore: 0, dir: '/tmp/mem' });
    for (const bad of <Record<string, string>[]>[
      { MEMORY: 'yes' },
      { MEMORY_SNAPSHOT: '0' },
      { MEMORY_SNAPSHOT: 'x' },
      { MEMORY_RECALL_BUDGET: '-1' },
      { MEMORY_EXPLORE: '0.9' },
      { MEMORY_EXPLORE: 'x' },
    ]) {
      expect(() => load(root, bad), JSON.stringify(bad)).toThrow();
    }
  });

  // 编排工具调用的 onset 要用同一个记忆库，安全模式的白名单不放行 ONSET_MEMORY_DIR，必须显式写进去。
  it('carries memory settings into the child environment', () => {
    const cfg = newConfig({
      orchestrator: 'codex',
      renderer: 'claude',
      ttsProvider: 'minimax',
      memory: { enabled: true, dir: '/data/mem', recallBudget: 800, snapshot: 3, explore: 0.2 },
    });
    const env = childEnvironment(cfg, { PATH: '/bin', ONSET_MEMORY_DIR: '/elsewhere' }, false);
    expect(env.ONSET_MEMORY_DIR).toBe('/data/mem');
    expect(env.MEMORY).toBe('on');
    expect(env.MEMORY_RECALL_BUDGET).toBe('800');
    expect(env.MEMORY_SNAPSHOT).toBe('3');
    expect(env.MEMORY_EXPLORE).toBe('0.2');
  });

  it('fills unset keys from the global settings, then the built-in defaults', () => {
    const root = tempDir();
    const file = path.join(tempDir(), 'settings.conf');
    const env = { [SettingsFileEnv]: file };
    // 项目这几项留空：没有全局设置时用内置默认，与以前模板里写死的值相同。
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=\nRENDERER=\nTTS_PROVIDER=\n');
    let cfg = load(root, env);
    expect([cfg.orchestrator, cfg.renderer, cfg.ttsProvider, cfg.sceneJobs]).toEqual([GlobalDefaults.ORCHESTRATOR, GlobalDefaults.RENDERER, GlobalDefaults.TTS_PROVIDER, 3]);
    writeGlobal(env, { ORCHESTRATOR: 'claude', TTS_PROVIDER: 'breeze', SCENE_JOBS: '5', MEMORY: 'off' }, parseConfFile);
    cfg = load(root, env);
    expect([cfg.orchestrator, cfg.ttsProvider, cfg.sceneJobs, cfg.memory.enabled]).toEqual(['claude', 'breeze', 5, false]);
    // 项目写了的项只对这个项目生效，压过全局；环境变量压过项目。
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=qoder\n');
    expect(load(root, env).orchestrator).toBe('qoder');
    expect(load(root, { ...env, ORCHESTRATOR: 'opencode' }).orchestrator).toBe('opencode');
    // 子进程拿到同一份全局设置。
    expect(childEnvironment(load(root, env), {}, false, [])[SettingsFileEnv]).toBe(file);
  });

  it('describes where each setting comes from, and rejects bad global values', () => {
    const root = tempDir();
    const file = path.join(tempDir(), 'settings.conf');
    const env = { [SettingsFileEnv]: file };
    fs.writeFileSync(path.join(root, 'onset.conf'), 'RENDERER=codex\n');
    writeGlobal(env, { ORCHESTRATOR: 'claude' }, parseConfFile);
    const rows = Object.fromEntries(describeSettings(root, env).map((r) => [r.key, r]));
    expect(rows.ORCHESTRATOR).toMatchObject({ effective: 'claude', source: 'global', global: 'claude', project: '' });
    expect(rows.RENDERER).toMatchObject({ effective: 'codex', source: 'project', project: 'codex' });
    expect(rows.TTS_PROVIDER).toMatchObject({ effective: GlobalDefaults.TTS_PROVIDER, source: 'default' });
    expect(() => writeGlobal(env, { RENDERER: 'gpt' }, parseConfFile)).toThrow('RENDERER');
    expect(() => writeGlobal(env, { SCENE_JOBS: '99' }, parseConfFile)).toThrow('1 到 16');
    // 空值删掉这一项，回到内置默认。
    writeGlobal(env, { ORCHESTRATOR: '' }, parseConfFile);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('ORCHESTRATOR=');
  });

  // 模型名只对写它时的那家工具有意义：全局给 claude 选的 opus 不能交给项目里改成的 codex。
  it('uses a model only with the tool it was chosen for', () => {
    const root = tempDir();
    const file = path.join(tempDir(), 'settings.conf');
    const env = { [SettingsFileEnv]: file };
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=\nRENDERER=\n');
    writeGlobal(env, { ORCHESTRATOR: 'claude', ORCHESTRATOR_MODEL: 'opus', RENDERER: 'claude', RENDERER_MODEL: 'sonnet' }, parseConfFile);
    expect(load(root, env)).toMatchObject({ orchestratorModel: 'opus', rendererModel: 'sonnet' });
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    expect(load(root, env), '项目换了编排工具；渲染还是 claude，全局模型照用').toMatchObject({ orchestratorModel: '', rendererModel: 'sonnet' });
    // 子进程环境里换了渲染工具、没写模型：项目里给旧工具写的模型作废。
    fs.writeFileSync(path.join(root, 'onset.conf'), 'RENDERER=claude\nRENDERER_MODEL=haiku\n');
    expect(load(root, { ...env, RENDERER: 'codex' }).rendererModel).toBe('');
    expect(load(root, { ...env, RENDERER: 'codex', RENDERER_MODEL: 'gpt-6-luna' }).rendererModel).toBe('gpt-6-luna');
    const child = childEnvironment(load(root, { ...env, RENDERER: 'codex' }), { RENDERER_MODEL: 'stale' }, true);
    expect(child.RENDERER_MODEL, '没选模型时不把旧值带给子进程').toBeUndefined();
    expect(childEnvironment(load(root, env), {}, false).RENDERER_MODEL).toBe('haiku');
    // 在同一层换了工具，那一层的模型一起清掉。
    writeGlobal(env, { ORCHESTRATOR: 'qoder' }, parseConfFile);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('ORCHESTRATOR_MODEL=');
    expect(() => writeGlobal(env, { RENDERER_MODEL: 'two words' }, parseConfFile)).toThrow('模型名');
    expect(() => load(root, { ...env, RENDERER_MODEL: 'a;b' })).toThrow('RENDERER_MODEL');
  });

  // 调用选项与模型同一条规则：effort=xhigh 是给 claude 选的，项目换成 codebuddy 就不带过去。
  it('uses the options only with the tool they were chosen for', () => {
    const root = tempDir();
    const file = path.join(tempDir(), 'settings.conf');
    const env = { [SettingsFileEnv]: file };
    fs.writeFileSync(path.join(root, 'onset.conf'), '');
    writeGlobal(env, { ORCHESTRATOR: 'claude', ORCHESTRATOR_OPTIONS: 'effort=xhigh,fast=on', RENDERER: 'qoder-intl', RENDERER_OPTIONS: 'context=200000' }, parseConfFile);
    expect(load(root, env)).toMatchObject({ orchestratorOptions: 'effort=xhigh,fast=on', rendererOptions: 'context=200000', optimizerOptions: '' });
    const child = childEnvironment(load(root, env), {}, false);
    expect(child.ORCHESTRATOR_OPTIONS).toBe('effort=xhigh,fast=on');
    expect(child.RENDERER_OPTIONS).toBe('context=200000');
    fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codebuddy\n');
    expect(load(root, env).orchestratorOptions, '项目换了编排工具').toBe('');
    expect(childEnvironment(load(root, env), { ORCHESTRATOR_OPTIONS: 'stale' }, true).ORCHESTRATOR_OPTIONS).toBeUndefined();
    // 优化工具跟随编排时没有自己的选项。
    writeGlobal(env, { OPTIMIZER_OPTIONS: 'effort=low' }, parseConfFile);
    expect(load(root, env).optimizerOptions).toBe('');
    writeGlobal(env, { OPTIMIZER: 'claude', OPTIMIZER_OPTIONS: 'effort=low' }, parseConfFile);
    expect(load(root, env).optimizerOptions).toBe('effort=low');
    // 在同一层换了工具，那一层的模型与选项一起清掉。
    writeGlobal(env, { RENDERER: 'claude' }, parseConfFile);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('RENDERER_OPTIONS=');
    expect(() => writeGlobal(env, { RENDERER_OPTIONS: 'effort high' }, parseConfFile)).toThrow('选项写法');
    expect(() => load(root, { ...env, ORCHESTRATOR_OPTIONS: 'effort="x"' })).toThrow('ORCHESTRATOR_OPTIONS');
  });

  it('defaults the voice to the local Breeze on Apple Silicon and MiniMax elsewhere', () => {
    expect(defaultTTSProvider('darwin', 'arm64')).toBe('breeze');
    expect(defaultTTSProvider('darwin', 'x64')).toBe('minimax');
    expect(defaultTTSProvider('linux', 'arm64')).toBe('minimax');
    expect(GlobalDefaults.TTS_PROVIDER).toBe(defaultTTSProvider());
  });
});
