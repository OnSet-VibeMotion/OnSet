import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import * as director from '@onset/engine/director';
import { takeHandedService } from './worker';

afterEach(() => director.useService(null));

const service = { id: 's-1', name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', vision: false, key: 'sk-1' };

describe('director service handed to an op worker', () => {
  it('reads the service from stdin only when asked, keeps it in memory and drops the flag', async () => {
    const env: NodeJS.ProcessEnv = { [director.ServiceStdinEnv]: '1' };
    await takeHandedService(Readable.from([Buffer.from(JSON.stringify(service) + '\n')]), env);
    expect(env[director.ServiceStdinEnv]).toBeUndefined();
    // 有交来的服务就不读文件（数据目录给空也照样拿得到）。
    expect(director.resolveService('')).toEqual(service);
  });

  it('leaves stdin alone without the flag', async () => {
    let read = false;
    const input = (async function* () {
      read = true;
      yield Buffer.from(JSON.stringify(service));
    })();
    await takeHandedService(input, {});
    expect(read).toBe(false);
    expect(director.resolveService('')).toBeNull();
  });

  it('only memory consolidation (which starts the Director) gets the service', () => {
    expect([...director.KeyOps]).toEqual(['memory_consolidate']);
  });
});
