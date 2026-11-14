import fs from 'node:fs';
import path from 'node:path';

/**
 * 从渲染工具的一行结构化输出里读出实际使用的模型；读不到时返回空串。
 *
 * claude、qoder、codebuddy 在 system/init 事件里带 model。codex 与 opencode 的流里
 * 没有模型名（2026-11 实测录制，见 agentrun/testdata），codex 改由
 * configuredModel 读配置文件，opencode 记为未知。
 */
export function detectModel(tool: string, line: string): string {
  // director（导演，onset 自带的编排）照 claude 系的格式输出，见 director 包。
  if (tool !== 'claude' && tool !== 'qoder' && tool !== 'codebuddy' && tool !== 'director') return '';
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return '';
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return '';
  const e = event as Record<string, unknown>;
  for (const key of ['type', 'subtype', 'model']) {
    const v = e[key];
    if (v !== undefined && v !== null && typeof v !== 'string') return '';
  }
  if (e.type !== 'system' || e.subtype !== 'init') return '';
  return typeof e.model === 'string' ? e.model.trim() : '';
}

/**
 * 返回渲染工具配置文件里声明的默认模型；没有声明或读不到时返回空串。
 * 目前只有 codex 能这样读：$CODEX_HOME/config.toml（缺省 ~/.codex）顶层的 model。
 */
export function configuredModel(tool: string, env: Record<string, string | undefined>): string {
  if (tool !== 'codex') return '';
  let home = env.CODEX_HOME ?? '';
  if (home === '') {
    if (!env.HOME) return '';
    home = path.join(env.HOME, '.codex');
  }
  let body: string;
  try {
    body = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  } catch {
    return '';
  }
  const lines = body.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '').trim();
    // 只认顶层键：进了 [profiles.x] 之类的表，model 就不是默认模型了。
    if (line.startsWith('[')) return '';
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq).trim() !== 'model') continue;
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf('#');
    if (hash >= 0 && !value.startsWith('"')) value = value.slice(0, hash).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'")) {
      const end = value.indexOf(value[0], 1);
      if (end >= 0) return value.slice(1, end);
    }
    return value;
  }
  return '';
}
