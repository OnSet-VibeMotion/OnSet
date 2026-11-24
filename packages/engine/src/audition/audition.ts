/**
 * 试镜：同一个镜头、同一份冻结输入，交给几位选手（渲染工具 + 模型）各渲染一遍，由人盲评。
 *
 * 一场试镜是项目里的 production/studio/auditions/<编号>/：audition.json 记选手、结果与评判，
 * 每位选手一个子目录（盲评标号 A、B、C……），里面是冻结的镜头输入与它渲染出的东西。
 * 放在 Studio 的状态目录里：不进每轮对话的快照（渲染器写的合成代码不该算成一轮的改动），
 * 也不是项目的镜头（镜头列表、文件归站都跳过它）。
 *
 * 盲评靠后端：评判之前 blindJSON 不给选手是谁、用了多少 token、跑了多久，界面拿不到就漏不出去。
 * 评判同时追加进用户级的 auditions.jsonl（recordVerdict）：谁赢了谁跨项目累积，后面按它提议学习关系。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectSkippedDirs } from '../fsutil';
import { compareBytes } from '../gojson';
import { features, freezeInput } from '../memory';
import {
  archiveAttempt,
  blockExtraInputDirs,
  DesignFile,
  frameSource,
  inputFiles,
  RecordFile as RecordFileName,
  type Scene,
} from '../scene';
import {
  type Adoption,
  type Audition,
  auditionDir,
  type Contestant,
  type ContestantStatus,
  type CreateOptions,
  contestantKey,
  Dir,
  type Entry,
  type ExamInfo,
  type ExamRole,
  entryLabel,
  File,
  MaxContestants,
  MinContestants,
  parseEntry,
  splitKey,
  toolKey,
  toSlash,
  type Verdict,
  type VerdictKind,
  VerdictKinds,
  type VoteInput,
} from './model';
import { applyAttempt, auditionToJSON, blindJSON, contestantScene, list, load, save, vote } from './store';
import { readVerdicts, recordVerdict, VerdictLogFile, type VerdictRecord } from './verdict';

export {
  type Adoption,
  type Audition,
  applyAttempt,
  auditionDir,
  auditionToJSON,
  blindJSON,
  type Contestant,
  type ContestantStatus,
  type CreateOptions,
  contestantKey,
  contestantScene,
  Dir,
  type Entry,
  type ExamInfo,
  type ExamRole,
  entryLabel,
  File,
  list,
  load,
  MaxContestants,
  MinContestants,
  parseEntry,
  readVerdicts,
  recordVerdict,
  save,
  splitKey,
  toolKey,
  type Verdict,
  type VerdictKind,
  VerdictKinds,
  VerdictLogFile,
  type VerdictRecord,
  type VoteInput,
  vote,
};

function slotName(i: number): string {
  return String.fromCharCode(65 + i);
}

/**
 * 镜头输入的摘要：声明过的输入文件（与指纹、冻结同一份清单）、就近的 frame.md 与扩展块要带的目录，按相对路径排序后连同内容一起算。
 * 按字节算：试镜比的是「这几份画面出自这份输入」，任何改动都该让采用停下来。
 */
export function inputDigest(sc: Scene): string {
  const files = new Map<string, string>();
  for (const rel of inputFiles(sc)) files.set(toSlash(rel), path.join(sc.directory, rel));
  const frame = frameSource(sc);
  if (frame) files.set('frame.md', path.join(frame.directory, frame.file));
  for (const rel of blockExtraInputDirs(sc)) {
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.set(toSlash(path.relative(sc.directory, full)), full);
      }
    };
    walk(path.join(sc.directory, rel));
  }
  const hash = crypto.createHash('sha256');
  for (const rel of [...files.keys()].sort(compareBytes)) {
    let body: Buffer;
    try {
      body = fs.readFileSync(files.get(rel)!);
    } catch {
      body = Buffer.from('');
      hash.update('missing:');
    }
    hash.update(rel + '\0' + String(body.length) + '\0');
    hash.update(body);
  }
  return hash.digest('hex');
}

function randomShuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 建一场试镜：给选手随机分标号、把镜头输入冻结进每位选手的目录、写 audition.json。
 * root 是项目根，sc 是项目里的镜头。
 */
export function create(root: string, sc: Scene, entries: readonly Entry[], opts: CreateOptions): Audition {
  if (entries.length < MinContestants) throw new Error(`试镜至少要 ${MinContestants} 位选手`);
  if (entries.length > MaxContestants) throw new Error(`试镜最多 ${MaxContestants} 位选手`);
  const seen = new Set<string>();
  for (const e of entries) {
    const key = [e.renderer, e.model, e.designer?.renderer ?? '', e.designer?.model ?? '', e.role ?? ''].join('\0');
    if (seen.has(key)) throw new Error(`选手重复：${entryLabel(e)}`);
    seen.add(key);
  }
  if (opts.exam) {
    const roles = entries.map((e) => e.role ?? '').sort();
    if (roles.join(',') !== 'control,reference,trial')
      throw new Error('人评考试要一份不带经验、一份带经验、一份老师作参照');
  }
  const sceneDir = path.relative(root, sc.directory);
  if (sceneDir.startsWith('..') || path.isAbsolute(sceneDir)) throw new Error('镜头不在项目里');
  const now = opts.now ?? new Date();
  let id = 'audition-' + stamp(now);
  for (let n = 2; fs.existsSync(auditionDir(root, id)); n++) id = 'audition-' + stamp(now) + '-' + n;
  const dir = auditionDir(root, id);
  // 人评考试：两份学生作品洗牌后分到 A、B，老师作参照固定是 R。
  const students = (opts.shuffle ?? randomShuffle)(entries.filter((e) => e.role !== 'reference'));
  const order = opts.exam ? [...students, ...entries.filter((e) => e.role === 'reference')] : students;
  const contestants: Contestant[] = order.map((e, i) => {
    const slot = e.role === 'reference' ? 'R' : slotName(i);
    const workdir = path.join(dir, slot);
    freezeInput(sc, workdir);
    return {
      slot,
      renderer: e.renderer,
      model: e.model,
      designer: e.designer?.renderer ?? '',
      designer_model: e.designer?.model ?? '',
      role: e.role ?? '',
      actual_model: '',
      workdir: toSlash(path.relative(root, workdir)),
      status: 'pending',
      outcome: '',
      output: '',
      seconds: 0,
      usage: null,
      problems: null,
      checks: null,
      error: '',
    };
  });
  const a: Audition = {
    id,
    created_at: now.toISOString(),
    scene_id: sc.id,
    scene_dir: toSlash(sceneDir),
    features: features(sc),
    with_memory: opts.withMemory,
    input_digest: inputDigest(sc),
    contestants,
    verdict: null,
    adopted: null,
    exam: opts.exam ? { ...opts.exam, applied: '' } : null,
  };
  save(root, a);
  return a;
}

// ---- 采用 ----

/**
 * 把一位选手渲染出的东西搬进项目里的镜头：先把镜头现有的产物与日志归档（与重渲染同一个归档函数），
 * 再拷入选手目录里除冻结输入以外的全部文件（产物、合成代码、日志、尝试记录）。
 * 渲染记录不拷：它按选手目录算，要由调用方按项目里的镜头重写（scene.json 的 renderer 也由调用方改）。
 *
 * 只采用评判过、产物合格的选手；镜头输入在试镜之后改过时拒绝——那几份画面已经不对应现在的镜头。
 */
export function adoptFiles(
  root: string,
  a: Audition,
  slot: string,
  target: Scene,
  now = new Date(),
): { contestant: Contestant; files: string[] } {
  if (a.verdict === null) throw new Error('先评判再采用：评判之前看不出选手是谁');
  const c = a.contestants.find((x) => x.slot === slot);
  if (c && c.role !== '') throw new Error('人评考试的作品不换进镜头：它只用来决定经验留不留');
  if (!c) throw new Error(`没有 ${slot} 这位选手`);
  if (c.outcome !== 'succeeded' || c.output === '') throw new Error(`${slot} 没有合格的产物，不能采用`);
  if (path.resolve(target.directory) !== path.resolve(root, a.scene_dir)) {
    throw new Error('试镜的镜头与要采用的镜头不是同一个');
  }
  if (inputDigest(target) !== a.input_digest) {
    throw new Error(`镜头 ${a.scene_id} 在试镜之后改过，这几份画面已经不对应现在的镜头；重新试镜`);
  }
  const source = contestantScene(root, c);
  // 不拷的是冻结进来的输入（按项目里的镜头算）；选手自己的设计稿（两段式）要跟着产物一起换进去。
  const skipFiles = new Set<string>([
    'scene.json',
    'frame.md',
    RecordFileName,
    ...inputFiles(target)
      .map(toSlash)
      .filter((f) => f !== DesignFile),
  ]);
  const skipDirs = blockExtraInputDirs(source).map(toSlash);
  archiveAttempt(target);
  const copied: string[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => compareBytes(x.name, y.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = toSlash(path.relative(source.directory, full));
      if (entry.isDirectory()) {
        if (ProjectSkippedDirs.has(entry.name) || skipDirs.some((d) => rel === d || rel.startsWith(d + '/'))) continue;
        walk(full);
        continue;
      }
      if (
        !entry.isFile() ||
        skipFiles.has(rel) ||
        entry.name.endsWith('.live.json') ||
        entry.name.startsWith('design-')
      ) {
        continue;
      }
      const dest = path.join(target.directory, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
      copied.push(rel);
    }
  };
  walk(source.directory);
  a.adopted = { slot, at: now.toISOString() };
  save(root, a);
  return { contestant: c, files: copied };
}
