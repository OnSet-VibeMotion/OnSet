import fs from 'node:fs';
import path from 'node:path';

/**
 * 本机已准备好的独立数据目录由安装旁的显式配置指定。开始菜单直接起 exe 时也要在
 * 取得单实例锁之前接回同一份 userData，否则启动器与 exe 会各开一个客户端、读两份项目表。
 * 普通安装没有这份配置，继续使用系统目录；调用方显式传入的环境（包括 e2e）优先。
 */
export function configureInstalledRuntime(
  executable: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  const profile = path.join(path.dirname(executable), 'onset-runtime.json');
  if (!fs.existsSync(profile)) return false;
  const config = JSON.parse(fs.readFileSync(profile, 'utf8')) as {
    schema?: unknown;
    runtime_dir?: unknown;
    codex_dir?: unknown;
  };
  if (config.schema !== 1 || typeof config.runtime_dir !== 'string' || !config.runtime_dir.trim()) {
    throw new Error('片场本机数据目录配置无效：' + profile);
  }
  const runtime = path.resolve(path.dirname(profile), config.runtime_dir);
  for (const file of ['settings.conf', 'studio/projects.json']) {
    if (!fs.statSync(path.join(runtime, file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('片场本机数据目录不完整：' + path.join(runtime, file));
    }
  }
  // 开始菜单不会继承 Codex 桌面端注入的 PATH。允许本机配置明确选择 CLI，避免又选中
  // PATH 前面的旧 npm 版（它的账号模型目录可能不同）。固定入口失效时不能静默换回旧版。
  let configuredCodex: string | undefined;
  if (config.codex_dir !== undefined) {
    if (typeof config.codex_dir !== 'string' || !config.codex_dir.trim())
      throw new Error('片场 Codex 目录配置无效：' + profile);
    configuredCodex = path.resolve(path.dirname(profile), config.codex_dir);
    if (!fs.statSync(path.join(configuredCodex, 'codex.exe'), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('片场配置的 Codex 已不存在，请更新 onset-runtime.json 的 codex_dir：' + configuredCodex);
    }
  }
  const defaults: Record<string, string> = {
    ONSET_BIN_DIR: path.join(runtime, 'bin'),
    ONSET_WINDOWS_RESOURCES_DIR: runtime,
    ONSET_SETTINGS_FILE: path.join(runtime, 'settings.conf'),
    ONSET_DESKTOP_USER_DATA: path.join(runtime, 'desktop'),
    ONSET_STUDIO_CONFIG: path.join(runtime, 'studio', 'projects.json'),
    ONSET_MEMORY_DIR: path.join(runtime, 'memory'),
    ONSET_VOICES_DIR: path.join(runtime, 'voices'),
    ONSET_SERIES_DIR: path.join(runtime, 'series'),
    ONSET_AGENT_DIR: path.join(runtime, 'agent'),
    ONSET_STATIONS_DIR: path.join(runtime, 'stations'),
    ONSET_HYPERFRAMES_CLI_DIR: path.join(runtime, 'hyperframes'),
    ONSET_BEAT_ENV_DIR: path.join(runtime, 'tools', 'venv', 'beat-this-1.1.0'),
    TORCH_HOME: path.join(runtime, 'cache', 'torch'),
    UV_CACHE_DIR: path.join(runtime, 'cache', 'uv'),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  if (fs.existsSync(path.join(runtime, 'verification', 'local-resources.json')))
    defaults.XDG_DATA_HOME = path.join(runtime, 'data');
  const python = path.join(runtime, 'python', 'cpython-3.12.9-windows-x86_64-none', 'python.exe');
  if (fs.existsSync(python)) defaults.ONSET_BEAT_BASE_PYTHON = python;
  for (const [key, value] of Object.entries(defaults)) env[key] ??= value;
  const currentPath = env.PATH ?? env.Path ?? '';
  const nativeCodex =
    configuredCodex ??
    currentPath.split(path.delimiter).find((dir) => dir && fs.existsSync(path.join(dir, 'codex.exe')));
  // 与本机启动器一致，优先桌面版 Codex 的原生 exe；工具目录接在已有 PATH 后面。
  env.PATH = [...new Set([nativeCodex, ...currentPath.split(path.delimiter), env.ONSET_BIN_DIR].filter(Boolean))].join(
    path.delimiter,
  );
  // process.env 在 Windows 上不区分大小写：删 Path 也会把刚写的 PATH 一起删掉。
  // 只有独立的普通环境对象才需要去掉旧的拼写。
  if (env !== process.env) delete env.Path;
  const data = env.XDG_DATA_HOME
    ? path.join(env.XDG_DATA_HOME, 'onset')
    : env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, 'onset')
      : '';
  const model = path.join(data, 'models', 'iic__speech_timestamp_prediction-v1-16k-offline');
  if (
    data &&
    ['am.mvn', 'config.yaml', 'configuration.json', 'model.pt', 'seg_dict', 'tokens.json'].every((file) =>
      fs.existsSync(path.join(model, file)),
    )
  )
    env.ALIGN_MODEL ??= model;
  env.ONSET_PASSTHROUGH_ENV = [
    ...new Set(
      [
        ...(env.ONSET_PASSTHROUGH_ENV ?? '').split(','),
        'ONSET_WINDOWS_RESOURCES_DIR',
        'ONSET_BEAT_ENV_DIR',
        'ONSET_BEAT_BASE_PYTHON',
        'ALIGN_MODEL',
        'PYTHONUTF8',
        'PYTHONIOENCODING',
      ].filter(Boolean),
    ),
  ].join(',');
  return true;
}
