import * as filmstyle from '../filmstyle';
import fs from 'node:fs';
import path from 'node:path';

export const LocalStyleReceipt = 'Windows 本地风格操作：';

/** 模型不可用是请求配置错误，重开相同模型会话不会恢复，且会重新发送长历史。 */
export function windowsResumeFallbackAllowed(error: Error, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return true;
  return !(/model_not_found/.test(error.message) || /model.{0,120}not supported when using Codex with a ChatGPT account/i.test(error.message));
}

/** 仅接收界面明确发送的首次默认风格选择，不解析复合要求，不替换已有风格。 */
export function windowsStyleAction(message: string, projectRoot: string, platform: NodeJS.Platform = process.platform): filmstyle.Style | null {
  if (platform !== 'win32') return null;
  const match = /^整片风格用「([^」\r\n]+)」（([a-z0-9-]+\/[a-z0-9_-]+)）$/.exec(message);
  if (!match || match[0] !== message) return null;
  try {
    const production = path.join(projectRoot, 'production');
    if (fs.existsSync(production) && fs.readdirSync(production).some(name => /(?:storyboard|scene|shot)[-_]approval.*\.json$/i.test(name))) return null;
    const approvals = path.join(projectRoot, 'production/approvals');
    if (fs.existsSync(approvals) && fs.readdirSync(approvals).some(name => /storyboard|scene|shot/i.test(name))) return null;
    const scenes = path.join(projectRoot, 'scenes');
    if (fs.existsSync(scenes) && fs.readdirSync(scenes).some(id => fs.existsSync(path.join(scenes,id,'.onset-render.json')))) return null;
    if (filmstyle.installed(projectRoot).ok) return null;
    const style = filmstyle.lookup(match[2]);
    return style.cn === match[1] ? style : null;
  } catch {
    return null;
  }
}

/** 本地操作没有发给模型；续接时补入真实回执，避免模型仍按旧风格制作。 */
export function localStyleContext(events: ReadonlyArray<{kind: string; text?: string}>): string {
  const receipt = events.filter(e => e.kind === 'notice' && e.text?.startsWith(LocalStyleReceipt)).at(-1)?.text;
  return receipt ? `客户端已执行的操作回执（不是新的用户批准）：\n${receipt}\n风格已安装，无需重复 film_style_use；稿件、配音和分镜仍遵守各自确认。\n\n` : '';
}
