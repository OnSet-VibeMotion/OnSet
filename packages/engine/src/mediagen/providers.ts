/**
 * BYOK 多模态供应商配置读写（用户级私有文件，0600 权限；绝不读取项目 .env）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lookPath } from '../envutil';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import type { MediaProviderConfig, MediaProviderId, Modality } from './types';

export const MediaConfigEnv = 'ONSET_MEDIA_CONFIG';

export interface ProviderSummary {
  id: MediaProviderId;
  label: string;
  configured: boolean;
  source: 'config' | 'env' | 'local-cli' | 'none';
  modalities: Modality[];
  default_models: Partial<Record<Modality, string>>;
}

export function defaultMediaConfigPath(env: Record<string, string | undefined> = process.env): string {
  if (env[MediaConfigEnv]) return path.resolve(env[MediaConfigEnv]!);
  const home = env.HOME || os.homedir();
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'onset', 'media-providers.json');
  if (process.platform === 'win32')
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'onset', 'media-providers.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'onset', 'media-providers.json');
}

/** 读取用户级多模态供应商配置（绝不读取项目 .env）。 */
export function loadMediaProviderConfigs(
  env: Record<string, string | undefined> = process.env,
): Record<MediaProviderId, MediaProviderConfig> {
  const file = defaultMediaConfigPath(env);
  const saved: Partial<Record<MediaProviderId, MediaProviderConfig>> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { providers?: Record<string, MediaProviderConfig> };
      Object.assign(saved, parsed.providers ?? {});
    } catch {
      // 忽略损坏配置
    }
  }
  return {
    'openai-compatible': {
      id: 'openai-compatible',
      enabled: saved['openai-compatible']?.enabled ?? Boolean(env.OPENAI_API_KEY),
      base_url: saved['openai-compatible']?.base_url || env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      api_key: saved['openai-compatible']?.api_key || env.OPENAI_API_KEY,
      default_models: { image: 'gpt-image-1', audio: 'tts-1', ...saved['openai-compatible']?.default_models },
    },
    dashscope: {
      id: 'dashscope',
      enabled: saved.dashscope?.enabled ?? Boolean(env.DASHSCOPE_API_KEY),
      base_url: saved.dashscope?.base_url || 'https://dashscope.aliyuncs.com/api/v1',
      api_key: saved.dashscope?.api_key || env.DASHSCOPE_API_KEY,
      default_models: { image: 'wan2.7-image', video: 'wan2.6-i2v', ...saved.dashscope?.default_models },
    },
    fal: {
      id: 'fal',
      enabled: saved.fal?.enabled ?? Boolean(env.FAL_KEY),
      base_url: saved.fal?.base_url || 'https://queue.fal.run',
      api_key: saved.fal?.api_key || env.FAL_KEY,
      default_models: {
        image: 'fal-ai/flux/schnell',
        video: 'fal-ai/wan/v2.2-a14b/image-to-video',
        audio: 'fal-ai/elevenlabs/sound-effects/v2',
        ...saved.fal?.default_models,
      },
    },
    codex: {
      id: 'codex',
      enabled: saved.codex?.enabled ?? true,
      default_models: { image: 'image-generation', ...saved.codex?.default_models },
    },
  };
}

/** 保存单个供应商配置到用户级私有文件（0600 权限）。 */
export function saveMediaProviderConfig(
  cfg: MediaProviderConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  const file = defaultMediaConfigPath(env);
  let all: Record<string, MediaProviderConfig> = {};
  if (fs.existsSync(file)) {
    try {
      all =
        (JSON.parse(fs.readFileSync(file, 'utf8')) as { providers?: Record<string, MediaProviderConfig> }).providers ??
        {};
    } catch {
      all = {};
    }
  }
  all[cfg.id] = cfg;
  atomicWrite(file, marshalIndent({ schema: 1, providers: all }) + '\n', 0o600);
}

/** 列出全部供应商状态（绝不返回 API Key 原文）。 */
export function listMediaProviders(env: Record<string, string | undefined> = process.env): ProviderSummary[] {
  const cfgs = loadMediaProviderConfigs(env);
  let hasCodex = false;
  try {
    lookPath('codex', env.PATH ?? '');
    hasCodex = true;
  } catch {
    hasCodex = false;
  }
  return [
    {
      id: 'dashscope',
      label: '阿里云百炼（Wan 图像/视频）',
      configured: Boolean(cfgs.dashscope.enabled && cfgs.dashscope.api_key),
      source: cfgs.dashscope.api_key ? (env.DASHSCOPE_API_KEY === cfgs.dashscope.api_key ? 'env' : 'config') : 'none',
      modalities: ['image', 'video'],
      default_models: cfgs.dashscope.default_models ?? {},
    },
    {
      id: 'fal',
      label: 'fal.ai（Flux / Wan / ElevenLabs SFX）',
      configured: Boolean(cfgs.fal.enabled && cfgs.fal.api_key),
      source: cfgs.fal.api_key ? (env.FAL_KEY === cfgs.fal.api_key ? 'env' : 'config') : 'none',
      modalities: ['image', 'video', 'audio'],
      default_models: cfgs.fal.default_models ?? {},
    },
    {
      id: 'openai-compatible',
      label: 'OpenAI 兼容图像/音效服务',
      configured: Boolean(cfgs['openai-compatible'].enabled && cfgs['openai-compatible'].api_key),
      source: cfgs['openai-compatible'].api_key
        ? env.OPENAI_API_KEY === cfgs['openai-compatible'].api_key
          ? 'env'
          : 'config'
        : 'none',
      modalities: ['image', 'audio'],
      default_models: cfgs['openai-compatible'].default_models ?? {},
    },
    {
      id: 'codex',
      label: '本机 Codex Image（复用 CLI 登录态）',
      configured: Boolean(cfgs.codex.enabled && hasCodex),
      source: hasCodex ? 'local-cli' : 'none',
      modalities: ['image'],
      default_models: cfgs.codex.default_models ?? {},
    },
  ];
}
