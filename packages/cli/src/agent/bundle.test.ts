import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentModule } from './types';

const require = createRequire(import.meta.url);
const cliDir = fileURLToPath(new URL('../../', import.meta.url));
let tmp: string;
let agent: AgentModule;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onset bundle '));
  const built = path.join(tmp, 'build');
  execFileSync(process.execPath, ['build.mjs', built], { cwd: cliDir, timeout: 60_000 });
  // 和客户端一样挪走整份构建产物；附近没有仓库的 node_modules。
  const relocated = path.join(tmp, '应用资源', 'cli');
  fs.mkdirSync(path.dirname(relocated), { recursive: true });
  fs.renameSync(built, relocated);
  agent = require(path.join(relocated, 'onset-agent.cjs')) as AgentModule;
}, 60_000);

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

it('delivers PNG and JPEG images to the model from the relocated production bundle', async () => {
  const photon = require('@silvia-odwyer/photon-node');
  const workdir = path.join(tmp, 'project');
  fs.mkdirSync(workdir);
  const pixels = new Uint8Array(2400 * 1200 * 4).fill(255);
  const source = new photon.PhotonImage(pixels, 2400, 1200);
  try {
    fs.writeFileSync(path.join(workdir, 'frame.png'), source.get_bytes());
    fs.writeFileSync(path.join(workdir, 'frame.jpg'), source.get_bytes_jpeg(80));
  } finally {
    source.free();
  }
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'vision' }] });
  let images: { data: string; mimeType: string }[] = [];
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('read', { path: 'frame.png' }),
      fauxToolCall('read', { path: 'frame.jpg' }),
    ], { stopReason: 'toolUse' }),
    context => {
      images = context.messages.flatMap(m => m.role === 'toolResult'
        ? m.content.filter(c => c.type === 'image') : []);
      return fauxAssistantMessage('检查完成');
    },
  ]);
  const result = await agent.runAgent({
    request: {
      workdir, profile: 'renderer', prompt: '读取两张图片', agent_dir: path.join(tmp, 'agent'),
      service: { id: 'test', name: 'test', protocol: 'openai', base_url: 'https://faux.invalid', model: 'vision', vision: true, key: 'test' },
    },
    tools: [], gate: async () => null, write: () => {},
    setupModels: runtime => {
      (runtime as { registerNativeProvider(p: unknown): void }).registerNativeProvider(faux.provider);
      return 'faux/vision';
    },
  });
  expect(result).toEqual({ ok: true });
  expect(images).toHaveLength(2);
  for (const image of images) {
    const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data, 'base64'));
    try {
      expect(decoded.get_width()).toBe(2000);
      expect(decoded.get_height()).toBe(1000);
    } finally {
      decoded.free();
    }
  }
});
