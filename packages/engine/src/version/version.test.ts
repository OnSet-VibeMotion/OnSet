import { afterEach, describe, expect, it } from 'vitest';
import { amVersion, parseManifest } from '../flow';
import { getToolVersion as sceneToolVersion } from '../scene';
import { compatVersion, getHostVersion, getToolVersion, setHostVersion, setToolVersion } from './index';

afterEach(() => {
  setHostVersion('');
  setToolVersion('dev');
});

const manifest = JSON.stringify({
  id: 'my-step',
  version: '1.0.0',
  name: '我的一站',
  requires: { am: '0.6.0' },
  nodes: [{ id: 'my-node', label: '我的站点', step: 'final', outputs: ['production/mine/out.json'] }],
});

describe('version', () => {
  it('scene re-exports the same tool version', () => {
    setToolVersion('1.2.3');
    expect(sceneToolVersion()).toBe('1.2.3');
  });

  it('prefers the host version for compatibility checks without touching the tool version', () => {
    setToolVersion('0.9.0');
    expect(compatVersion()).toBe('0.9.0');
    setHostVersion('0.5.0');
    expect(getHostVersion()).toBe('0.5.0');
    expect(compatVersion()).toBe('0.5.0');
    expect(amVersion()).toBe('0.5.0');
    // 渲染指纹用的工具版本不变。
    expect(getToolVersion()).toBe('0.9.0');
    expect(sceneToolVersion()).toBe('0.9.0');
    expect(() => parseManifest(manifest)).toThrow(/现在是 0\.5\.0/);
    setHostVersion('0.6.0');
    expect(parseManifest(manifest).requires.am).toBe('0.6.0');
  });

  it('falls back to the tool version, and skips the check for dev builds', () => {
    setToolVersion('0.5.0');
    expect(() => parseManifest(manifest)).toThrow(/现在是 0\.5\.0/);
    setToolVersion('dev');
    expect(parseManifest(manifest).requires.am).toBe('0.6.0');
    setHostVersion('dev');
    expect(parseManifest(manifest).requires.am).toBe('0.6.0');
  });
});
