import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * 从 Finder / Dock 启动的应用拿不到用户在终端里配置的 PATH（只有 /usr/bin:/bin:/usr/sbin:/sbin），
 * 于是编排工具（claude、codex…）、ffmpeg、asdf 管理的 node 全都找不到，报错却只是「command not found」。
 * 启动时从用户的登录 shell 读一份 PATH 合并进来；读不到就退回补上常见目录。
 */
export function loginShellPath(): string {
  const current = process.env.PATH ?? '';
  const shell = process.env.SHELL || '/bin/zsh';
  let fromShell = '';
  try {
    // -i -l：交互 + 登录，才会读到 .zshrc / .zprofile 里的 PATH。用标记包住，避免 shell 启动时的输出混进来。
    const out = execFileSync(shell, ['-ilc', 'printf "__AM_PATH__%s__AM_PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    fromShell = /__AM_PATH__(.*)__AM_PATH__/s.exec(out)?.[1] ?? '';
  } catch {
    // shell 起不来或超时，用下面的兜底目录。
  }
  const home = os.homedir();
  const fallback = [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const parts = [...fromShell.split(':'), ...current.split(':'), ...fallback].filter(Boolean);
  return [...new Set(parts)].join(':');
}
