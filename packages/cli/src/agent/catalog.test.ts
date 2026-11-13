/**
 * 引擎里那份「看不了图片的模型」（director.TextOnlyModels）与推荐模型的 vision 标记，对着 pi 自带的模型目录核对。
 * 引擎拿不到 pi（它只打进 am-agent.cjs），只能照抄；升级 pi 后这里失败，用 AM_UPDATE_GOLDEN=1 重跑重写 textonly.ts，
 * 再看一眼 director.Providers 的推荐模型还在不在、能不能读图。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import * as director from '@am/engine/director';

const textOnlyFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../engine/src/director/textonly.ts');

const header = `/**
 * pi 自带模型目录里看不了图片的模型（输入只有 text），只收客户端里能直接选的几家服务商（director.Providers）。
 *
 * 引擎拿不到 pi 的模型目录（pi 只打进 am-agent.cjs），所以照抄一份。这份表由
 * packages/cli/src/agent/catalog.test.ts 对着 pi 自带的目录逐家核对，升级 pi 后那条测试失败时，
 * 用 AM_UPDATE_GOLDEN=1 重跑它重写这个文件。不在表里的模型按「不知道」处理，不按「看不了」。
 */
`;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-catalog-test-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function catalog(): Promise<Map<string, { id: string; image: boolean }[]>> {
  const runtime = await ModelRuntime.create({
    authPath: path.join(tmp, 'auth.json'),
    modelsPath: null,
    modelsStorePath: path.join(tmp, 'models-store.json'),
    allowModelNetwork: false,
  });
  const out = new Map<string, { id: string; image: boolean }[]>();
  for (const p of director.Providers) {
    out.set(
      p.id,
      runtime.getModels(p.id).map((m) => ({ id: m.id, image: (m.input as readonly string[]).includes('image') })),
    );
  }
  return out;
}

describe('director model catalog', () => {
  it('lists exactly the text-only models of pi’s bundled catalog', async () => {
    const got = await catalog();
    const textOnly: Record<string, string[]> = {};
    for (const [provider, models] of got) {
      expect(models.length, `pi 的目录里没有 ${provider}`).toBeGreaterThan(0);
      textOnly[provider] = [...new Set(models.filter((m) => !m.image).map((m) => m.id))].sort();
    }
    if (process.env.AM_UPDATE_GOLDEN === '1') {
      const body = Object.entries(textOnly)
        .map(([k, v]) => `  ${JSON.stringify(k)}: [${v.map((id) => JSON.stringify(id)).join(', ')}],\n`)
        .join('');
      fs.writeFileSync(textOnlyFile, header + 'export const TextOnlyModels: Readonly<Record<string, readonly string[]>> = {\n' + body + '};\n');
    }
    expect(textOnly).toEqual(director.TextOnlyModels);
  });

  it('marks each recommended model by whether it can read images', async () => {
    const got = await catalog();
    for (const p of director.Providers) {
      const id = p.defaultModel.slice(p.id.length + 1);
      const model = got.get(p.id)!.find((m) => m.id === id);
      expect(model, `推荐模型 ${p.defaultModel} 不在 pi 的目录里`).toBeTruthy();
      expect(p.vision, p.defaultModel).toBe(model!.image);
    }
  });
});
