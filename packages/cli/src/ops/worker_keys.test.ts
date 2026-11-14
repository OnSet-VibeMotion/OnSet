import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import * as director from '@am/engine/director';
import { takeHandedKeys } from './worker';

afterEach(() => director.useKeys(null));

describe('director keys handed to an op worker', () => {
  it('reads keys from stdin only when asked, keeps them in memory and drops the flag', async () => {
    const env: NodeJS.ProcessEnv = { [director.KeysStdinEnv]: '1' };
    await takeHandedKeys(Readable.from([Buffer.from('{"deepseek":"sk-1","bad":3}\n')]), env);
    expect(env[director.KeysStdinEnv]).toBeUndefined();
    // 有交来的 key 就不读文件（数据目录给空也照样拿得到）。
    expect(director.loadKeys('')).toEqual({ deepseek: 'sk-1' });
  });

  it('leaves stdin alone without the flag', async () => {
    let read = false;
    const input = (async function* () {
      read = true;
      yield Buffer.from('{"x":"y"}');
    })();
    await takeHandedKeys(input, {});
    expect(read).toBe(false);
    expect(director.loadKeys('')).toEqual({});
  });

  it('only memory consolidation (which starts the Director) gets the keys', () => {
    expect([...director.KeyOps]).toEqual(['memory_consolidate']);
  });
});
