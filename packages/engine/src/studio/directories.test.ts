import { describe, expect, it, vi } from 'vitest';
import { directoryBrowseRoot, directoryDrives, withinDirectoryBrowseRoot } from './directories';

describe('Windows directory browsing', () => {
  it.each(['C', 'D', 'E', 'F'])('allows local %s: paths outside the user profile', (drive) => {
    const directory = `${drive}:\\视频项目\\片场 测试`;
    expect(withinDirectoryBrowseRoot(directory, 'C:\\Users\\owner', 'win32')).toBe(true);
    expect(directoryBrowseRoot(directory, 'C:\\Users\\owner', 'win32')).toBe(`${drive}:\\`);
  });

  it.each(['\\\\server\\share\\project', '\\\\?\\C:\\project', '\\\\.\\C:\\project'])('rejects network and device paths: %s', (directory) => {
    expect(withinDirectoryBrowseRoot(directory, 'C:\\Users\\owner', 'win32')).toBe(false);
  });

  it('lists mounted drives and omits unavailable or unreadable drives', () => {
    const available = vi.fn((root: string) => {
      if (root === 'G:\\') throw new Error('Access denied');
      return ['C:\\', 'D:\\', 'E:\\', 'F:\\'].includes(root);
    });
    expect(directoryDrives('win32', available)).toEqual(['C', 'D', 'E', 'F'].map((letter) => ({ name: letter + ':', path: letter + ':\\' })));
  });
});

describe.each(['darwin', 'linux'] as const)('%s directory browsing remains scoped to HOME', (platform) => {
  it('keeps the home root and rejects parents, siblings and prefix lookalikes', () => {
    const home = '/users/owner';
    expect(directoryBrowseRoot('/users/owner/projects', home, platform)).toBe(home);
    expect(withinDirectoryBrowseRoot(home, home, platform)).toBe(true);
    expect(withinDirectoryBrowseRoot('/users/owner/projects', home, platform)).toBe(true);
    for (const outside of ['/users', '/users/other', '/users/owner-other', '/users/owner/../other']) {
      expect(withinDirectoryBrowseRoot(outside, home, platform), outside).toBe(false);
    }
    const probe = vi.fn(() => { throw new Error('must not probe drives'); });
    expect(directoryDrives(platform, probe)).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });
});
