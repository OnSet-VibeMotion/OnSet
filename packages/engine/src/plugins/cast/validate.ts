// 多角色项目的项目级一致性校验（validate_cast 用它）。移植自 internal/validate/cast.go。
import fs from 'node:fs';
import path from 'node:path';
import * as cast from '../../cast';
import * as dialogue from '../../dialogue';
import type { Line } from '../../dialogue';
import { formatFixed, formatG, goPathError, goQuote } from '../../gofmt';
import { compareBytes } from '../../gojson';
import * as schedule from '../../schedule';
import * as srt from '../../srt';

/**
 * 把镜头本地 beats 换算回全局时间后，与 dialogue.json 对应行做覆盖/相接比对时的容差。
 * dialogue.json 与 beats 换算出来的时间戳都是浮点数（rebuild 按实测时长缩放算出来的），
 * 1 毫秒足够吸收累加误差，又远小于「beats 真的漏标了一整行」这类实际问题的量级。
 */
const beatCoverageToleranceSeconds = 0.001;

/**
 * dialogue.json 自身逐行重叠检测的容差。数值上与 beatCoverageToleranceSeconds 一样，但语义不同——
 * 一个管"镜头 beats 是否盖住了台词行"，一个管"台词行之间是否重叠"，各起各的名字，
 * 以后两者要分道扬镳时不用从共用的名字里把语义拆开。
 */
const lineOverlapToleranceSeconds = 0.001;

/**
 * dialogue.json 在项目里的位置。默认就是 dialogue.DialogueRelPath；Go 版的测试会临时改写那个包变量，
 * TS 的导入绑定是只读的，所以本包留一份可替换的引用，见 setDialogueRelPath。
 */
let dialogueRelPath: string = dialogue.DialogueRelPath;

/** 替换本包使用的 dialogue.json 相对路径，返回原值。只供测试使用。 */
export function setDialogueRelPath(value: string): string {
  const previous = dialogueRelPath;
  dialogueRelPath = value;
  return previous;
}

/**
 * 校验多角色项目的项目级一致性：班底与角色包是否自洽、
 * dialogue.json 是否完整覆盖字幕、每个镜头的 cast.beats 换算回全局时间后
 * 是否合并覆盖了 dialogue.json 的全部台词行。
 *
 * cast.hasRoster(root) 为假时直接返回 null：老项目（没有 cast.yaml）不受
 * 这组检查影响，这是最重要的一条约束。没有问题时同样返回 null（Go 的 nil 切片）。
 *
 * 后续检查逐步依赖前面的产物：拿不到角色包就没法查音色，拿不到
 * dialogue.json 就没法查字幕覆盖和镜头覆盖，所以某一步失败时会跳过依赖它
 * 的后续步骤，但已经收集到的问题仍然全部返回，不是查到第一个就停。
 */
export function castProblems(root: string, provider: string): string[] | null {
  if (!cast.hasRoster(root)) return null;
  const problems: string[] = [];
  const done = () => (problems.length > 0 ? problems : null);

  let roster: cast.Roster;
  try {
    roster = cast.loadRoster(root);
  } catch (err) {
    problems.push(`读取 ${cast.RosterFile} 失败：${(err as Error).message}`);
    return done();
  }

  // 早前的裁定：loadRoster 接受 packs: []（am init 刚建的项目本就还没
  // 角色），"班底为空"要在发布前由这一层拦下，不是 loadRoster 的职责。
  if ((roster.packs ?? []).length === 0) {
    problems.push(`班底为空：${cast.RosterFile} 没有登记任何角色包，发布前必须至少有一个角色`);
  }

  let packs: Record<string, cast.Pack>;
  try {
    packs = cast.loadPacks(roster, root);
  } catch (err) {
    // cast.yaml 列了包但目录被手工删掉、或包本身不自洽：后续检查都依赖 packs，拿不到就没法继续。
    problems.push(`加载角色包失败：${(err as Error).message}`);
    return done();
  }

  for (const id of Object.keys(packs).sort(compareBytes)) {
    const pack = packs[id];
    try {
      cast.voiceFor(pack, provider);
    } catch (err) {
      problems.push(`角色 ${id} 缺少 ${provider} 音色：${(err as Error).message}`);
    }
    // 班底源目录（cast/<id>/）自己的 dna.md 是否存在。这跟下面 sceneCastProblems 里查的
    // "镜头引用路径缺 dna.md"是两条互相独立的检查：镜头目录内的 pack_dir 通常是这份源文件的拷贝，
    // 源文件被误删、但某个镜头此前拷贝过的副本还在时，只查镜头引用路径看不出问题——直到下一次
    // 往新镜头里拷贝才会把缺失带进去，那时已经晚了。查 pack.dir 而不是重新拼 root/cast/id，是
    // 因为 pack.dir 就是 cast.load 实际读到这个包的目录。
    const dnaPath = path.join(pack.dir, 'dna.md');
    if (!isRegular(dnaPath)) problems.push(`角色 ${id} 的班底目录缺少 dna.md：${dnaPath} 不存在`);
  }

  const dialoguePath = path.join(root, dialogueRelPath);
  const [result, dialogueProblems] = loadDialogueResult(dialoguePath);
  problems.push(...dialogueProblems);
  // 拿不到 dialogue.json 就没法继续查字幕覆盖和镜头覆盖。
  if (result === null) return done();
  const lines = result.lines ?? [];

  problems.push(...dialogueLineProblems(lines));

  const srtPath = path.join(root, dialogue.SRTRelPath);
  try {
    const span = srt.readSpan(srtPath);
    if (span.cues !== lines.length) {
      problems.push(`${dialogueRelPath} 的字幕行数 ${lines.length} 与 ${dialogue.SRTRelPath} 的字幕条数 ${span.cues} 不一致`);
    }
  } catch (err) {
    problems.push(`读取 ${dialogue.SRTRelPath} 失败：${(err as Error).message}`);
  }

  for (const line of lines) {
    if (!Object.hasOwn(packs, line.speaker)) {
      problems.push(`dialogue.json 第 ${line.srtIndex} 行的说话人 ${goQuote(line.speaker)} 不在班底里`);
    }
  }

  problems.push(...sceneCastProblems(root, lines));
  return done();
}

function isRegular(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 读出 production/dialogue.json 并校验它的外层结构（schema、至少一行）。复用 dialogue 包的
 * Result 类型而不是自己重新定义一遍字段，避免 schema 出现第二个不同步的真相源。
 */
function loadDialogueResult(file: string): [dialogue.Result | null, string[]] {
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    const op = (err as NodeJS.ErrnoException).code === 'EISDIR' ? 'read' : 'open';
    return [null, [`找不到或无法读取 ${dialogueRelPath}：${goPathError(op, file, err)}`]];
  }
  let result: dialogue.Result;
  try {
    result = dialogue.unmarshalResult(body);
  } catch (err) {
    return [null, [`${dialogueRelPath} 不是合法 JSON：${(err as Error).message}`]];
  }
  if (result.schema !== dialogue.SchemaVersion) {
    return [null, [`${dialogueRelPath} 的 schema 必须是 ${dialogue.SchemaVersion}，收到 ${goQuote(result.schema)}`]];
  }
  if ((result.lines ?? []).length === 0) return [null, [`${dialogueRelPath} 没有任何字幕行`]];
  return [result, []];
}

/** 校验 dialogue.json 的 lines 自身的一致性：srtIndex 从 1 连续递增、每行时间不倒挂、逐行之间不重叠。 */
function dialogueLineProblems(lines: readonly Line[]): string[] {
  const problems: string[] = [];
  let prevEnd = -Infinity;
  lines.forEach((line, i) => {
    if (line.srtIndex !== i + 1) {
      problems.push(`dialogue.json 的 srtIndex 未从 1 连续递增：第 ${i + 1} 行应为 ${i + 1}，实际 ${line.srtIndex}`);
    }
    if (line.endSeconds <= line.startSeconds) {
      problems.push(`dialogue.json 第 ${line.srtIndex} 行时间倒挂：[${formatG(line.startSeconds)}, ${formatG(line.endSeconds)}]`);
    }
    if (line.startSeconds < prevEnd - lineOverlapToleranceSeconds) {
      problems.push(
        `dialogue.json 第 ${line.srtIndex} 行与上一行重叠：上一行止于 ${formatFixed(prevEnd, 3)} 秒，本行起于 ${formatFixed(line.startSeconds, 3)} 秒`,
      );
    }
    prevEnd = line.endSeconds;
  });
  return problems;
}

/** 把镜头本地 cast.beats 换算回项目全局时间后的一拍。 */
interface GlobalBeat {
  speaker: string;
  start: number;
  end: number;
}

/**
 * 遍历 <root>/scenes/*\/scene.json，做两件在渲染阶段会静默坏掉、却从来没有任何一层校验过的事：
 *
 *  1. 把每个镜头的 cast.beats 按镜头在时间轴上的累积起点换算回全局时间，
 *     合并后必须覆盖 dialogue.json 的全部 lines，一行都不能漏——拆镜头时
 *     漏标一拍，成片里那句台词的角色要么站着不动、要么干脆不在台上，
 *     但渲染本身不会报错。
 *
 *  2. 每个 on_stage 角色声明的 dna.md 是否真的存在于 buildPrompt 会写进
 *     提示词的那个路径（<镜头目录>/<cast.pack_dir>/<id>/dna.md）。cast 包和 scene.validateCast
 *     都不查这个文件的存在性，文件缺失时提示词仍然会引用它，渲染 agent
 *     读不到人设，只能自己编，且没有任何报错。放在这里检查，是因为只有这里
 *     才同时拿得到"镜头目录"与"这个镜头实际使用的 pack_dir"——同一个
 *     角色 id 在不同镜头完全可以指向不同的 pack_dir 副本。
 */
function sceneCastProblems(root: string, lines: readonly Line[]): string[] {
  const scenesDir = path.join(root, 'scenes');
  let scenes;
  try {
    scenes = schedule.plan(scenesDir);
  } catch (err) {
    return [`读取镜头目录失败，无法校验 cast.beats 与角色 DNA：${(err as Error).message}`];
  }

  const problems: string[] = [];
  const beats: GlobalBeat[] = [];
  // 镜头全局起点走 schedule.startOffsets：正向的 am dialogue beats 用同一个
  // 函数把全局台词切成镜头本地节拍，两边同源，这条反向校验才是在验产物，
  // 而不是在验"两处各自累加的结果碰巧一致"。
  const offsets = schedule.startOffsets(scenes);
  scenes.forEach((s, i) => {
    if (s.cast === null) return;
    for (const beat of s.cast.beats ?? []) {
      beats.push({ speaker: beat.speaker, start: offsets[i] + beat.start, end: offsets[i] + beat.end });
    }
    for (const actor of s.cast.on_stage ?? []) {
      const dnaPath = path.join(s.directory, s.cast.pack_dir, actor.id, 'dna.md');
      if (!isRegular(dnaPath)) {
        problems.push(
          `镜头 ${s.id} 的角色 ${actor.id} 缺少 dna.md：${dnaPath} 不存在，` +
            '渲染提示词会引用这个路径，缺失时渲染 agent 读不到人设、只能自己编',
        );
      }
    }
  });

  // brief 原文写的是"合并覆盖"：同一说话人的两拍如果换算到全局时间后首尾相接（典型情况是一句台词
  // 按语义拆镜头，恰好切在这句话中间），拼起来才是完整的一行，不能拿单独一拍去跟整行比对包含关系——
  // 那样一句台词只要跨越镜头切点就必然被判成"没覆盖"，等于凭空新增了一条任何文档都没写过的
  // "不得在台词中间切镜头"的约束。
  const merged = mergeBeatsBySpeaker(beats);

  let uncovered = 0;
  for (const line of lines) {
    if (!lineCoveredByBeats(line, merged)) {
      problems.push(
        `dialogue.json 第 ${line.srtIndex} 行（说话人 ${line.speaker}，${formatFixed(line.startSeconds, 3)}–${formatFixed(line.endSeconds, 3)} 秒）没有被任何镜头的 cast.beats 覆盖`,
      );
      uncovered++;
    }
  }
  if (uncovered > 0) problems.push(beatsRecomputeHint);
  return problems;
}

/**
 * 有台词行未被覆盖时统一追加的一条出路。
 *
 * 这里曾经是一条名为 suspectCumulativeDrift 的启发式：未覆盖的行如果构成
 * "从某一行起一路延伸到最后一行"的后缀，就断言病因是镜头时长累计漂移。
 * 它有两个问题——其一，同样的指纹也会由"某个镜头压根没写 beats"产生，
 * 那时它把人支去改镜头时长，方向完全错了；其二，am dialogue beats 落地后
 * 正反两向都走 schedule.startOffsets，工具产出的节拍不可能因为漂移而对不上，
 * 剩下的未覆盖只会来自手写或过期的 beats。
 *
 * 换成一条无条件成立的提示：不论病因是漏拍、过期节拍还是时长写错，出路
 * 都是同一条——去跑重算命令，让 dialogue.json 重新当唯一真相源。
 */
export const beatsRecomputeHint =
  '以上未被覆盖的台词行不要逐行手改 beats：' +
  '确认各镜头的 duration_seconds 与配音一致、且有台词盖过的镜头都写了 cast 块之后，' +
  '运行 dialogue_beats()——它会按 ' +
  dialogue.DialogueRelPath +
  ' 重算全部镜头的 cast.beats';

/**
 * 按说话人分组，把同一说话人换算到全局时间后的区间按 start 排序，再合并相邻或首尾相接（容差内）的区间。
 * 跨镜头切点的一句台词会被拆成两个首尾相接的区间，必须先合并才能正确判断覆盖关系。
 */
function mergeBeatsBySpeaker(beats: readonly GlobalBeat[]): GlobalBeat[] {
  if (beats.length === 0) return [];
  const bySpeaker = new Map<string, GlobalBeat[]>();
  for (const b of beats) {
    const list = bySpeaker.get(b.speaker) ?? [];
    list.push({ ...b });
    bySpeaker.set(b.speaker, list);
  }
  const merged: GlobalBeat[] = [];
  // 遍历顺序确定性，便于测试与调试。
  for (const speaker of [...bySpeaker.keys()].sort(compareBytes)) {
    const list = bySpeaker.get(speaker)!.sort((a, b) => a.start - b.start);
    let current = list[0];
    for (const b of list.slice(1)) {
      if (b.start <= current.end + beatCoverageToleranceSeconds) {
        if (b.end > current.end) current.end = b.end;
        continue;
      }
      merged.push(current);
      current = b;
    }
    merged.push(current);
  }
  return merged;
}

/** 某一行对白是否被合并后的某个区间完整覆盖：同一说话人、且这个区间完整包住这一行。 */
function lineCoveredByBeats(line: Line, beats: readonly GlobalBeat[]): boolean {
  return beats.some(
    (beat) =>
      beat.speaker === line.speaker &&
      line.startSeconds >= beat.start - beatCoverageToleranceSeconds &&
      line.endSeconds <= beat.end + beatCoverageToleranceSeconds,
  );
}
