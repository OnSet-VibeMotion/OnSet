import { describe, expect, it } from 'vitest';
import { MissingError, isMissing, missing } from './index';

// Go 版没有测试；这里钉住文案与 errors.As 的等价行为。
describe('prereq', () => {
  it('formats the message and unwraps causes', () => {
    expect(missing('HyperFrames CLI 0.8.225', '没有装在 /x').message).toBe(
      '缺少前置资源：HyperFrames CLI 0.8.225（没有装在 /x）。请在客户端的工具准备页安装（首页的「召集你的摄制组」，或顶栏的「还差几项工具 · 去安装」；网络慢可以在「网络」里填代理，断了重试会接着下），装好后再重试',
    );
    expect(new MissingError('X').message.startsWith('缺少前置资源：X。')).toBe(true);
    expect(isMissing(new Error('wrap', { cause: missing('a', '') }))).toBe(true);
    expect(isMissing(new Error('other'))).toBe(false);
    expect(isMissing(null)).toBe(false);
  });
});
