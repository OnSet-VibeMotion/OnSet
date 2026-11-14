/**
 * 导演的预设（director.Presets）对着 pi 自带的模型目录核对：每个预设的协议、base URL 与模型在目录里都有一项，
 * 能不能看图与目录一致。这样预设填出来的服务登记进 pi 时（serviceModel），能沿用目录里的上下文长度与推理参数。
 * 升级 pi 后这条失败，就照新目录改 Presets。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import * as director from '@onset/engine/director';
import { serviceModel, ServiceProvider } from './pi';

async function runtime(): Promise<ModelRuntime> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-catalog-'));
  return ModelRuntime.create({ modelsPath: null, modelsStorePath: path.join(dir, 'models-store.json'), allowModelNetwork: false });
}

const service = (p: Partial<director.ResolvedService>): director.ResolvedService => ({ id: 's', name: 'n', protocol: 'openai', base_url: 'https://x.example/v1', model: 'm', vision: false, key: 'k', ...p });

describe('director presets', () => {
  it('match a model in the pi catalog', async () => {
    const rt = await runtime();
    for (const p of director.Presets) {
      // 接口可以不同（OpenAI 在目录里是 Responses，预设走 Chat Completions），base URL 与模型名要对上。
      const hit = rt.getModels().find((m) => m.id === p.model && m.baseUrl.replace(/\/+$/, '') === p.baseURL);
      expect(hit, p.id).toBeDefined();
      expect(hit!.input.includes('image'), p.id).toBe(p.vision);
    }
  });

  it('registers a preset service with the catalog’s limits', async () => {
    const rt = await runtime();
    const deepseek = director.Presets.find((p) => p.id === 'deepseek')!;
    const m = await serviceModel(rt, service({ base_url: deepseek.baseURL + '/', model: deepseek.model }), deepseek.model);
    expect(m.provider).toBe(ServiceProvider);
    expect(m.api).toBe('openai-completions');
    expect(m.baseUrl).toBe(deepseek.baseURL);
    expect(m.reasoning).toBe(true);
    expect(m.contextWindow).toBeGreaterThan(128_000);
    expect(m.input).toEqual(['text']);
    expect(rt.hasConfiguredAuth(ServiceProvider)).toBe(true);
  });

  it('registers an unknown endpoint with safe defaults and the user’s vision flag', async () => {
    const rt = await runtime();
    const m = await serviceModel(rt, service({ protocol: 'anthropic', base_url: 'https://relay.example.com', vision: true, key: '' }), 'claude-x');
    expect(m.api).toBe('anthropic-messages');
    expect(m.baseUrl).toBe('https://relay.example.com');
    expect(m.reasoning).toBe(false);
    expect(m.contextWindow).toBe(128_000);
    expect(m.input).toEqual(['text', 'image']);
    // 本机服务没有 key：pi 也当它配好了。
    expect(rt.hasConfiguredAuth(ServiceProvider)).toBe(true);
  });
});
