import { describe, expect, it } from 'vitest';
import { formatFixed, formatG, goClean, goDir, goExt, goJoin, goQuote, goRound, goTrimSpace } from './index';

// 期望值取自 Go 1.25 的 strconv / fmt / math / strings / path 实际输出。
describe('gofmt', () => {
  it('formats fixed-point like strconv.FormatFloat(v, f, n, 64)', () => {
    const cases: [number, string, string, string][] = [
      [0.125, '0.12', '0', '0.125'],
      [0.375, '0.38', '0', '0.375'],
      [2.5, '2.50', '2', '2.500'],
      [-2.5, '-2.50', '-2', '-2.500'],
      [0.0625, '0.06', '0', '0.062'],
      [1.005, '1.00', '1', '1.005'],
      [-0.0001, '-0.00', '-0', '-0.000'],
      [123.456, '123.46', '123', '123.456'],
      [0, '0.00', '0', '0.000'],
      [-0, '-0.00', '-0', '-0.000'],
    ];
    for (const [v, two, zero, three] of cases) {
      expect([formatFixed(v, 2), formatFixed(v, 0), formatFixed(v, 3)], String(v)).toEqual([two, zero, three]);
    }
  });

  it('formats %v floats', () => {
    expect([1e6, 123456, 1e-5, 0.0001, 1.5, -2e20, 3.14159].map(formatG)).toEqual(['1e+06', '123456', '1e-05', '0.0001', '1.5', '-2e+20', '3.14159']);
  });

  it('rounds half away from zero', () => {
    expect([2.5, -2.5, 0.5, -0.5, 1.4999].map(goRound)).toEqual([3, -3, 1, -1, 1]);
  });

  it('quotes like strconv.Quote', () => {
    expect(goQuote('a"b\\c\n\t\x01中文\x7f')).toBe('"a\\"b\\\\c\\n\\t\\x01中文\\x7f"');
  });

  it('trims Go whitespace', () => {
    expect(goTrimSpace('\u0085 x ﻿')).toBe('x ﻿');
  });

  it('cleans, joins and splits slash paths like package path', () => {
    expect(['', 'a/../..', '/a/./b/', '../x/../y', 'a//b'].map(goClean)).toEqual(['.', '..', '/a/b', '../y', 'a/b']);
    expect([goDir('a/b/c.txt'), goExt('a.b/c.tar.gz'), goJoin('a', '', '../b')]).toEqual(['a/b', '.gz', 'b']);
  });
});
