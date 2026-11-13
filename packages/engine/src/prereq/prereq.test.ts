import { describe, expect, it } from 'vitest';
import { MissingError, isMissing, missing } from './index';

// Go 版没有测试；这里钉住文案与 errors.As 的等价行为。
describe('prereq', () => {
  it('formats the message and unwraps causes', () => {
    expect(missing('HyperFrames CLI 0.8.225', '没有装在 /x').message).toBe(
      '缺少前置资源：HyperFrames CLI 0.8.225（没有装在 /x）。先在终端运行 am setup 准备好（可以加 --proxy 走代理，断了重跑会接着下），再重试',
    );
    expect(new MissingError('X').message.startsWith('缺少前置资源：X。')).toBe(true);
    expect(isMissing(new Error('wrap', { cause: missing('a', '') }))).toBe(true);
    expect(isMissing(new Error('other'))).toBe(false);
    expect(isMissing(null)).toBe(false);
  });
});
