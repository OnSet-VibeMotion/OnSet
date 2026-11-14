/**
 * 前置资源清单：要联网准备的每一项、怎么判断就绪、怎么准备。
 *
 * onset setup（下载）与客户端的引导（只读状态）共用这一份清单，两边说的永远是同一组东西。
 * 判断就绪不联网；准备只由 onset setup 调用。错误类型与文案约定见 ../prereq。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import { AlignAuto, Aligners, defaultTTSProvider, resolveAligner, TTSProviders, validAligner, validTTSProvider } from '../config/providers';
import { envMap } from '../envutil';
import type { ModelSpec, ToolSpec } from '../toolinstall';
import type * as filmstyle from '../filmstyle';
import * as plugin from '../plugin';
import * as hyperframes from '../hyperframes';
import * as toolinstall from '../toolinstall';
import {ensureWindowsGraphics,windowsGraphicsStatus} from '../windowsruntime/graphics';

/** 一次准备要用的环境与输出：git 走代理、npm 走自己的配置；工具的原始输出写进 log，stage 汇报进行到哪一步。 */
export interface Run {
  base: Record<string, string>;
  git: Record<string, string>;
  npm: Record<string, string>;
  mixed: Record<string, string>;
  /** onset setup --proxy 的值（可能为空）。只给明确要走代理的下载用，例如节拍模型权重。 */
  proxy?: string;
  log: hyperframes.Writer;
  /** 这一步在做什么；bytes 是没有可量进度时这一步落到磁盘的字节数（Progress.bytes）。 */
  stage: (text: string, bytes?: number) => void;
}

/** git / npm 等的原始输出日志：<数据目录>/onset/setup.log，每次准备覆盖。onset setup 与客户端的安装页共用。 */
export function logPath(env: Record<string, string>): string {
  return path.join(path.dirname(hyperframes.defaultCacheDir(env)), 'setup.log');
}

/**
 * 一次准备的环境。git 的代理用 GIT_CONFIG_PARAMETERS（等同 git -c http.proxy=…）只给 git：
 * 设成 HTTPS_PROXY 的话 npm 也会走它，国内镜像经代理反而连不上（实测）。要走代理的其他下载各自用 withProxy。
 */
export function newRun(env: Record<string, string>, proxy: string, npmRegistry: string, log: hyperframes.Writer): Run {
  const git = { ...env };
  const npm = { ...env };
  if (proxy !== '') git.GIT_CONFIG_PARAMETERS = `'http.proxy'='${proxy}'`;
  if (npmRegistry !== '') npm.npm_config_registry = npmRegistry;
  const mixed = { ...git };
  if (npmRegistry !== '') mixed.npm_config_registry = npmRegistry;
  return { base: env, git, npm, mixed, proxy, log, stage: () => {} };
}

/** 一项前置资源。 */
export interface Item {
  /** --only 认的大类（skills、cli、styles）。 */
  group: string;
  /** 这一项自己的名字；风格来源每个一项，ID 为 styles:<来源>。 */
  id: string;
  /** 与 version 分两列显示。 */
  name: string;
  version: string;
  /** 做片必需（技能与 CLI）；整片风格来源只有选了风格才要。 */
  required: boolean;
  /** 不联网地判断是否已就绪；where 是给人看的位置。 */
  ready: (env: Record<string, string>) => [ok: boolean, where: string];
  prepare: (run: Run, signal?: AbortSignal) => Promise<void>;
  /** 内置插件登记的项：客户端安装页「以后可能用到」里的那一组（见 plugin.PluginPrereq）。 */
  later?: { title: string; desc: string; icon?: string };
}

/**
 * 走 --proxy 的下载（GitHub release、Google 存储上的浏览器）用的环境：curl 与 HyperFrames 都认 https_proxy。
 * npm 与 pip 不给代理（它们用用户自己配置的国内镜像，经代理反而连不上，实测）。
 */
export function withProxy(run: Run, base: Record<string, string> = run.base): Record<string, string> {
  const env = { ...base };
  if (run.proxy) env.HTTPS_PROXY = env.https_proxy = run.proxy;
  return env;
}

/** 把 HyperFrames 的进度译成一行说明。 */
export function hyperframesStage(p: hyperframes.Progress): string {
  if (p.indeterminate || p.percent <= 0 || p.percent >= 100) return p.stage;
  return `${p.stage} ${Math.trunc(p.percent)}%`;
}

/** 要准备哪一家配音与对齐工具：按项目配置（不在项目里时按环境变量与缺省值）。 */
export interface Selection {
  tts: string;
  align: string;
}

/**
 * 当前该准备的配音与对齐工具。root 是项目目录时读项目配置（onset.conf、.env、环境变量），
 * 读不了或不在项目里时取环境变量 TTS_PROVIDER / ALIGN_PROVIDER，其次全局设置，再不然用缺省值（配音与对齐都按平台选）。
 */
export function selection(env: Record<string, string>, root = ''): Selection {
  if (root !== '' && fs.existsSync(path.join(root, 'onset.conf'))) {
    try {
      const cfg = config.load(root, env);
      return { tts: cfg.ttsProvider, align: cfg.alignProvider };
    } catch {
      // 配置写错了：退回缺省，错误留给 onset config / onset run 去报。
    }
  }
  // 没有项目时：环境变量，其次客户端设置页的全局设置，再不然内置默认（Apple Silicon 上是本机 Breeze）。
  let global: Record<string, string> = {};
  try {
    const file = config.settingsFile(env);
    if (file !== '') global = config.parseConfFile(file);
  } catch {
    // 全局设置读不了：当作没有。
  }
  const pick = (key: string) => [env[key], global[key]].find((v) => v !== undefined && v !== '') ?? '';
  const ttsValue = pick('TTS_PROVIDER');
  const alignValue = pick('ALIGN_PROVIDER');
  const tts = validTTSProvider(ttsValue) ? ttsValue : defaultTTSProvider();
  const align = resolveAligner(validAligner(alignValue) ? alignValue : AlignAuto, process.platform, process.arch);
  return { tts, align };
}

/** 配音或对齐工具的一项：装进 onset 自己的目录，不碰全局；版本钉死。有 model 时连模型一起下好。 */
function toolItem(group: 'tts' | 'align' | 'voice', id: string, label: string, spec: ToolSpec, model?: ModelSpec): Item {
  const version = spec.kind === 'uv-venv' ? '' : spec.version;
  return {
    group,
    id: `${group}:${id}`,
    // 卡点项目不配音，口播项目到第三阶段才用：不挡「开始制作」，但引导里照样列出来。
    required: false,
    name: label,
    version,
    ready: (env) => {
      const status = toolinstall.toolStatus(spec, env);
      if (status.ok && model && !toolinstall.modelReady(model, env)) return [false, toolinstall.modelDir(model, env)];
      return [status.ok, status.where];
    },
    prepare: async (run, signal) => {
      // npm 包用用户自己的 ~/.npmrc，不套代理；Python 类工具要从 GitHub 下 Python，--proxy 给它。
      const env = spec.kind === 'npm' ? run.npm : withProxy(run);
      const progress = (p: hyperframes.Progress) => run.stage(hyperframesStage(p), p.bytes);
      await toolinstall.ensureTool(spec, { env, output: run.log, progress, signal });
      if (model) await toolinstall.ensureModel(model, { env: withProxy(run), output: run.log, progress, signal });
    },
  };
}

/** 全部前置资源，顺序即准备顺序。pick 决定列哪一家配音与对齐工具（缺省按 selection 的规则）。 */
export function items(pick?: Selection): Item[] {
  const chosen = pick ?? selection(envMap());
  const version = hyperframes.PinnedVersion;
  const out: Item[] = [
    {
      group: 'skills',
      id: 'skills',
      required: true,
      name: 'HyperFrames 技能',
      version,
      ready: (env) => {
        const dir = hyperframes.defaultCacheDir(env);
        return [hyperframes.skillsReady(dir), dir];
      },
      prepare: (run, signal) =>
        hyperframes.prepareSkills(
          { env: run.git, cacheDir: hyperframes.defaultCacheDir(run.base), output: run.log, progress: (p) => run.stage(hyperframesStage(p), p.bytes) },
          signal,
        ),
    },
    {
      group: 'cli',
      id: 'cli',
      required: true,
      name: 'HyperFrames CLI',
      version,
      ready: (env) => {
        const dir = hyperframes.cliDir(env, hyperframes.PinnedVersion);
        return [hyperframes.cliReady(dir, hyperframes.PinnedVersion), dir];
      },
      prepare: async (run, signal) => {
        await hyperframes.ensureCLI({ env: run.npm, output: run.log, progress: (p) => run.stage(hyperframesStage(p), p.bytes) }, signal);
      },
    },
    {
      group: 'browser',
      id: 'browser',
      // 客户端里用它自带的 Chromium（ONSET_BROWSER），这一项直接就绪；单独用命令行时才要下载 headless-shell。
      required: true,
      name: '渲染用浏览器',
      version: '',
      ready: (env) => {
        const status = hyperframes.browserStatus(env);
        return [status.ok, status.where];
      },
      prepare: async (run, signal) => {
        // 浏览器从 Google 的存储下载，国内要走代理；--proxy 只给这种明确要出境的下载。
        await hyperframes.ensureBrowser({ env: withProxy(run, run.npm), output: run.log, progress: (p) => run.stage(hyperframesStage(p), p.bytes) }, signal);
      },
    },
    {
      group: 'ffmpeg',
      id: 'ffmpeg',
      // 系统里已有 ffmpeg 与 ffprobe（PATH 能找到）就直接就绪；没有时下载固定版本的静态构建，不要求装 Homebrew。
      required: true,
      name: 'ffmpeg / ffprobe',
      version: '',
      ready: (env) => {
        const status = toolinstall.ffmpegStatus(env);
        return [status.ok, status.where];
      },
      prepare: async (run, signal) => {
        await toolinstall.ensureFFmpeg({ env: withProxy(run), output: run.log, progress: (p) => run.stage(hyperframesStage(p), p.bytes), signal });
      },
    },
  ];
  // 内置插件登记的前置资源（例如卡点的节拍分析环境）。
  for (const { value } of plugin.pluginPrereqs()) out.push(value);
  const tts = TTSProviders.find((p) => p.id === chosen.tts);
  if (tts) out.push(toolItem('tts', tts.id, '配音 ' + tts.name, tts.install, tts.model));
  // 音色页的「按描述设计」用本机的 Breeze，与项目选的配音工具无关；项目配音本来就是 Breeze 时上面那一项就是它。
  const breeze = TTSProviders.find((p) => p.id === 'breeze');
  if (breeze && chosen.tts !== 'breeze') out.push(toolItem('voice', breeze.id, '音色设计 ' + breeze.name, breeze.install, breeze.model));
  const aligner = Aligners.find((a) => a.id === chosen.align);
  if (aligner) out.push(toolItem('align', aligner.id, '对齐 ' + aligner.name, aligner.install, aligner.model));
  if(process.platform==='win32')out.push({
    group:'python',id:'python:graphics',name:'图像与字体辅助库',version:'',required:false,
    later:{title:'图像与字体辅助库',desc:'Windows 镜头图像检查、截图分析与字体校验',icon:'styles'},
    ready:env=>{const status=windowsGraphicsStatus(env);return [status.ok,status.where];},
    prepare:async(run,signal)=>{await ensureWindowsGraphics({env:run.npm,output:run.log,progress:p=>run.stage(hyperframesStage(p),p.bytes),signal});},
  });
  return out;
}

/**
 * 一个整片风格来源的数据（来源 id 为 styles:<来源>）：登记风格来源的内置插件拿它登记前置资源（ctx.prereq）。
 * 第三方插件带来的风格库随插件下来，不是前置资源。
 */
export function filmStyleSourceItem(source: filmstyle.Source): Item {
  return {
    group: 'styles',
    id: 'styles:' + source.id(),
    name: '整片风格 ' + source.id(),
    version: '',
    required: false,
    ready: (env) => {
      let ok = true;
      try {
        source.check(env);
      } catch {
        ok = false;
      }
      return [ok, source.location(env)];
    },
    // 来源可能既用 git 又用 npm：git 的代理与 npm 的源合在一份环境里。
    prepare: (run, signal) => source.prepare({ env: run.mixed, output: run.log, progress: (p) => run.stage(`(${p.step}/${p.steps}) ${p.stage}`) }, signal),
  };
}

/** 一项的就绪状态（给客户端与 --check 用）。字段顺序与 Go 的 JSON tag 一致。 */
export interface Status {
  id: string;
  group: string;
  name: string;
  version?: string;
  required: boolean;
  ready: boolean;
  location: string;
  later?: { title: string; desc: string; icon?: string };
}

/** 不联网地返回全部项的状态。 */
export function check(env: Record<string, string>, pick?: Selection): Status[] {
  return items(pick ?? selection(env)).map((item) => {
    const [ok, where] = item.ready(env);
    return { id: item.id, group: item.group, name: item.name, version: item.version || undefined, required: item.required, ready: ok, location: where, later: item.later };
  });
}
