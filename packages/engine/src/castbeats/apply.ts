import fs from 'node:fs';
import path from 'node:path';
import * as cast from '../cast';
import * as dialogue from '../dialogue';
import type { Line } from '../dialogue';
import { atomicWrite } from '../fsutil';
import { formatFixed, formatG, goPathError, goQuote } from '../gofmt';
import { marshal } from '../gojson';
import { BeatOverlapToleranceSeconds, type Beat } from '../plugins/cast/block';
import { decodeObject, encodeObject, findField, indent, setField } from '../rawjson/jsonedit';
import { readSceneHeads } from './scenes';
import { slice } from './slice';

/**
 * 对白时间线在项目里的固定位置，与 am dialogue assemble 的产出位置一致。
 * 是 dialogue.DialogueRelPath 的别名，不要另造第三处：写方（dialogue.assemble）、
 * 打印方（cli 的 runDialogueAssemble）、读方（validate/cast.ts、本包）都只应引用这一份真相源。
 *
 * 用 let 导出是为了让测试能临时换成标记值（Go 版是包变量），见 setDialogueRelPath。
 */
export let DialogueRelPath: string = dialogue.DialogueRelPath;

/** 替换 DialogueRelPath，返回原值。只供测试使用。 */
export function setDialogueRelPath(value: string): string {
  const previous = DialogueRelPath;
  DialogueRelPath = value;
  return previous;
}

/** 单个镜头的重算结果。 */
export interface SceneBeats {
  id: string;
  count: number;
  changed: boolean;
}

/** 一次重算的汇总，供 CLI 打印。 */
export interface Report {
  lines: number;
  /** Go 的 nil 切片为 null。 */
  scenes: SceneBeats[] | null;
  updated: number;
}

/**
 * 读 root 下的 production/dialogue.json 与 scenes/*\/scene.json，
 * 把每一行台词按镜头切片、减去镜头起点，写回各镜头 cast.beats。
 *
 * 只动 cast.beats：pack_dir / ground_y / on_stage 以及 cast 块之外的一切
 * 字段都原样保留，键的顺序也不变。没有 cast 块的镜头一律不碰——本命令不会
 * 替作者决定角色站位，有台词盖过却没写 cast 块时报错而不是现编一个。
 *
 * 全部检查通过之前一个字节都不写：报错时不留下改了一半的镜头树。
 */
export function apply(root: string): Report {
  // cast.yaml 存在与否就是叙事模式本身。单口播项目误跑到这条命令时，
  // 先说清"本项目不是多角色项目"——否则报出来的是"找不到 dialogue.json"，
  // 会把人往"少跑了 am dialogue assemble"上引，接着去装配一个根本不存在
  // 的对白。
  if (!cast.hasRoster(root)) {
    throw new Error(
      `本项目不是多角色项目：项目根没有 ${cast.RosterFile}，cast.beats 只在多角色模式下存在。` +
        '单口播项目不需要执行本命令；如果这本该是多角色项目，' +
        '请确认当前目录就是项目根，并在客户端新建项目时选「多角色对话」',
    );
  }

  const lines = loadDialogueLines(path.join(root, DialogueRelPath));
  const heads = readSceneHeads(path.join(root, 'scenes'));

  const offsets: number[] = [];
  const durations: number[] = [];
  let total = 0;
  for (const h of heads) {
    offsets.push(total);
    durations.push(h.duration);
    total += h.duration;
  }

  const { beats: perScene, uncovered } = slice(lines, offsets, durations);

  const problems: string[] = [];
  heads.forEach((h, i) => {
    if (!h.hasCast && (perScene[i]?.length ?? 0) > 0) {
      problems.push(
        `镜头 ${h.id}（全局 ${formatFixed(offsets[i], 3)}–${formatFixed(offsets[i] + durations[i], 3)} 秒）有台词盖过，却没有 cast 块：本命令只负责重算 beats，` +
          '不会替你决定 pack_dir / ground_y / on_stage——先把 cast 块补上（beats 可以不写）再重跑',
      );
    }
  });
  for (const index of uncovered) {
    const l = lines[index];
    problems.push(
      `${DialogueRelPath} 第 ${l.srtIndex} 行（说话人 ${l.speaker}，${formatFixed(l.startSeconds, 3)}–${formatFixed(l.endSeconds, 3)} 秒）没有被任何镜头盖住，` +
        `全部镜头合计只有 ${formatFixed(total, 3)} 秒：这是镜头 duration_seconds 与配音对不上，` +
        '先对齐镜头时长再重算节拍',
    );
  }
  if (problems.length > 0) throw new Error(`无法重算镜头节拍：\n  - ${problems.join('\n  - ')}`);

  const report: Report = { lines: lines.length, scenes: null, updated: 0 };
  heads.forEach((h, i) => {
    if (!h.hasCast) return;
    let changed: boolean;
    try {
      changed = writeSceneBeats(path.join(h.dir, 'scene.json'), perScene[i]);
    } catch (err) {
      throw new Error(`写入镜头 ${h.id} 的节拍失败：${(err as Error).message}`, { cause: err });
    }
    (report.scenes ??= []).push({ id: h.id, count: perScene[i]?.length ?? 0, changed });
    if (changed) report.updated++;
  });
  return report;
}

/**
 * 读出 dialogue.json 的台词行并校验它自身可用：schema
 * 对得上、至少一行、逐行按时间递增不重叠。
 *
 * 重叠必须在这里拦：重叠的输入切出来的就是重叠的节拍，写进 scene.json 之后
 * scene.load 会直接拒绝加载——那时错误指向的是本命令刚写坏的镜头，而不是
 * 真正有问题的 dialogue.json。
 *
 * 重叠判定用 scene.BeatOverlapToleranceSeconds（不是本包的 minBeatSeconds）：
 * minBeatSeconds 的量级（1 微秒）是为"一拍最短写多长"这件事选的，比
 * scene.validateCast 实际拒绝重叠的容差（1e-9）松了三个数量级——曾经真的
 * 用 minBeatSeconds 当过重叠容差，(1e-9, 1e-6] 区间内的重叠会在这里放行、
 * 切出的节拍却在 scene.load 那边被拒，命令退出码 0 之后紧跟着一个过不了
 * 校验的产物。两处判的是同一件事，必须用同一个容差。
 */
export function loadDialogueLines(file: string): Line[] {
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    throw new Error(
      `找不到或无法读取 ${DialogueRelPath}：${goPathError('open', file, err)}` +
        '（多角色项目的对白时间线由 dialogue_assemble() 产出，请先执行它）',
      { cause: err },
    );
  }
  let result: dialogue.Result;
  try {
    result = dialogue.unmarshalResult(body);
  } catch (err) {
    throw new Error(`${DialogueRelPath} 不是合法 JSON：${(err as Error).message}`, { cause: err });
  }
  if (result.schema !== dialogue.SchemaVersion) {
    throw new Error(`${DialogueRelPath} 的 schema 必须是 ${dialogue.SchemaVersion}，收到 ${goQuote(result.schema)}`);
  }
  const lines = result.lines ?? [];
  if (lines.length === 0) throw new Error(`${DialogueRelPath} 没有任何台词行`);
  lines.forEach((l, i) => {
    if (l.endSeconds <= l.startSeconds) {
      throw new Error(`${DialogueRelPath} 第 ${l.srtIndex} 行时间倒挂：[${formatG(l.startSeconds)}, ${formatG(l.endSeconds)}]`);
    }
    if (i > 0 && l.startSeconds < lines[i - 1].endSeconds - BeatOverlapToleranceSeconds) {
      throw new Error(
        `${DialogueRelPath} 第 ${l.srtIndex} 行与上一行重叠：上一行止于 ${formatFixed(lines[i - 1].endSeconds, 3)} 秒，本行起于 ${formatFixed(l.startSeconds, 3)} 秒`,
      );
    }
  });
  return lines;
}

/**
 * 只替换 scene.json 里 cast.beats 一个字段，其余字节原样
 * 保留（键顺序、数字写法、字符串转义都不变），整份文件重新按两空格缩进。
 *
 * 内容没变时不落盘：重复执行本命令不该刷新任何文件的 mtime，否则下游
 * 那些拿 mtime 判"产物是不是过期"的逻辑会被无谓地触发。
 */
export function writeSceneBeats(file: string, beats: readonly Beat[] | null): boolean {
  let original: Buffer;
  try {
    original = fs.readFileSync(file);
  } catch (err) {
    throw new Error(goPathError('open', file, err), { cause: err });
  }
  const fields = decodeObject(original.toString('utf8'));
  const castRaw = findField(fields, 'cast');
  if (castRaw === undefined) throw new Error('scene.json 没有 cast 块');
  let castFields;
  try {
    castFields = decodeObject(castRaw);
  } catch (err) {
    throw new Error(`scene.json 的 cast 块解析失败：${(err as Error).message}`, { cause: err });
  }
  const beatsRaw = marshal((beats ?? []).map((b) => ({ speaker: b.speaker, start: b.start, end: b.end })));
  setField(castFields, 'beats', beatsRaw);
  setField(fields, 'cast', encodeObject(castFields));
  const pretty = Buffer.from(indent(encodeObject(fields)) + '\n', 'utf8');
  if (pretty.equals(original)) return false;
  atomicWrite(file, pretty, 0o644);
  return true;
}
