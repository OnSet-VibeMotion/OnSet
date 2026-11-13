import fs from 'node:fs';
import path from 'node:path';
import { formatG, goQuote, pathError } from './gofmt';
import { load, SchemaVersion, type Pack } from './pack';
import { float, int, str, unmarshal, type Schema } from './yamldecode';

/**
 * 项目级班底文件名。它存在与否就是叙事模式本身：
 * 不引入运行期开关，避免"配置说 cast、项目里没有角色包"这种可矛盾状态。
 */
export const RosterFile = 'cast.yaml';

/**
 * 换人停顿，单位毫秒。
 * turn 是常规轮换，interject 是打断式插话——后者压短才有抢话感。
 */
export interface GapMs {
  turn: number;
  interject: number;
}

export interface Defaults {
  ground_y: number;
  gap_ms: GapMs;
}

export interface Roster {
  schema: string;
  packs: string[] | null;
  defaults: Defaults;
}

const rosterSchema: Schema & { kind: 'struct' } = {
  kind: 'struct',
  type: 'cast.Roster',
  fields: [
    ['schema', 'schema', str],
    ['packs', 'packs', { kind: 'slice', elem: str, type: '[]string' }],
    [
      'defaults',
      'defaults',
      {
        kind: 'struct',
        type: 'cast.Defaults',
        fields: [
          ['ground_y', 'ground_y', float],
          [
            'gap_ms',
            'gap_ms',
            {
              kind: 'struct',
              type: 'cast.GapMs',
              fields: [
                ['turn', 'turn', int],
                ['interject', 'interject', int],
              ],
              zero: () => ({ turn: 0, interject: 0 }),
            },
          ],
        ],
        zero: () => ({ ground_y: 0, gap_ms: { turn: 0, interject: 0 } }),
      },
    ],
  ],
  zero: () => ({ schema: '', packs: null, defaults: { ground_y: 0, gap_ms: { turn: 0, interject: 0 } } }),
};

/** 项目是否为多角色模式。 */
export function hasRoster(root: string): boolean {
  try {
    return !fs.statSync(path.join(root, RosterFile)).isDirectory();
  } catch {
    return false;
  }
}

export function loadRoster(root: string): Roster {
  const file = path.join(root, RosterFile);
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读取 ${RosterFile} 失败：${pathError('open', file, err)}`, { cause: err });
  }
  let roster: Roster;
  try {
    roster = unmarshal<Roster>(body, rosterSchema);
  } catch (err) {
    throw new Error(`解析 ${RosterFile} 失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (roster.schema !== SchemaVersion) {
    throw new Error(`${RosterFile} 的 schema 必须是 ${SchemaVersion}，收到 ${goQuote(roster.schema)}`);
  }
  const groundY = roster.defaults.ground_y;
  if (groundY <= 0 || groundY >= 1) {
    throw new Error(`${RosterFile} 的 defaults.ground_y 必须在 (0,1)，收到 ${formatG(groundY)}`);
  }
  const gap = roster.defaults.gap_ms;
  if (gap.turn < 0 || gap.interject < 0) {
    throw new Error(`${RosterFile} 的 defaults.gap_ms 不得为负：{Turn:${gap.turn} Interject:${gap.interject}}`);
  }
  return roster;
}

/** Go 的 filepath.EvalSymlinks：解析全部符号链接；失败时给出 Go 风格的文案。 */
function evalSymlinks(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    throw new Error(pathError('lstat', p, err), { cause: err });
  }
}

/**
 * 检查 packs 路径是否逃出项目根目录。
 * 处理 `../../outside` 这类相对路径逃逸，以及指向项目外的软链。
 */
function containedPack(root: string, rel: string): string {
  if (rel === '' || path.isAbsolute(rel)) {
    throw new Error(`${RosterFile} 的 packs 必须是非空相对路径，收到 ${goQuote(rel)}`);
  }
  root = path.resolve(root);
  const target = path.resolve(root, rel);
  let resolvedRoot: string;
  try {
    resolvedRoot = evalSymlinks(root);
  } catch (err) {
    throw new Error(`无法解析项目目录：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  let resolvedTarget: string;
  try {
    resolvedTarget = fs.realpathSync(target);
  } catch {
    // 目标不存在（可能还没有被创建），尝试解析其父目录
    try {
      resolvedTarget = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
    } catch {
      resolvedTarget = target;
    }
  }
  const relative = path.relative(resolvedRoot, resolvedTarget) || '.';
  if (relative === '..' || relative.startsWith('..' + path.sep)) {
    throw new Error(`${RosterFile} 的 packs 不得逃出项目目录：${relative}`);
  }
  return resolvedTarget;
}

/** 按班底加载全部角色包，键是角色 id。 */
export function loadPacks(r: Roster, root: string): Record<string, Pack> {
  const out: Record<string, Pack> = {};
  for (const rel of r.packs ?? []) {
    // 检查路径安全性，防止逃逸和软链指向项目外
    containedPack(root, rel);
    let pack: Pack;
    try {
      pack = load(path.join(root, rel));
    } catch (err) {
      throw new Error(`角色包 ${rel}：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (Object.hasOwn(out, pack.id)) throw new Error(`角色 id ${pack.id} 重复：${out[pack.id].dir} 与 ${pack.dir}`);
    out[pack.id] = pack;
  }
  return out;
}
