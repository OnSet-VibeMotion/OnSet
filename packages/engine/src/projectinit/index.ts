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
import * as cast from '../cast';
import * as flow from '../flow';
import { atomicWrite } from '../fsutil';
import { formatG, goPathError } from '../gofmt';
import * as hyperframes from '../hyperframes';
import type { Style } from '../preset';
import * as project from '../project';

// 讲解形式（am init --delivery）：就是项目的流程（片型），可选值是内置流程与内置插件登记的流程（deliveryFlows）。
export const DeliverySpeech = 'speech';
export const DeliverySong = 'song';
export const DeliveryBeat = 'beat';

// 叙事模式（am init --narration）。solo 是单口播；cast 是多角色对话，额外写出 cast.yaml 与 cast/。
export const NarrationSolo = 'solo';
export const NarrationCast = 'cast';

/** 新建 cast.yaml 时写入的默认班底参数，am cast add 新建 cast.yaml 时用同一组值。 */
export const CastDefaultGroundY = 0.78;
export const CastDefaultGapMs = { turn: 240, interject: 100 };

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
  if (opts.narration !== NarrationSolo && opts.narration !== NarrationCast) {
    throw new Error(`无效的叙事模式：${opts.narration}（可选：${NarrationSolo} ${NarrationCast}）`);
  }
  const flows = deliveryFlows();
  const chosen = flows.find((f) => f.id === opts.delivery);
  if (!chosen) {
    const ids = flows.map((f) => f.id);
    throw new Error(`讲解形式必须为 ${ids.slice(0, -1).join('、')} 或 ${ids[ids.length - 1]}`);
  }
  const target = opts.target;
  // 叙事模式 cast 就是多角色对话插件；项目里已有某个内置插件的 in_use 文件也算在用它。
  const pluginUsed = (id: string) =>
    (id === NarrationCast && opts.narration === NarrationCast) || (flow.builtinPlugins().find((p) => p.manifest.id === id)?.manifest.in_use ?? []).some((rel) => fileThere(path.join(target, rel)));
  const markerThere = (id: string) => {
    const m = flows.find((f) => f.id === id)?.marker;
    return !!m && fileThere(path.join(target, m.file));
  };
  const ex = chosen.excludes;
  if (ex && ((ex.plugins ?? []).some(pluginUsed) || (ex.flows ?? []).some(markerThere))) throw new Error(ex.message);
  // 目标目录里已有别的片型的标记文件：那个片型不许的叙事模式同样不许。
  for (const other of flows) {
    if (other.id === chosen.id || !other.excludes || !markerThere(other.id)) continue;
    if (opts.narration === NarrationCast && (other.excludes.plugins ?? []).includes(NarrationCast)) throw new Error(other.excludes.message);
  }
}

const bytes = (body: Uint8Array | string): Uint8Array => (typeof body === 'string' ? Buffer.from(body) : body);

/**
 * 写出项目文件：三棵内置资产树、风格字体、模式文件与调用方的额外文件，多角色对话再写 cast.yaml 与 cast/。
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
  if (opts.narration === NarrationCast) {
    try {
      writeCastScaffold(opts.target);
    } catch (err) {
      throw new Error(`项目文件已写入，但写出 ${cast.RosterFile} 失败：${(err as Error).message}`, { cause: err });
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

/**
 * 新建项目的 cast.yaml。Go 版走 cast.Roster + yaml.Marshal；这份结构是固定的，这里直接写出 yaml.v3 的
 * 输出（4 空格缩进、空 packs 写成 []），与 Go 版逐字节相同。
 */
export function castYAML(): string {
  return (
    `schema: ${cast.SchemaVersion}\n` +
    'packs: []\n' +
    'defaults:\n' +
    `    ground_y: ${formatG(CastDefaultGroundY)}\n` +
    '    gap_ms:\n' +
    `        turn: ${CastDefaultGapMs.turn}\n` +
    `        interject: ${CastDefaultGapMs.interject}\n`
  );
}

/**
 * 在 target 下写出 cast.yaml 并建出空的 cast/ 目录。packs 刻意留空：刚建出的项目本来就还没有引入任何角色包。
 * 与 project.initialize 的幂等语义一致：cast.yaml 已存在且内容相同就跳过，内容不同就报错，不静默覆盖。
 */
export function writeCastScaffold(target: string): void {
  try {
    fs.mkdirSync(path.join(target, 'cast'), { recursive: true, mode: 0o755 });
  } catch (err) {
    throw new Error(`创建 ${cast.RosterFile} 目录失败：${goPathError('mkdir', path.join(target, 'cast'), err)}`);
  }
  const rosterPath = path.join(target, cast.RosterFile);
  const body = castYAML();
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(rosterPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`检查 ${rosterPath} 失败：${goPathError('open', rosterPath, err)}`);
  }
  if (existing !== undefined) {
    if (existing !== body) throw new Error(`目标文件已存在且内容不同：${rosterPath}`);
    return;
  }
  try {
    atomicWrite(rosterPath, body, 0o644);
  } catch (err) {
    throw new Error(`写入 ${rosterPath} 失败：${(err as Error).message}`);
  }
}
