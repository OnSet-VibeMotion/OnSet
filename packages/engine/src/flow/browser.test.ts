import { describe, expect, it } from 'vitest';
import { parseManifest, experimentalFields } from './index';

const manifest = (browser?: unknown) => JSON.stringify({ id: 'web-helper', name: '网页助手', version: '1', browser });
describe('embedded plugin browser declaration', () => {
  it('requires explicit HTTPS origins and marks the capability experimental', () => {
    const parsed = parseManifest(manifest({ origins: ['https://creator.example.com'] }));
    expect(parsed.browser).toEqual({ origins: ['https://creator.example.com'] });
    expect(experimentalFields(parsed)).toContain('browser');
    expect(parseManifest(manifest()).browser).toBeUndefined();
  });
  it.each(['http://localhost', 'file:///tmp/a', 'https://*.example.com', 'https://example.com/path', 'https://user:pass@example.com'])('rejects %s', origin => {
    expect(() => parseManifest(manifest({ origins: [origin] }))).toThrow(/browser/);
  });
  it('rejects empty origins and unknown fields', () => {
    expect(() => parseManifest(manifest({ origins: [] }))).toThrow(/browser/);
    expect(() => parseManifest(manifest({ origins: ['https://example.com'], preload: 'evil.js' }))).toThrow();
  });
});
