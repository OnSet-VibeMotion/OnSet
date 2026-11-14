import fs from 'node:fs';
import path from 'node:path';

export interface DirectoryDrive {
  name: string;
  path: string;
}

/** Windows 的浏览边界是当前盘的根；其他平台沿用用户主目录。 */
export function directoryBrowseRoot(directory: string, home: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.win32.parse(path.win32.resolve(directory)).root : path.posix.resolve(home);
}

export function withinDirectoryBrowseRoot(directory: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    // 只接受普通盘符路径，不把 UNC 或设备命名空间当作本机磁盘。
    return /^[a-z]:\\$/i.test(directoryBrowseRoot(directory, home, platform));
  }
  const relative = path.posix.relative(path.posix.resolve(home), path.posix.resolve(directory));
  return relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative);
}

/** 不启动 shell，只列出操作系统当前能访问的盘符；非 Windows 不探测磁盘。 */
export function directoryDrives(
  platform: NodeJS.Platform = process.platform,
  available: (root: string) => boolean = (root) => fs.statSync(root).isDirectory(),
): DirectoryDrive[] {
  if (platform !== 'win32') return [];
  const drives: DirectoryDrive[] = [];
  for (let code = 65; code <= 90; code++) {
    const name = String.fromCharCode(code) + ':';
    const root = name + '\\';
    try {
      if (available(root)) drives.push({ name, path: root });
    } catch {
      // 空光驱、未挂载或没有访问权限的卷不出现在选择器里。
    }
  }
  return drives;
}
