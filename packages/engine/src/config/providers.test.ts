// 移植自 internal/config/providers_test.go。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnvironment, load } from './config';
import { AlignAuto, Aligners, TTSProviders, alignerIDs, resolveAligner, ttsProviderIDs, validAligner, validTTSProvider } from './providers';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'am-config-'));
}

describe('providers', () => {
  it('accepts every TTS provider', () => {
    for (const provider of TTSProviders) {
      const root = tempDir();
      fs.writeFileSync(path.join(root, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\nTTS_PROVIDER=' + provider.id + '\n');
      expect(load(root, {}).ttsProvider, `${provider.id} 应被接受`).toBe(provider.id);
    }
  });

  it('resolves the aligner per platform', () => {
    const cases: [string, string, string, string][] = [
      ['auto', 'darwin', 'arm64', 'mlx'],
      ['auto', 'darwin', 'amd64', 'funasr'],
      ['auto', 'linux', 'arm64', 'funasr'],
      ['funasr', 'darwin', 'arm64', 'funasr'],
      ['mlx', 'linux', 'amd64', 'mlx'],
    ];
    for (const [value, goos, goarch, want] of cases) {
      expect(resolveAligner(value, goos, goarch), `resolveAligner(${value}, ${goos}/${goarch})`).toBe(want);
    }
  });

  // 缺省按平台解析，编排工具从环境变量拿到的是具体工具名而不是 auto。
  it('defaults the aligner to auto and exports it', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=claude\n');
    const cfg = load(root, {});
    const want = resolveAligner(AlignAuto, process.platform, process.arch);
    expect(cfg.alignProvider).toBe(want);
    expect(childEnvironment(cfg, { PATH: '/bin' }, false).ALIGN_PROVIDER).toBe(want);
  });

  it('lists provider ids', () => {
    expect(ttsProviderIDs().startsWith('minimax bailian ')).toBe(true);
    expect(ttsProviderIDs()).toContain('elevenlabs');
    expect(alignerIDs()).toBe('auto mlx funasr x:<插件>');
    expect(validTTSProvider('x:my-voice')).toBe(true);
    expect(validTTSProvider('x:Bad')).toBe(false);
    expect(validAligner('x:my-align')).toBe(true);
    expect(Aligners.length).toBe(2);
  });
});
