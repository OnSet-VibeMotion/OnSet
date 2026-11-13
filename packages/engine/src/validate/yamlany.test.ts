// yaml.v3 解码规则的补充用例（Go 版没有对应测试：Go 直接用 yaml.v3）。期望值取自 Go 的实际输出。
import { describe, expect, it } from 'vitest';
import { AnyMap, decodeFrontmatterYAML, deepEqual, formatV, GoFloat, GoTime } from './yamlany';

describe('decodeFrontmatterYAML', () => {
  it('distinguishes int from float like yaml.v3', () => {
    const m = decodeFrontmatterYAML('a: 1\nb: 1.0\nc: 0x10\nd: 017\ne: 1_000\nf: 08\ng: .5\nh: -0\ni: 1e3\n')!;
    expect(m.a).toBe(1);
    expect(m.b).toEqual(new GoFloat(1));
    expect(m.c).toBe(16);
    expect(m.d).toBe(15);
    expect(m.e).toBe(1000);
    expect(m.f).toEqual(new GoFloat(8));
    expect(m.g).toEqual(new GoFloat(0.5));
    expect(m.h).toBe(0);
    expect(m.i).toEqual(new GoFloat(1000));
    expect(deepEqual(m.a, m.b)).toBe(false);
  });

  it('keeps yes/no as strings and quoted scalars as strings', () => {
    const m = decodeFrontmatterYAML('a: yes\nb: "1"\nc: ~\nd:\ne: TRUE\n')!;
    expect(m).toEqual({ a: 'yes', b: '1', c: null, d: null, e: true });
  });

  it('decodes unquoted timestamps as time.Time', () => {
    const m = decodeFrontmatterYAML('a: 2026-01-02\nb: 2026-01-02T03:04:05.5+08:00\nc: "2026-01-02"\n')!;
    expect(m.a).toBeInstanceOf(GoTime);
    expect(formatV(m.a)).toBe('2026-01-02 00:00:00 +0000 UTC');
    expect(formatV(m.b)).toBe('2026-01-02 03:04:05.5 +0800 +0800');
    expect((m.b as GoTime).toJSON()).toBe('2026-01-02T03:04:05.5+08:00');
    expect(m.c).toBe('2026-01-02');
  });

  it('reports duplicate keys like yaml.v3', () => {
    expect(() => decodeFrontmatterYAML('a: 1\na: 2\n')).toThrow('yaml: unmarshal errors:\n  line 2: mapping key "a" already defined at line 1');
  });

  it('rejects unsafe tags and merge keys', () => {
    expect(() => decodeFrontmatterYAML('a: !custom 1\n')).toThrow('不安全的 YAML tag：!custom');
    expect(() => decodeFrontmatterYAML('a: !!binary aGk=\n')).toThrow('不安全的 YAML tag：!!binary');
    expect(() => decodeFrontmatterYAML('a:\n  <<: {b: 1}\n')).toThrow('不安全的 YAML tag：!!merge');
  });

  it('applies explicit core tags', () => {
    const m = decodeFrontmatterYAML('a: !!str 1\nb: !!float 1\n')!;
    expect(m.a).toBe('1');
    expect(m.b).toEqual(new GoFloat(1));
    expect(() => decodeFrontmatterYAML('a: !!int 1.5\n')).toThrow('yaml: cannot decode !!float `1.5` as a !!int');
  });

  it('decodes maps with non-string keys as map[any]any', () => {
    const m = decodeFrontmatterYAML('a: {1: x, b: y}\n')!;
    expect(m.a).toBeInstanceOf(AnyMap);
    // Go 的 %v 对 map[any]any 的键按类型的内存地址排序（fmtsort），机器相关，这里不断言顺序。
    expect((m.a as AnyMap).entries).toEqual([
      [1, 'x'],
      ['b', 'y'],
    ]);
  });

  it('rejects a non-map document', () => {
    expect(() => decodeFrontmatterYAML('- a\n')).toThrow('yaml: unmarshal errors:\n  line 1: cannot unmarshal !!seq into map[string]interface {}');
    expect(decodeFrontmatterYAML('')).toBeNull();
  });
});
