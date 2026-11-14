import { describe, expect, it } from 'vitest';
import { isColor, parseSkin, swatch } from './skin';

describe('skin', () => {
  it('parses a skin and keeps only what it declares', () => {
    const s = parseSkin({ id: 'mint', name: '薄荷', scheme: 'light', tokens: { bg: '#f0fff4', accent: 'rgb(30, 140, 90)' }, fonts: { serif: "'Songti SC', serif" }, radius: 6, pet: { filter: { hue: 120 } } });
    expect(s).toEqual({ id: 'mint', name: '薄荷', description: '', scheme: 'light', tokens: { bg: '#f0fff4', accent: 'rgb(30, 140, 90)' }, fonts: { serif: "'Songti SC', serif" }, radius: 6, pet: { filter: { hue: 120 } } });
    expect(swatch(s)).toEqual(['#f0fff4', '#11100e', '#efe9dd', 'rgb(30, 140, 90)']);
  });

  it('accepts only plain colors, so a skin cannot load anything', () => {
    for (const ok of ['#fff', '#ffffff80', 'rgba(1,2,3,0.5)', 'hsl(30deg 50% 40%)', 'rgb(1 2 3 / 50%)']) expect(isColor(ok)).toBe(true);
    for (const bad of ['red', 'url(https://x.test/a.png)', 'var(--bg)', '#fff; background: url(x)', 'rgb(1,2,3);', 'color-mix(in srgb, red, blue)', 'expression(alert(1))']) expect(isColor(bad)).toBe(false);
    expect(() => parseSkin({ id: 'x1', name: 'x', tokens: { bg: 'url(https://x.test)' } })).toThrow('tokens.bg 要是颜色');
    expect(() => parseSkin({ id: 'x1', name: 'x', fonts: { sans: "local('a'), url(https://x.test/f.woff)" } })).toThrow('fonts.sans');
    expect(() => parseSkin({ id: 'x1', name: 'x', fonts: { sans: 'A; } body { background: red' } })).toThrow('fonts.sans');
  });

  it('rejects unknown tokens and out-of-range filters', () => {
    expect(() => parseSkin({ id: 'x1', name: 'x', tokens: { 'my-color': '#fff' } })).toThrow('不认识的字段：my-color');
    expect(() => parseSkin({ id: 'x1', name: 'x', css: 'body{}' })).toThrow('不认识的字段：css');
    expect(() => parseSkin({ id: 'x1', name: 'x', pet: { filter: { hue: 400 } } })).toThrow('filter.hue');
    expect(() => parseSkin({ id: 'x1', name: 'x', pet: { materials: { wood: ['#fff', '#000'] } } })).toThrow('三个颜色');
    expect(() => parseSkin({ id: 'Bad', name: 'x' })).toThrow('.id');
  });

  it('lets only a plugin page replace the pet', () => {
    expect(parseSkin({ id: 'cat', name: '猫', pet: { page: 'cat' } }, 'skin', ['cat']).pet.page).toBe('cat');
    expect(() => parseSkin({ id: 'cat', name: '猫', pet: { page: 'dog' } }, 'skin', ['cat'])).toThrow('pages 里没有 dog');
    expect(() => parseSkin({ id: 'cat', name: '猫', pet: { page: 'cat' } })).toThrow('只有第三方插件');
  });
});
