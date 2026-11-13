/**
 * 建一个新的视频项目：am init 与客户端的「新建项目」共用这一条路。移植自 internal/projectinit。
 *
 * 两边曾经各写一份：Studio 那份漏了讲解形式（歌曲 / 卡点）、多角色对话，也不装 HyperFrames 官方技能——
 * 新建的项目渲染时拿不到 hyperframes 入口技能。放在一处，两个入口建出的项目逐字节相同。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as assets from '../assets';
import * as flow from '../flow';
import * as hyperframes from '../hyperframes';
import * as plugin from '../plugin';
import type { Style } from '../preset';
import * as project from '../project';

// 讲解形式（am init --delivery）：就是项目的流程（片型），可选值是内置流程与内置插件登记的流程（deliveryFlows）。
export const DeliverySpeech = 'speech';
export const DeliverySong = 'song';
export const DeliveryBeat = 'beat';

// 叙事模式（am init --narration）。solo 是单口播，宿主自己的缺省；其余由内置插件登记（ctx.narration），
// 选中时写出那个插件的初始文件（多角色对话是 cast.yaml 与 cast/）。
export const NarrationSolo = 'solo';

/** 一种叙事模式。owner 是登记它的内置插件；solo 没有。 */
export interface Narration {
  id: string;
  name: string;
  hint: string;
  owner: string;
}

/** 可选的叙事模式：单口播在前，其后是内置插件登记的。 */
export function narrations(): Narration[] {
  return [
    { id: NarrationSolo, name: '单口播', hint: '一个人讲到底', owner: '' },
    ...plugin.pluginNarrations().map((n) => ({ id: n.value.id, name: n.value.name, hint: n.value.hint, owner: n.owner })),
  ];
}

/** 建一个项目要的全部选择。 */
export interface Options {
  target: string;
  canvas: string;
  style: Style;
  delivery: string;
  narration: string;
  /** 调用方另外要写进项目的文件（如自定义风格描述）。 */
  extra?: Record<string, Uint8Array | string>;
}

/** 新建对话框里的一种做法：讲解形式（流程）加叙事模式。canvas、example 给首页「从模板开始」。 */
export interface Preset {
  id: string;
  label: string;
  hint: string;
  delivery: string;
  narration: string;
  canvas?: string;
  example?: string;
}

/** 宿主自己的做法：口播与（还没做成插件的）卡点。 */
const hostPresets: Preset[] = [
  { id: 'speech', label: '口播讲解', hint: '配音 + 动画，最常用', delivery: DeliverySpeech, narration: NarrationSolo },
  {
    id: 'beat',
    label: '音乐卡点',
    hint: '没有配音，画面踩着节拍切',
    delivery: DeliveryBeat,
    narration: NarrationSolo,
    canvas: 'vertical-9x16',
    example: '用一首轻快的曲子做卡点短片，每个重拍切一个画面',
  },
];

/** 新建对话框的全部做法：宿主的在前，其后是内置插件登记的（ctx.preset）。 */
export function presets(): Preset[] {
  return [...hostPresets, ...plugin.pluginPresets().map((p) => ({ ...p.value }))];
}

/** 可选的讲解形式：内置流程与内置插件登记的流程（有提示词段落顺序的），口播在前。 */
export function deliveryFlows(): flow.Flow[] {
  return flow.allFlows().filter((f) => f.prompt);
}

function fileThere(file: string): boolean {
  try {
    return !fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 检查讲解形式与叙事模式的组合，以及目标目录里已有的模式文件。谁与谁不能同时用由流程声明（Flow.excludes），
 * 这里不写死片型：先看选的流程，再看目标目录里已有标记文件的别的流程。
 */
export function validate(opts: Options): void {
  const modes = narrations();
  const mode = modes.find((n) => n.id === opts.narration);
  if (!mode) throw new Error(`无效的叙事模式：${opts.narration}（可选：${modes.map((n) => n.id).join(' ')}）`);
  const flows = deliveryFlows();
  const chosen = flows.find((f) => f.id === opts.delivery);
  if (!chosen) {
    const ids = flows.map((f) => f.id);
    throw new Error(`讲解形式必须为 ${ids.slice(0, -1).join('、')} 或 ${ids[ids.length - 1]}`);
  }
  const target = opts.target;
  // 选的叙事模式是哪个插件登记的，就算在用它；目标目录里已经在用某个内置插件（它登记的在用判断）也算。
  const pluginUsed = (id: string) => mode.owner === id || (fs.existsSync(target) && plugin.pluginInUse(id, target) !== '');
  const markerThere = (id: string) => {
    const m = flows.find((f) => f.id === id)?.marker;
    return !!m && fileThere(path.join(target, m.file));
  };
  const ex = chosen.excludes;
  if (ex && ((ex.plugins ?? []).some(pluginUsed) || (ex.flows ?? []).some(markerThere))) throw new Error(ex.message);
  // 目标目录里已有别的片型的标记文件：那个片型不许的叙事模式同样不许。
  for (const other of flows) {
    if (other.id === chosen.id || !other.excludes || !markerThere(other.id)) continue;
    if (mode.owner !== '' && (other.excludes.plugins ?? []).includes(mode.owner)) throw new Error(other.excludes.message);
  }
}

const bytes = (body: Uint8Array | string): Uint8Array => (typeof body === 'string' ? Buffer.from(body) : body);

/**
 * 写出项目文件：三棵内置资产树、风格字体、模式文件与调用方的额外文件，再由选中的叙事模式写它自己的初始文件。
 * 不装 HyperFrames 技能，见 installSkills。
 */
export function create(opts: Options): project.InitResult {
  validate(opts);
  const shared = assets.shared();
  const presetFiles = assets.preset(opts.canvas);
  const styleFiles = assets.style(opts.style.id, opts.canvas);
  const extra = new Map<string, Uint8Array>(assets.styleFonts(opts.style));
  for (const [file, body] of Object.entries(opts.extra ?? {})) extra.set(file, bytes(body));
  const chosen = deliveryFlows().find((f) => f.id === opts.delivery)!;
  if (chosen.marker) extra.set(chosen.marker.file, Buffer.from(chosen.marker.body));
  const result = project.initializeWithFiles(opts.target, extra, shared, presetFiles, styleFiles);
  recordProjectFlow(opts.target, chosen.id, opts.canvas);
  const mode = plugin.pluginNarrations().find((n) => n.value.id === opts.narration);
  if (mode) {
    try {
      mode.value.init(opts.target);
    } catch (err) {
      throw new Error(`项目文件已写入，但写出「${mode.value.name}」的初始文件失败：${(err as Error).message}`, { cause: err });
    }
  }
  return result;
}

/**
 * 在锁文件里记下项目的流程、提示词组合版本、画幅与那份可选制作说明的摘要（flow.FlowRecord）。
 * 有了它，制作提示词由运行期按流程组合；那份文件之后被用户改了，就以文件为准。
 */
export function recordProjectFlow(target: string, id: string, canvas: string): void {
  const file = project.flowPromptFile(target, { id, compose: flow.ComposeVersion, canvas, prompt_sha256: '' });
  let digest = '';
  try {
    digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    digest = '';
  }
  flow.recordFlow(target, { id, compose: flow.ComposeVersion, canvas, prompt_sha256: digest });
}

/**
 * 把固定版本的 HyperFrames 官方技能从本机缓存拷进项目的 .agents/skills/，与内置技能重名的保留内置版本。
 * 不联网：技能是前置资源，由 am setup 下载进缓存；缓存里没有时抛 prereq.MissingError。
 */
export function installSkills(
  target: string,
  env: Record<string, string>,
  output?: hyperframes.Writer,
  progress?: (p: hyperframes.Progress) => void,
  signal?: AbortSignal,
): Promise<hyperframes.Result> {
  return hyperframes.install(
    {
      projectDir: target,
      version: hyperframes.PinnedVersion,
      env,
      protectedSkills: assets.builtinSkills(),
      output,
      progress,
      cacheDir: hyperframes.defaultCacheDir(env),
      cacheOnly: true,
    },
    signal,
  );
}

/** 项目里装过 HyperFrames 官方技能（有来源记录）。 */
export function skillsInstalled(target: string): boolean {
  return fs.existsSync(path.join(target, hyperframes.SkillsSubdir, hyperframes.ManifestFile));
}
