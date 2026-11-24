import path from 'node:path';
import { dataDir, envMap, WindowsBaseEnvKeys } from '../envutil';
import { RootEnv } from '../filmstyle';
import { BrowserAppArgEnv, BrowserEnv, BrowserHookEnv, CLIDirEnv, HyperFramesBrowserEnv } from '../hyperframes';
import { DirEnv as SeriesDirEnv } from '../series/dir';
import { childEnvKeys as toolpathEnvKeys } from '../toolpath';
import { DirEnv as VoicesDirEnv } from '../voice/dir';
import { SettingsFileEnv } from './global';
import { type Config, formatFloatShortest } from './types';

/**
 * 子进程（编排工具、渲染器）的环境。对应 Go 的 Config.ChildEnvironment。
 * base 不给（或为 null）时用当前进程环境；unsafe 为 false 时只透传白名单与 passthrough 里的变量。
 */
export function childEnvironment(
  config: Config,
  base?: Record<string, string> | null,
  unsafe = false,
  passthrough: string[] = [],
): Record<string, string> {
  const source = base ?? envMap();
  const out: Record<string, string> = {};
  if (unsafe) {
    Object.assign(out, source);
  } else {
    // USER / LOGNAME / SHELL 不是凭据，但工具链要靠它们确定身份：
    // macOS 上 claude CLI 缺 USER 就读不到 Keychain 里的登录态，
    // 报的却是「Not logged in」，与权限隔离毫无关联，极难排查。
    //
    // CODEX_HOME 同理不是凭据，而是 Codex 的数据目录：用户改过它时，缺了这个
    // 变量 Codex 回到 ~/.codex 找登录态，报未登录；内置生图的产物也落到
    // 那里，自定义风格的定风格阶段拿不到氛围参照图。
    const allowed = [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'SHELL',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'CODEX_HOME',
      // Windows 的系统变量（缺了 SystemRoot 等子进程直接出错，见 envutil.WindowsBaseEnvKeys）；别的系统上没有它们。
      ...WindowsBaseEnvKeys,
      ...passthrough,
    ];
    for (const key of allowed) {
      if (Object.hasOwn(source, key)) out[key] = source[key]!;
    }
  }
  Object.assign(out, config.overlay);
  out.ORCHESTRATOR = config.orchestrator;
  out.RENDERER = config.renderer;
  // 模型与工具一起写进去（空就删掉 .env 里带进来的旧值）：子进程按 load 的规则，环境里只有工具、
  // 没有模型时不会捡起项目配置里给别的工具写的模型。编排工具调用的 onset scene run 因此用会话选的渲染模型。
  for (const [key, value] of [
    ['ORCHESTRATOR_MODEL', config.orchestratorModel],
    ['RENDERER_MODEL', config.rendererModel],
    ['ORCHESTRATOR_OPTIONS', config.orchestratorOptions],
    ['RENDERER_OPTIONS', config.rendererOptions],
  ] as const) {
    if (value !== '') out[key] = value;
    else delete out[key];
  }
  // 优化工具同理：执行进程里的 scene_prompt_check 按同一份取值（空是跟随上面的编排工具）。
  for (const [key, value] of [
    ['OPTIMIZER', config.optimizer],
    ['OPTIMIZER_MODEL', config.optimizerModel],
    ['OPTIMIZER_OPTIONS', config.optimizerOptions],
  ] as const) {
    if (value !== '') out[key] = value;
    else delete out[key];
  }
  out.TTS_PROVIDER = config.ttsProvider;
  if (config.alignProvider !== '') out.ALIGN_PROVIDER = config.alignProvider;
  // 记忆设置与 ORCHESTRATOR 一样显式写进去：编排工具调用的 onset memory remember、
  // onset scene run 必须用同一个记忆库。安全模式的白名单里没有 ONSET_MEMORY_DIR，
  // 不写的话子进程回落到默认目录——既不是这一个库，也不在 codex 沙箱放行的范围里
  // （实测：偏好写入被拒，报「没有写入权限」）。
  if (config.memory.dir !== '') {
    out.ONSET_MEMORY_DIR = config.memory.dir;
    out.MEMORY = config.memory.enabled ? 'on' : 'off';
    out.MEMORY_RECALL_BUDGET = String(config.memory.recallBudget);
    out.MEMORY_EXPLORE = formatFloatShortest(config.memory.explore);
    if (config.memory.snapshot > 0) out.MEMORY_SNAPSHOT = String(config.memory.snapshot);
  }
  // 风格来源的数据目录同理显式写进去：默认根目录由 XDG_DATA_HOME 推出，而它不在白名单里，
  // 编排工具调用的 onset film-style 会算出另一个目录，找不到 onset setup 准备好的数据。
  // 各来源自己的覆盖变量由登记来源的内置插件经 ctx.childEnv 登记，随下面的 pluginEnv 一起写。
  if (config.filmStyleRoot !== '') out[RootEnv] = config.filmStyleRoot;
  // CLI 目录同理：子进程里的 onset hyperframes 要找到同一份已装好的 CLI，否则会按 HOME
  // 另算一个目录，在渲染途中重新 npm install。
  if (config.hyperFramesCLI !== '') out[CLIDirEnv] = config.hyperFramesCLI;
  // 内置插件登记的变量同理（例如卡点的节拍分析环境：编排工具调用的 beat_analyze 要找到 onset setup 装好的那一套，
  // 找不到就会想自己去建）。
  Object.assign(out, config.pluginEnv);
  // 音色库同理：编排工具调用的 voice_save、voice_get 与客户端的音色页要是同一个库，
  // 默认目录由 XDG_DATA_HOME 推出而它不在白名单里。
  if (config.voicesDir !== '') out[VoicesDirEnv] = config.voicesDir;
  // 专栏库同理：编排工具调用的 series_* 操作与客户端的专栏页要是同一个库。
  if (config.seriesDir !== '') out[SeriesDirEnv] = config.seriesDir;
  // 第三方站的存放目录同理：客户端的写任务（station_run）要找到设置页加进来的同一份站。只在子进程会算出
  // 另一个目录时写（显式指定了，或默认目录由不在白名单里的 XDG_DATA_HOME 推出）。
  // 名字与默认值同 flow.StationsDirEnv / flow.stationsDir；这里不 import flow，免得配置包依赖流程包。
  if (source.ONSET_STATIONS_DIR) out.ONSET_STATIONS_DIR = source.ONSET_STATIONS_DIR;
  else if (source.XDG_DATA_HOME && !unsafe) out.ONSET_STATIONS_DIR = path.join(dataDir(source), 'stations');
  // 全局设置同理：子进程（编排工具调用的 onset、渲染）按同一份全局设置解析项目配置。
  if (config.settingsFile !== '') out[SettingsFileEnv] = config.settingsFile;
  if (source.ONSET_STUDIO_OP_PIPE) out.ONSET_STUDIO_OP_PIPE = source.ONSET_STUDIO_OP_PIPE;
  // 客户端自带的浏览器与用户显式指定的浏览器同理：子进程里的 onset hyperframes 照样用它们，不去下载 headless-shell。
  for (const key of [BrowserEnv, HyperFramesBrowserEnv, BrowserHookEnv, BrowserAppArgEnv])
    if (source[key]) out[key] = source[key]!;
  // 客户端自带的 npm、工具目录与 onset setup 的工具目录同理：子进程里的 onset 要找到同一套，而白名单里没有它们。
  for (const key of toolpathEnvKeys) if (source[key]) out[key] = source[key]!;
  if (unsafe) out.ONSET_UNSAFE = '1';
  return out;
}
