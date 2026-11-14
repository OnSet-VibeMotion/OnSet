import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function prepareLocalRuntime() {
  const runtime = path.join(projectRoot, '.onset-local');
  const bin = path.join(runtime, 'bin');
  const logs = path.join(runtime, 'logs');
  for (const directory of [bin, logs]) fs.mkdirSync(directory, { recursive: true });
  const settings = path.join(runtime, 'settings.conf');
  if (!fs.existsSync(settings)) {
    fs.writeFileSync(settings, [
      '# Defaults for this local installation; editable in the application.',
      'ORCHESTRATOR=codex',
      'RENDERER=codex',
      'TTS_PROVIDER=edge',
      'ALIGN_PROVIDER=auto',
      'SCENE_JOBS=1',
      'MEMORY=on',
      'AUTO_APPROVE=off',
      '',
    ].join('\n'));
  }
  const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
  // This Windows installation also has an older npm codex.cmd ahead of the
  // desktop app's current codex.exe. Prefer the native executable for this
  // local client so it can use the models selected in the installed Codex app.
  const nativeCodexDir = process.platform === 'win32'
    ? inheritedPath.split(path.delimiter).find((directory) => directory && fs.existsSync(path.join(directory, 'codex.exe')))
    : undefined;
  const env = {
    ...process.env,
    PATH: [bin, nativeCodexDir, inheritedPath].filter(Boolean).join(path.delimiter),
    ONSET_BIN_DIR: bin,
    ONSET_SETTINGS_FILE: settings,
    ONSET_DESKTOP_USER_DATA: path.join(runtime, 'desktop'),
    ONSET_STUDIO_CONFIG: path.join(runtime, 'studio', 'projects.json'),
    ONSET_MEMORY_DIR: path.join(runtime, 'memory'),
    ONSET_VOICES_DIR: path.join(runtime, 'voices'),
    ONSET_AGENT_DIR: path.join(runtime, 'agent'),
    ONSET_STATIONS_DIR: path.join(runtime, 'stations'),
    ONSET_HYPERFRAMES_CLI_DIR: path.join(runtime, 'hyperframes'),
    DO_NOT_TRACK: '1',
    // Chrome's experimental drawElementImage capture changes between releases.
    PRODUCER_EXPERIMENTAL_FAST_CAPTURE: 'false',
    ONSET_PASSTHROUGH_ENV: [process.env.ONSET_PASSTHROUGH_ENV, 'DO_NOT_TRACK', 'PRODUCER_EXPERIMENTAL_FAST_CAPTURE'].filter(Boolean).join(','),
  };
  // Codex can itself run inside Electron. The client must start in GUI mode.
  delete env.ELECTRON_RUN_AS_NODE;
  const localNpmCLI = path.join(runtime, 'npm', 'bin', 'npm-cli.js');
  const npmCLI = process.platform === 'win32' && fs.existsSync(localNpmCLI) ? localNpmCLI : path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(npmCLI)) env.ONSET_NPM_CLI = npmCLI;
  if (process.platform === 'win32' && !env.HYPERFRAMES_BROWSER_PATH) {
    const candidates = [
      path.join(runtime, 'tools', 'chrome', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    const browser = candidates.find((candidate) => fs.existsSync(candidate));
    if (browser) env.HYPERFRAMES_BROWSER_PATH = browser;
  }
  if (process.platform === 'win32') {
    env.ONSET_WINDOWS_RESOURCES_DIR = runtime;
    env.ONSET_BEAT_ENV_DIR = path.join(runtime, 'tools', 'venv', 'beat-this-1.1.0');
    env.TORCH_HOME = path.join(runtime, 'cache', 'torch');
    env.UV_CACHE_DIR = path.join(runtime, 'cache', 'uv');
    const localPython = path.join(runtime, 'python', 'cpython-3.12.9-windows-x86_64-none', 'python.exe');
    if (fs.existsSync(localPython)) env.ONSET_BEAT_BASE_PYTHON = localPython;
    if (fs.existsSync(path.join(runtime, 'verification', 'local-resources.json'))) env.XDG_DATA_HOME = path.join(runtime, 'data');
    env.ONSET_PASSTHROUGH_ENV = [env.ONSET_PASSTHROUGH_ENV, 'ONSET_WINDOWS_RESOURCES_DIR', 'ONSET_BEAT_ENV_DIR', 'ONSET_BEAT_BASE_PYTHON'].filter(Boolean).join(',');
    const data = env.XDG_DATA_HOME
      ? path.join(env.XDG_DATA_HOME, 'onset')
      : env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'onset') : undefined;
    const model = data && path.join(data, 'models', 'iic__speech_timestamp_prediction-v1-16k-offline');
    if (model && ['am.mvn', 'config.yaml', 'configuration.json', 'model.pt', 'seg_dict', 'tokens.json'].every((file) => fs.existsSync(path.join(model, file)))) {
      env.ALIGN_MODEL ||= model;
      env.PYTHONUTF8 ||= '1';
      env.PYTHONIOENCODING ||= 'utf-8';
      env.ONSET_PASSTHROUGH_ENV = [env.ONSET_PASSTHROUGH_ENV, 'ALIGN_MODEL', 'PYTHONUTF8', 'PYTHONIOENCODING'].filter(Boolean).join(',');
      // Existing client processes also pick up this wrapper on their next tool call.
      const python = path.join(runtime, 'tools', 'venv', 'funasr', 'Scripts', 'python.exe');
      if (fs.existsSync(python)) {
        fs.writeFileSync(path.join(bin, 'funasr-python.cmd'), [
          '@echo off', 'chcp 65001 >nul', 'setlocal',
          `if not defined ALIGN_MODEL set "ALIGN_MODEL=${model}"`,
          'set "PYTHONUTF8=1"', 'set "PYTHONIOENCODING=utf-8"',
          `"${python}" %*`, 'exit /b %errorlevel%', '',
        ].join('\r\n'));
      }
    }
  }
  return { env, runtime, logs, npmCLI };
}

function start() {
  const { env, logs, npmCLI } = prepareLocalRuntime();
  const electron = path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(electron)) throw new Error('Dependencies are missing. Run npm ci in the project folder first.');
  const outputs = ['packages/cli/dist/onset.cjs', 'apps/desktop/out/entry.js', 'apps/desktop/out/renderer/index.html'];
  if (process.argv.includes('--rebuild') || outputs.some((file) => !fs.existsSync(path.join(projectRoot, file)))) {
    if (!fs.existsSync(npmCLI)) throw new Error('The Node.js npm runtime could not be located.');
    for (const workspace of ['@onset/cli', 'onset-desktop']) {
      const result = spawnSync(process.execPath, [npmCLI, 'run', 'build', '-w', workspace], { cwd: projectRoot, env, stdio: 'inherit', windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Build failed: ${workspace}`);
    }
  }
  const output = fs.openSync(path.join(logs, 'desktop.log'), 'a');
  const child = spawn(electron, [path.join(projectRoot, 'apps', 'desktop')], {
    cwd: projectRoot,
    env,
    detached: true,
    // This child is the interactive application, so its first window must be visible.
    windowsHide: false,
    stdio: ['ignore', output, output],
  });
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.once('spawn', () => {
    fs.closeSync(output);
    child.unref();
    console.log(`OnSet started (PID ${child.pid}). Logs: ${path.join(logs, 'desktop.log')}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { start(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
