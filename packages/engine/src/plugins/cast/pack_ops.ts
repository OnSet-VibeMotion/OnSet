/**
 * 角色包骨架生成、外部包引入、目录树安全拷贝与 cast.yaml 班底登记。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as cast from '../../cast';
import { atomicWrite } from '../../fsutil';
import { formatG, goPathError, goQuote } from '../../gofmt';
import { compareBytes } from '../../gojson';
import { CastDefaultGapMs, CastDefaultGroundY } from './scaffold';

type Out = { write(text: string): void };

// castDefaultGroundY、castDefaultGapMs 是新建 cast.yaml 时写入的默认班底参数。
const castDefaultGroundY = CastDefaultGroundY;
const castDefaultGapMs = CastDefaultGapMs;

export function errText(err: unknown): string {
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

export function runCastNew(stdout: Out, id: string): string {
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
  // onset validate cast 一直报"班底为空"。registerCastPack 是幂等的。
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
  breeze: { voiceId: "" }
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

export function runCastAdd(stdout: Out, source: string): string {
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
    : {
        schema: cast.SchemaVersion,
        packs: null,
        defaults: { ground_y: castDefaultGroundY, gap_ms: { ...castDefaultGapMs } },
      };
  if ((roster.packs ?? []).includes(relPath)) return;
  roster.packs = [...(roster.packs ?? []), relPath];
  const file = path.join(root, cast.RosterFile);
  try {
    fs.writeFileSync(file, rosterYAML(roster), { mode: 0o644 });
  } catch (err) {
    throw new Error(`写入 ${cast.RosterFile} 失败：${goPathError('open', file, err)}`, { cause: err });
  }
}
