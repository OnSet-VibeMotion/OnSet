// 多角色对话的项目骨架：cast.yaml 与空的 cast/ 目录。新建项目选了叙事模式 cast 时由插件登记的 narration 写出，
// cast_add 在项目还没有 cast.yaml 时用同一组缺省值。
import fs from 'node:fs';
import path from 'node:path';
import * as cast from '../../cast';
import { atomicWrite } from '../../fsutil';
import { formatG, goPathError } from '../../gofmt';

/** 新建 cast.yaml 时写入的默认班底参数，cast_add 新建 cast.yaml 时用同一组值。 */
export const CastDefaultGroundY = 0.78;
export const CastDefaultGapMs = { turn: 240, interject: 100 };

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
