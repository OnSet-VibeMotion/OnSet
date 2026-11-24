/**
 * 角色包校验、姿势预览图生成与对白镜头节拍重算。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as cast from '../../cast';
import * as castbeats from '../../castbeats';
import * as config from '../../config';
import { goPathError } from '../../gofmt';
import { compareBytes } from '../../gojson';
import { errText } from './pack_ops';

type Out = { write(text: string): void };
type OpResult = { data?: unknown };

/**
 * 解析 cast_validate 顺带做的音色检查要用的 provider。与 validate_cast 不同：
 * 这里的音色检查只是附带诊断，config 解析不出来（常见于刚 cast new 完、还没配置
 * ORCHESTRATOR/RENDERER 的半成品项目）就跳过检查——返回空字符串，调用方据此不查。
 */
export function resolveCastValidateProvider(explicit: string): string {
  if (explicit !== '') return explicit;
  // 有了全局设置之后，没有项目配置也能解析出配音工具（全局或内置默认）；
  // 这里要的是「项目还没配置就不查」，所以没有 onset.conf 时照旧跳过。
  if (!fs.existsSync('onset.conf')) return '';
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

export function runCastValidate(stdout: Out, args: string[], provider: string): OpResult {
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

export function runCastPreview(stdout: Out, packDir: string): Record<string, string> {
  const pack = cast.load(packDir);
  const outDir = path.join('production', 'cast-preview');
  const sheets = cast.preview(pack, outDir);
  for (const viewName of Object.keys(sheets).sort(compareBytes)) {
    stdout.write(`预览图已生成（视图 ${viewName}）：${sheets[viewName]}\n`);
  }
  return sheets;
}

/**
 * dialogue 一组：assemble 与 beats。
 *
 * internal/dialogue 包只管纯粹的装配逻辑（读 plan、探测音频、拼接、写产物），
 * 不碰参数解析；这里是唯一把它接到操作表上的地方。
 */
export function runDialogueBeats(stdout: Out): castbeats.Report {
  const report = castbeats.apply('.');
  stdout.write(`镜头节拍已按 ${castbeats.DialogueRelPath} 重算（${report.lines} 行台词）：\n`);
  for (const s of report.scenes ?? []) {
    stdout.write(`  ${s.id}  ${s.count} 拍${s.changed ? '' : '（未变）'}\n`);
  }
  stdout.write(`已更新 ${report.updated} 个 scene.json\n`);
  return report;
}
