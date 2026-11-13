// 移植自 internal/config/config_test.go。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultMemoryExplore, DefaultMemoryRecallBudget, childEnvironment, load, newConfig } from './config';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'am-config-'));
}

describe('config', () => {
  it('resolves env > .env > conf', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\nSCENE_JOBS=2\n');
    fs.writeFileSync(path.join(root, '.env'), 'RENDERER=qoder\nSCENE_JOBS=4\n', { mode: 0o600 });
    const cfg = load(root, { ORCHESTRATOR: 'opencode' });
    expect(cfg.orchestrator).toBe('opencode');
    expect(cfg.renderer).toBe('qoder');
    expect(cfg.sceneJobs).toBe(4);
    expect(cfg.ttsProvider).toBe('minimax');
  });

  it('allows the same tool for both roles', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
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
    fs.writeFileSync(path.join(root, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=secret\n', { mode: 0o600 });
    expect(() => load(root, null)).toThrow('.env 不得保存密钥 OPENAI_API_KEY');
  });

  it.each([
    ['missing', 'RENDERER=claude\n'],
    ['tts', 'ORCHESTRATOR=codex\nRENDERER=claude\nTTS_PROVIDER=bad\n'],
    ['align', 'ORCHESTRATOR=codex\nRENDERER=claude\nALIGN_PROVIDER=whisper\n'],
    ['jobs', 'ORCHESTRATOR=codex\nRENDERER=claude\nSCENE_JOBS=99\n'],
  ])('rejects invalid choices and jobs (%s)', (_name, body) => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'article-to-motion.conf'), body);
    expect(() => load(root, {})).toThrow();
  });

  it('loads memory settings', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
    let cfg = load(root, { HOME: '/home/u' });
    expect(cfg.memory).toEqual({
      enabled: true,
      snapshot: 0,
      recallBudget: DefaultMemoryRecallBudget,
      explore: DefaultMemoryExplore,
      dir: path.join('/home/u', '.local', 'share', 'am', 'memory'),
    });
    expect(load(root, { MEMORY: 'off' }).memory.enabled, 'MEMORY=off 应当关闭').toBe(false);
    cfg = load(root, { MEMORY: 'on', MEMORY_SNAPSHOT: '7', MEMORY_RECALL_BUDGET: '800', MEMORY_EXPLORE: '0', AM_MEMORY_DIR: '/tmp/mem' });
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

  // 编排工具调用的 am 要用同一个记忆库，安全模式的白名单不放行 AM_MEMORY_DIR，必须显式写进去。
  it('carries memory settings into the child environment', () => {
    const cfg = newConfig({
      orchestrator: 'codex',
      renderer: 'claude',
      ttsProvider: 'minimax',
      memory: { enabled: true, dir: '/data/mem', recallBudget: 800, snapshot: 3, explore: 0.2 },
    });
    const env = childEnvironment(cfg, { PATH: '/bin', AM_MEMORY_DIR: '/elsewhere' }, false);
    expect(env.AM_MEMORY_DIR).toBe('/data/mem');
    expect(env.MEMORY).toBe('on');
    expect(env.MEMORY_RECALL_BUDGET).toBe('800');
    expect(env.MEMORY_SNAPSHOT).toBe('3');
    expect(env.MEMORY_EXPLORE).toBe('0.2');
  });
});
