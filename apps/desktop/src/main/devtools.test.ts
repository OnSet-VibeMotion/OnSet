import { describe, expect, it } from 'vitest';
import { DefaultDebugPort, debugPort } from './devtools';

describe('开发时的调试端口', () => {
  it('只在没打包、不是后台运行时开，默认 9333', () => {
    expect(debugPort({ packaged: false, background: false, env: {} })).toBe(DefaultDebugPort);
    expect(DefaultDebugPort).toBe(9333);
    expect(debugPort({ packaged: true, background: false, env: {} })).toBeNull();
    expect(debugPort({ packaged: false, background: true, env: {} })).toBeNull();
    // 打包版即使设了环境变量也不开。
    expect(debugPort({ packaged: true, background: false, env: { ONSET_DESKTOP_DEBUG_PORT: '9444' } })).toBeNull();
  });
  it('ONSET_DESKTOP_DEBUG_PORT 换端口或关掉，乱填报错', () => {
    expect(debugPort({ packaged: false, background: false, env: { ONSET_DESKTOP_DEBUG_PORT: ' 9444 ' } })).toBe(9444);
    for (const off of ['off', 'OFF', '0', 'false', 'no']) expect(debugPort({ packaged: false, background: false, env: { ONSET_DESKTOP_DEBUG_PORT: off } })).toBeNull();
    for (const bad of ['abc', '80', '70000', '9333.5']) expect(() => debugPort({ packaged: false, background: false, env: { ONSET_DESKTOP_DEBUG_PORT: bad } })).toThrow('ONSET_DESKTOP_DEBUG_PORT');
  });
});
