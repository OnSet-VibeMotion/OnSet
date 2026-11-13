/**
 * cast 一组操作（new / add / validate / preview）与 dialogue 一组操作（assemble / beats）。
 * 移植自 internal/cli/cast.go。
 *
 * internal/cast 包只定义角色包格式与校验规则，不碰文件系统之外的东西
 * （怎么落地、怎么登记进项目班底）。这里是唯一把它接到操作表上的地方。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as cast from '@am/engine/cast';
import * as castbeats from '@am/engine/castbeats';
import * as config from '@am/engine/config';
import * as dialogue from '@am/engine/dialogue';
import { atomicWrite } from '@am/engine/fsutil';
import { formatFixed, formatG, goPathError, goQuote } from '@am/engine/gofmt';
import { compareBytes } from '@am/engine/gojson';
import * as projectinit from '@am/engine/projectinit';
import { type Out } from './cobra';
import { defineGroup } from './ops/cli';
import { num, str, strs } from './ops/common';
import { defineOp, type OpResult } from './ops/op';

// castDefaultGroundY、castDefaultGapMs 是新建 cast.yaml 时写入的默认班底参数。
const castDefaultGroundY = projectinit.CastDefaultGroundY;
const castDefaultGapMs = projectinit.CastDefaultGapMs;

defineGroup({
  path: ['cast'],
  summary: '角色包相关操作',
  description: `管理角色包（character pack）：生成骨架、引入外部包、校验、生成预览图。

角色包是 cast/<id>/ 下的一个目录，至少包含 character.yaml（清单）与
rig.svg（骨架图）。项目根的 cast.yaml 登记了哪些角色包属于本项目的班底，
它存在与否就是叙事模式本身。

每次 cast_new / cast_add / cast_validate 成功后都会在角色包目录里重新生成 character.json：
它是 character.yaml 的等价 JSON，供驱动库 cast.js 在无头 Chrome 里用
JSON.parse 读取——渲染机的 CSP 环境下引不进 YAML 解析库。character.yaml
仍是人工编辑的唯一真相源，character.json 只是产物，不要手改。

⚠️ 手改 character.yaml 后不会自动同步：character.json 只在 cast_new / cast_add /
cast_validate 成功时重新生成，am 不会比较两者的修改时间。手改完 yaml 却忘记调一次
cast_validate()，渲染机读到的仍是旧 json——不会报错、不会警告，成片里角色
的音色、姿势、关节范围仍是改动前的值，问题只会在肉眼比对渲染结果时才会
发现。改完 character.yaml，一律先调 cast_validate() 再渲染。`,
});

defineOp({
  name: 'cast_new',
  cli: ['cast', 'new'],
  summary: '生成一个可自洽的角色包骨架',
  description: `在 cast/<id>/ 下写出 character.yaml、rig.svg、dna.md 三件套骨架，
并把 cast/<id> 登记进项目根的 cast.yaml（不存在则按约定默认值新建）。

骨架里的 voiceId 留空：真实音色由人工在 character.yaml 里补上，dna.md 会
提示这一点。写完立即用 cast.Load 自检，一旦不自洽就删除已写文件并报错——
不会在项目里留下半成品。自检通过后额外写出 character.json（见 cast 一组的说明）。

目标目录已存在且非空时拒绝执行，不会覆盖已有内容。`,
  examples: ['cast_new({"id": "heiwa"})'],
  params: { id: { type: 'string', description: '角色 id，角色包写到 cast/<id>/', required: true, positional: 0 } },
  run: (p, { out }) => {
    const dir = runCastNew(out, str(p.id));
    return { data: { dir } };
  },
});

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * cleanupAndFail 在失败路径上删除 dir 并返回 cause；删除本身失败时把两个
 * 错误一起报出来，而不是吞掉——静默吞掉清理失败会在项目里留下残骸
 * （半成品角色包）且完全没有提示。
 */
function cleanupAndFail(dir: string, cause: Error): Error {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (removeErr) {
    return new Error(`${cause.message}；此外回滚清理 ${dir} 也失败，需要手动删除：${errText(removeErr)}`, { cause });
  }
  return cause;
}

function runCastNew(stdout: Out, id: string): string {
  const dir = path.join('cast', id);
  let entries: string[] | null = null;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = null;
  }
  if (entries !== null && entries.length > 0) throw new Error(`角色包目录已存在且非空：${dir}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw new Error(`创建角色包目录失败：${goPathError('mkdir', dir, err)}`, { cause: err });
  }
  const files: [string, string][] = [
    ['character.yaml', castSkeletonYAML(id)],
    ['rig.svg', castSkeletonSVG],
    ['dna.md', castSkeletonDNA(id)],
  ];
  for (const [name, body] of files) {
    const file = path.join(dir, name);
    try {
      fs.writeFileSync(file, body, { mode: 0o644 });
    } catch (err) {
      throw cleanupAndFail(dir, new Error(`写入 ${name} 失败：${goPathError('open', file, err)}`));
    }
  }
  let pack: cast.Pack;
  try {
    pack = cast.load(dir);
  } catch (err) {
    throw cleanupAndFail(dir, new Error(`生成的骨架未通过自检，已回滚：${errText(err)}`));
  }
  try {
    cast.writePackJSON(pack, dir);
  } catch (err) {
    throw cleanupAndFail(dir, err as Error);
  }
  // new 必须自己登记进班底：它硬编码写到 cast/<id>/，而 add 见到目标目录
  // 已存在就拒绝，两条命令对 cast/ 的假设互斥——不在这里登记，new 出来的
  // 角色包就没有任何命令能进班底，只能手改 cast.yaml，否则
  // am validate cast 一直报"班底为空"。registerCastPack 是幂等的。
  try {
    registerCastPack('.', dir.split(path.sep).join('/'));
  } catch (err) {
    throw cleanupAndFail(dir, new Error(`更新 ${cast.RosterFile} 失败：${errText(err)}`));
  }
  stdout.write(`角色包骨架已生成：${dir}，并已登记进 ${cast.RosterFile}\n`);
  stdout.write('请在 character.yaml 里填入真实 voiceId、summary，并按需要调整 rig.svg 后再交付。\n');
  return dir;
}

/**
 * castSkeletonYAML 是 cast_new 写出的最小可自洽 character.yaml。
 * 关节、viewBox、baselineY 都要与 castSkeletonSVG 严丝合缝，否则骨架自己都
 * 过不了 cast.Load 的自检。
 */
function castSkeletonYAML(id: string): string {
  return `schema: ${cast.SchemaVersion}
id: ${id}
name: ${id}
summary: "TODO：一句话概括这个角色的核心行为"
voice:
  minimax: { voiceId: "", speed: 1.0 }
  bailian: { voiceId: "", rate: 1.0 }
rig:
  file: rig.svg
  viewBox: [0, 0, 400, 520]
  baselineY: 512
  joints:
    head:     { pivot: [200, 168], rotate: [-18, 18] }
    frontLeg: { pivot: [176, 330], rotate: [-40, 55] }
scale:
  heightRatio: [0.22, 0.32]
poses:
  idle: {}
  pointing: { frontLeg: 48, head: -6 }
`;
}

/** 与 castSkeletonYAML 的 rig 声明配套的最小占位骨架图：两个 j- 分组，viewBox 与 joints 都对得上。 */
const castSkeletonSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 520">
  <g id="j-head"><circle cx="200" cy="168" r="60" fill="#fff" stroke="#000" stroke-width="6"/></g>
  <g id="j-frontLeg"><path d="M176 330 L176 420" stroke="#000" stroke-width="6"/></g>
</svg>
`;

function castSkeletonDNA(id: string): string {
  return `# ${id} 角色 DNA

（角色设定草稿，供音色与台词编写参考；不影响 cast.Load 的校验结果。）

## 待办

- [ ] 在 character.yaml 的 voice 里填入真实 voiceId 后才能实际用于配音
      （骨架里留空只是为了让 cast_new 能自洽生成，不会被 validate 拦下，
      但没有真实 voiceId 就没法真正合成语音）
- [ ] 补全 summary、外观与性格描述
- [ ] 按需要替换 rig.svg 里的占位图形，并同步 character.yaml 的关节声明
`;
}

defineOp({
  name: 'cast_add',
  cli: ['cast', 'add'],
  summary: '引入一个外部角色包',
  description: `校验 dir 是一个自洽的角色包后，把它拷贝进 cast/<id>/ 并登记进
项目根的 cast.yaml。

先校验后拷贝，不是拷贝后回滚：dir 校验不通过时，项目里不会留下任何
新文件。拷贝会拒绝源目录里出现的任何符号链接——理由与新建项目时拒绝模板里的
符号链接一样：链接可能指向项目外，拷进项目后会被当成普通文件静默读取，是
一个隐蔽的路径逃逸口子。

cast.yaml 不存在时会新建，defaults 取 ground_y: 0.78、
gap_ms: {turn: 240, interject: 100}；已存在则在其 packs 列表里追加一条，
已登记过的角色包不会重复追加。

成功后会在 cast/<id>/ 里写出 character.json（见 cast 一组的说明）。`,
  examples: ['cast_add({"dir": "../shared-characters/heiwa"})'],
  params: { dir: { type: 'string', description: '外部角色包目录', required: true, positional: 0 } },
  run: (p, { out }) => {
    const dest = runCastAdd(out, str(p.dir));
    return { data: { dir: dest } };
  },
});

function runCastAdd(stdout: Out, source: string): string {
  let pack: cast.Pack;
  try {
    pack = cast.load(source);
  } catch (err) {
    throw new Error(`角色包校验未通过，未做任何改动：${errText(err)}`, { cause: err });
  }
  const dest = path.join('cast', pack.id);
  if (fs.existsSync(dest)) throw new Error(`角色 ${pack.id} 已存在于 ${dest}，请先移除或换一个 id`);
  try {
    copyTree(source, dest);
  } catch (err) {
    throw cleanupAndFail(dest, new Error(`拷贝角色包失败：${errText(err)}`));
  }
  let copied: cast.Pack;
  try {
    copied = cast.load(dest);
  } catch (err) {
    throw cleanupAndFail(dest, new Error(`拷贝后的角色包无法通过自检：${errText(err)}`));
  }
  try {
    cast.writePackJSON(copied, dest);
  } catch (err) {
    throw cleanupAndFail(dest, err as Error);
  }
  try {
    registerCastPack('.', dest.split(path.sep).join('/'));
  } catch (err) {
    throw cleanupAndFail(dest, new Error(`更新 ${cast.RosterFile} 失败：${errText(err)}`));
  }
  stdout.write(`角色包已引入：${dest}（id=${pack.id}），并已登记进 ${cast.RosterFile}\n`);
  return dest;
}

/**
 * copyTree 把 src 整棵目录树拷贝到 dst，拒绝源目录里出现的任何符号链接。
 *
 * 与 internal/project.rejectSymlinkPath 同样的理由：符号链接可能指向项目外，
 * 拷贝进项目后会被当作普通文件静默读取，是一个隐蔽的路径逃逸口子。
 * 按 filepath.WalkDir 的词法顺序遍历，对符号链接本身用 lstat，不跟随。
 */
export function copyTree(src: string, dst: string): void {
  const visit = (p: string, rel: string) => {
    let info: fs.Stats;
    try {
      info = fs.lstatSync(p);
    } catch (err) {
      throw new Error(`读取 ${p} 失败：${goPathError('lstat', p, err)}`, { cause: err });
    }
    if (info.isSymbolicLink()) throw new Error(`源目录包含符号链接，拒绝拷贝：${p}`);
    const target = rel === '' ? dst : path.join(dst, rel);
    if (info.isDirectory()) {
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
      const names = fs.readdirSync(p).sort(compareBytes);
      for (const name of names) visit(path.join(p, name), rel === '' ? name : path.join(rel, name));
      return;
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(p);
    } catch (err) {
      throw new Error(`读取 ${p} 失败：${goPathError('open', p, err)}`, { cause: err });
    }
    // 先写临时文件再 rename：进程被杀这类不走错误返回路径的场景不会留半截文件。
    atomicWrite(target, body, 0o644);
  };
  visit(src, '');
}

/** yaml.v3 对普通字符串标量的写法：能裸写就裸写，否则加双引号。 */
function yamlScalar(s: string): string {
  const plain =
    /^[A-Za-z0-9_./][A-Za-z0-9_./ -]*$/.test(s) &&
    !s.endsWith(' ') &&
    !/^(true|false|yes|no|on|off|y|n|null|~)$/i.test(s) &&
    !/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s) &&
    !/^\.(inf|nan)$/i.test(s);
  return plain ? s : goQuote(s);
}

/** yaml.Marshal(cast.Roster)：yaml.v3 的 4 空格缩进，空 packs 写成 []。 */
function rosterYAML(r: cast.Roster): string {
  const packs = r.packs ?? [];
  let out = `schema: ${yamlScalar(r.schema)}\n`;
  out += packs.length === 0 ? 'packs: []\n' : 'packs:\n' + packs.map((p) => `    - ${yamlScalar(p)}\n`).join('');
  out += 'defaults:\n';
  out += `    ground_y: ${formatG(r.defaults.ground_y)}\n`;
  out += '    gap_ms:\n';
  out += `        turn: ${r.defaults.gap_ms.turn}\n`;
  out += `        interject: ${r.defaults.gap_ms.interject}\n`;
  return out;
}

/**
 * registerCastPack 把 relPath 追加进项目根 root 的 cast.yaml。
 * cast.yaml 不存在时按约定默认值新建；已登记过同一路径则不重复追加。
 */
function registerCastPack(root: string, relPath: string): void {
  const roster: cast.Roster = cast.hasRoster(root)
    ? cast.loadRoster(root)
    : { schema: cast.SchemaVersion, packs: null, defaults: { ground_y: castDefaultGroundY, gap_ms: { ...castDefaultGapMs } } };
  if ((roster.packs ?? []).includes(relPath)) return;
  roster.packs = [...(roster.packs ?? []), relPath];
  const file = path.join(root, cast.RosterFile);
  try {
    fs.writeFileSync(file, rosterYAML(roster), { mode: 0o644 });
  } catch (err) {
    throw new Error(`写入 ${cast.RosterFile} 失败：${goPathError('open', file, err)}`, { cause: err });
  }
}

defineOp({
  name: 'cast_validate',
  cli: ['cast', 'validate'],
  summary: '校验角色包',
  description: `校验角色包能否通过 cast.Load，并重新生成它们的 character.json。

不传 packs 时：
  - 项目根有 cast.yaml，则校验它 packs 列表里登记的全部角色包；
  - 没有 cast.yaml，则扫描 cast/ 目录下每一个含 character.yaml 的子目录；
  - 两者都没有则视为无事可做，不算失败。

传 packs 时，把每一项当成角色包目录，逐个 cast.Load，与是否登记进
cast.yaml 无关。

任一角色包 rig/schema 校验失败就报错；问题按包分组列出，一次看到
全部，不是修一个报一个。

校验通过顺带重新生成 character.json（渲染机实际读取的格式）。手改
character.yaml 后如果没调这个工具，character.json 就是旧的且不会有任何
报错或警告——渲染机会静默用回旧值。改完 yaml，渲染前一律先调一次。

顺带提醒当前 TTS_PROVIDER 是否缺音色（不影响成败，只在通过行后面追加
提醒）：这是做完角色包后第一个会调的工具，音色缺口应当在这时就被看到，
而不是等到 validate_cast() 在发布前才拦下——那条硬校验仍然存在，不受这里
影响。provider 缺省取 config_get({"key": "TTS_PROVIDER"})，解析不到完整项目配置
（比如还不是完整的项目、ORCHESTRATOR/RENDERER 尚未配置）就跳过这项提醒，
不连带让 rig 校验也失败——这里的音色检查是附带诊断，不是主职责。`,
  examples: ['cast_validate()', 'cast_validate({"packs": ["cast/heiwa", "cast/xiaoming"]})', 'cast_validate({"provider": "bailian"})'],
  params: {
    packs: { type: 'strings', description: '角色包目录，缺省为 cast.yaml 登记的全部', positional: 'rest' },
    provider: { type: 'string', description: '校验音色缺口时按哪个 TTS provider，缺省取解析后的 TTS_PROVIDER' },
  },
  run: (p, { out }) => runCastValidate(out, strs(p.packs), resolveCastValidateProvider(str(p.provider))),
});

/**
 * 解析 cast_validate 顺带做的音色检查要用的 provider。与 validate_cast 不同：
 * 这里的音色检查只是附带诊断，config 解析不出来（常见于刚 cast new 完、还没配置
 * ORCHESTRATOR/RENDERER 的半成品项目）就跳过检查——返回空字符串，调用方据此不查。
 */
function resolveCastValidateProvider(explicit: string): string {
  if (explicit !== '') return explicit;
  try {
    return config.load('.', null).ttsProvider;
  } catch {
    return '';
  }
}

interface CastTarget {
  name: string;
  dir: string;
}

function runCastValidate(stdout: Out, args: string[], provider: string): OpResult {
  const targets = castValidateTargets(args);
  if (targets.length === 0) {
    stdout.write('没有找到需要校验的角色包\n');
    return { data: { packs: [], failed: [] } };
  }
  const { report, failed } = validateCastTargets(targets, provider);
  stdout.write(report);
  if (failed.length > 0) throw new Error(`以下角色包未通过校验：${failed.join('、')}`);
  return { data: { packs: targets.map((t) => t.name), failed } };
}

function castValidateTargets(args: string[]): CastTarget[] {
  if (args.length > 0) return args.map((a) => ({ name: a, dir: a }));
  if (cast.hasRoster('.')) {
    const roster = cast.loadRoster('.');
    return (roster.packs ?? []).map((rel) => ({ name: rel, dir: rel }));
  }
  return discoverCastPacks('.');
}

/**
 * discoverCastPacks 在没有 cast.yaml 时兜底：把 cast/ 下每一个含
 * character.yaml 的子目录都当作待校验的角色包。cast/ 不存在时返回空列表，
 * 不是错误——刚新建的项目本来就还没有任何角色包。
 */
function discoverCastPacks(root: string): CastTarget[] {
  const castDir = path.join(root, 'cast');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(castDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`读取 ${castDir} 失败：${goPathError('open', castDir, err)}`, { cause: err });
  }
  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(compareBytes);
  const targets: CastTarget[] = [];
  for (const name of names) {
    const dir = path.join(castDir, name);
    if (!fs.existsSync(path.join(dir, cast.PackFile))) continue;
    targets.push({ name, dir });
  }
  return targets;
}

/**
 * 逐个 cast.Load，成功则重新生成 character.json。返回按包分组的报告文本，以及未通过校验的包名列表。
 *
 * provider 为空时跳过音色提醒；非空时对每个通过 rig 校验的包顺带查一次 voiceFor(provider)，
 * 缺口只追加一行提醒，不计入 failed——真正的硬校验在 validate_cast。
 */
function validateCastTargets(targets: readonly CastTarget[], provider: string): { report: string; failed: string[] } {
  let report = '';
  const failed: string[] = [];
  for (const target of targets) {
    let pack: cast.Pack;
    try {
      pack = cast.load(target.dir);
      cast.writePackJSON(pack, target.dir);
    } catch (err) {
      failed.push(target.name);
      report += `[${target.name}]\n  - ${errText(err)}\n`;
      continue;
    }
    if (provider !== '') {
      try {
        cast.voiceFor(pack, provider);
      } catch (voiceErr) {
        report += `[${target.name}] 通过（提醒：${errText(voiceErr)}；发布前 validate_cast() 会把这个问题拦成失败）\n`;
        continue;
      }
    }
    report += `[${target.name}] 通过\n`;
  }
  return { report, failed };
}

defineOp({
  name: 'cast_preview',
  cli: ['cast', 'preview'],
  summary: '把角色包的每个命名姿势渲成一张验收图',
  description: `cast.Load 校验 pack 后，为它的每一个视图各自把声明的每个姿势渲成 PNG
并拼成一张 contact sheet，写到 production/cast-preview/，供人眼验收关节
角度是否合理。角色包只有默认视图时只会生成一张。

依赖 rsvg-convert（渲染单张姿势）和 ImageMagick 的 magick（拼图），
两者缺一都会失败并说明缺的是哪个命令。`,
  examples: ['cast_preview({"pack": "cast/heiwa"})'],
  params: { pack: { type: 'string', description: '角色包目录', required: true, positional: 0 } },
  run: (p, { out }) => ({ data: { sheets: runCastPreview(out, str(p.pack)) } }),
});

function runCastPreview(stdout: Out, packDir: string): Record<string, string> {
  const pack = cast.load(packDir);
  const outDir = path.join('production', 'cast-preview');
  const sheets = cast.preview(pack, outDir);
  for (const viewName of Object.keys(sheets).sort(compareBytes)) {
    stdout.write(`预览图已生成（视图 ${viewName}）：${sheets[viewName]}\n`);
  }
  return sheets;
}

/** dialogue_assemble 未传 plan 时的默认路径，与编排流程里 TTS 分段产物的落地位置一致。 */
const dialogueDefaultPlanPath = path.join('production', 'audio', 'plan.json');

/**
 * dialogue 一组：assemble 与 beats。
 *
 * internal/dialogue 包只管纯粹的装配逻辑（读 plan、探测音频、拼接、写产物），
 * 不碰参数解析；这里是唯一把它接到操作表上的地方。
 */
defineGroup({
  path: ['dialogue'],
  summary: '多角色对白装配相关操作',
  description: `把分说话人合成的配音段装配成一条完整对白时间线。

分段 TTS 只给得到段内相对时间戳，拼成全局时间轴要逐段累加偏移、插入段间
静音、再拼接成一条完整音轨——这类机械计算算错了不会报错，只会让成片画面
正常、嘴和字却对不上，所以收进这一组工具而不是留给编排工具自己拼。`,
});

defineOp({
  name: 'dialogue_beats',
  cli: ['dialogue', 'beats'],
  summary: '按 dialogue.json 重算各镜头 scene.json 的 cast.beats',
  description:
    `读取 ` +
    castbeats.DialogueRelPath +
    ` 与 scenes/*/scene.json，把每一行台词
按镜头切片、减去该镜头的全局起点，写回各镜头 cast 块的 beats。

镜头怎么切是创作判断（每个镜头的 duration_seconds 由你定），但"给定对白
时间线与已定的镜头时长，算出每个镜头的节拍"是纯机械计算——减错一个镜头
起点，成片画面正常、只是角色在不该说话的时候动嘴，什么都不会报错。所以
这一步收进这个工具，不要手写 beats。

行为：

  - 一行台词横跨镜头切点时按切点拆成多拍，各自落进自己的镜头
  - 有 cast 块但整段无人说话的镜头写出空数组（"算过了，确实没人说话"）
  - 没有 cast 块又没有台词盖过的镜头一个字节都不碰（老镜头零影响）
  - 只改 cast.beats：pack_dir / ground_y / on_stage 与其它字段原样保留
  - 既有 beats 一律忽略并整体重写：它是这个工具的输出，不是输入。改小过
    duration_seconds、旧节拍越界的镜头不需要先手工清理，直接重跑
  - 幂等：重复执行结果一致，内容没变的文件不重新落盘

项目根没有 cast.yaml（单口播项目）时直接报错：cast.beats 只在多角色
模式下存在。

有台词盖过、却没写 cast 块的镜头会报错而不是现编一个——这里不替你决定
角色站位。台词落在所有镜头覆盖范围之外时同样报错，那是镜头 duration_seconds
与配音对不上，先对齐时长再重算。任一检查不通过就一个文件都不写。`,
  examples: ['dialogue_beats()'],
  params: {},
  run: (_p, { out }) => ({ data: runDialogueBeats(out) }),
});

function runDialogueBeats(stdout: Out): castbeats.Report {
  const report = castbeats.apply('.');
  stdout.write(`镜头节拍已按 ${castbeats.DialogueRelPath} 重算（${report.lines} 行台词）：\n`);
  for (const s of report.scenes ?? []) {
    stdout.write(`  ${s.id}  ${s.count} 拍${s.changed ? '' : '（未变）'}\n`);
  }
  stdout.write(`已更新 ${report.updated} 个 scene.json\n`);
  return report;
}

defineOp({
  name: 'dialogue_assemble',
  cli: ['dialogue', 'assemble'],
  summary: '把 plan.json 里的分段配音装配成一条对白时间线',
  description: `读取 plan 指定的 plan.json，把里面登记的每一段配音统一格式、按需插入
段间静音后拼接成一条完整音轨，同时算出全局时间轴，产出三个文件：

  ${dialogue.VoiceRelPath}       拼接后的完整配音
  ${dialogue.SRTRelPath}     按全局时间轴生成的字幕
  ${dialogue.DialogueRelPath}         装配结果的结构化时间线（schema ${dialogue.SchemaVersion}）

装配过程内置两道漂移断言：逐段声明时长与实测时长的比对、总时长漂移
（容差 ${formatFixed(dialogue.DriftToleranceSeconds, 3)} 秒）比对，任一超出容差都会失败并点名具体是第几段、哪个文件、
声明多少、实测多少——这些错误原样透出，不额外包装。

expect_total 是可选的第三道校验：外部（通常是编排工具）期望的总时长，
用于额外核对；不传就只做上面两道内部一致性断言。`,
  examples: ['dialogue_assemble()', 'dialogue_assemble({"plan": "production/audio/plan.json", "expect_total": 42.5})'],
  params: {
    plan: { type: 'string', description: 'plan.json 路径', default: dialogueDefaultPlanPath },
    expect_total: { type: 'number', description: '外部期望总时长（秒），用于额外校验；可选，缺省不做这道校验' },
  },
  run: async (p, { out, signal }) => {
    const result = await dialogue.assemble({ root: '.', planPath: str(p.plan), expectTotalSeconds: num(p.expect_total) }, signal);
    out.write('对白已装配：\n');
    out.write(`  音频：${dialogue.VoiceRelPath}\n`);
    out.write(`  字幕：${dialogue.SRTRelPath}\n`);
    out.write(`  时间线：${dialogue.DialogueRelPath}\n`);
    out.write(`总时长：${formatFixed(dialogue.totalSeconds(result), 3)} 秒\n`);
    return { data: { voice: dialogue.VoiceRelPath, srt: dialogue.SRTRelPath, dialogue: dialogue.DialogueRelPath, total_seconds: dialogue.totalSeconds(result) } };
  },
});
