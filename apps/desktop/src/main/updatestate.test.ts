import { describe, expect, it } from 'vitest';
import { busyLines, disabledReason, errorText, initialState, notesText, wantsPrerelease } from './updatestate';

describe('update state', () => {
  it('only checks in a packaged client on macOS or Windows, outside tests', () => {
    const on = { packaged: true, platform: 'darwin', env: {} };
    expect(disabledReason(on)).toBe('');
    expect(disabledReason({ ...on, platform: 'win32' })).toBe('');
    expect(disabledReason({ ...on, packaged: false })).toContain('开发版');
    expect(disabledReason({ ...on, env: { ONSET_DESKTOP_BACKGROUND: '1' } })).toContain('测试');
    expect(disabledReason({ ...on, env: { ONSET_DISABLE_UPDATE: '1' } })).toContain('ONSET_DISABLE_UPDATE');
    expect(disabledReason({ ...on, platform: 'linux' })).toContain('发布页');
    expect(initialState('2.1.0', '开发版不检查更新')).toMatchObject({ status: 'disabled', current: '2.1.0' });
    expect(initialState('2.1.0', '').status).toBe('idle');
  });

  it('takes prereleases only when running one', () => {
    expect(wantsPrerelease('2.1.0')).toBe(false);
    expect(wantsPrerelease('2.1.0-beta.2')).toBe(true);
  });

  it('turns release notes into plain text', () => {
    expect(notesText('<h2>新功能</h2><ul><li>插件中心</li><li>自动更新 &amp; 代理</li></ul>')).toBe('新功能\n· 插件中心\n· 自动更新 & 代理');
    expect(notesText([{ version: '2.1.0', note: '<p>一</p>' }, { version: '2.0.1', note: '二' }])).toBe('一\n\n二');
    expect(notesText(null)).toBe('');
    expect(notesText('x'.repeat(50), 10)).toBe('xxxxxxxxxx…');
  });

  it('says what went wrong in the user\'s terms', () => {
    expect(errorText(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toContain('连不上更新服务器');
    expect(errorText(new Error('getaddrinfo ENOTFOUND github.com'))).toContain('网络与更新');
    expect(errorText(new Error('Could not get code signature for running application'))).toContain('没有签名');
    expect(errorText(new Error('Cannot find latest-mac.yml in the latest release artifacts (https://…): HttpError: 404'))).toContain('还没有这一版的更新文件');
    expect(errorText(new Error('sha512 checksum mismatch, expected x'))).toContain('校验值对不上');
    expect(errorText('something else\nstack')).toBe('something else');
  });

  it('lists what a restart would interrupt by project name', () => {
    expect(busyLines([{ project: '/Users/me/片子/讲解 A', holder: '一轮对话' }])).toEqual(['讲解 A：一轮对话']);
    expect(busyLines([])).toEqual([]);
  });
});
