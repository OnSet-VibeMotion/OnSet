/**
 * 向老师学：一条已确认的学习关系下，把「老师赢了学生」的几场试镜里两边的代码交给整理者，
 * 写成只给学生用的经验（applies_when 限定学生的渲染工具与模型，learned_from 写老师，checked_by 是 audition.judged）。
 * 经验进入试用，由人评考试（学生带与不带、老师作参照）决定留不留。
 *
 * 用的是记忆整理的同一个整理者（memory.Drafter）与同一套格式校验（memory.lint），
 * 但不写 consolidate 事件：那会挪动「上次整理」的时间，让下一次整理漏掉失败经历。
 */
import fs from 'node:fs';
import path from 'node:path';
import { goQuote } from '../gofmt';
import { compareBytes, marshalIndent } from '../gojson';
import * as memory from '../memory';
import { load as loadScene } from '../scene';
import { Dir, splitKey, type VerdictRecord } from './audition';
import type { Relation } from './learning';

/** 一次最多带几组对照：再多整理者读不过来。 */
export const MaxPairs = 4;

export interface LearnPair {
  audition: string;
  project: string;
  scene_id: string;
  features: string[];
  note: string;
  teacher_dir: string;
  student_dir: string;
}

export interface LearnResult {
  run: string;
  workdir: string;
  pairs: LearnPair[];
  accepted: string[];
  rejected: Record<string, string[]>;
}

/** 已经学过的试镜：学生、老师都对得上的经验在 from_auditions 里记过的。 */
function learned(existing: readonly memory.Memory[], r: Relation): Set<string> {
  const { renderer, model } = splitKey(r.student);
  const out = new Set<string>();
  for (const m of existing) {
    if (!(m.learned_from ?? []).includes(r.teacher)) continue;
    if (!m.applies_when.renderers.includes(renderer)) continue;
    if (model !== '' && !m.applies_when.models.includes(model)) continue;
    for (const id of m.from_auditions ?? []) out.add(id);
  }
  return out;
}

/** 老师赢了学生、两边的目录都还在、还没学过的试镜，新的在前，最多 MaxPairs 组。 */
export function learnPairs(rows: readonly VerdictRecord[], r: Relation, existing: readonly memory.Memory[]): LearnPair[] {
  const done = learned(existing, r);
  const out: LearnPair[] = [];
  for (const v of [...rows].sort((a, b) => compareBytes(b.at, a.at))) {
    if (v.purpose === 'exam' || v.kind !== 'winner' || v.winner !== r.teacher || v.project_dir === '' || done.has(v.audition)) continue;
    if (r.features.length > 0 && !r.features.some((f) => v.features.includes(f))) continue;
    const teacher = v.contestants.find((c) => c.slot === v.winner_slot);
    const { renderer, model } = splitKey(r.student);
    const student = v.contestants.find((c) => c.key !== '' && !c.key.includes('<') && c.renderer === renderer && (model === '' || memory.modelMatches(c.model, [model])));
    if (!teacher || !student) continue;
    const base = path.join(v.project_dir, Dir, v.audition);
    const pair: LearnPair = {
      audition: v.audition,
      project: v.project,
      scene_id: v.scene_id,
      features: v.features,
      note: v.note,
      teacher_dir: path.join(base, teacher.slot),
      student_dir: path.join(base, student.slot),
    };
    if (!fs.existsSync(pair.teacher_dir) || !fs.existsSync(pair.student_dir)) continue;
    out.push(pair);
    if (out.length >= MaxPairs) break;
  }
  return out;
}

const keptExtensions = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.svg', '.md', '.ts']);

function copyCode(src: string, dst: string): void {
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !['attempts', 'node_modules', 'fonts'].includes(entry.name)) walk(full);
        continue;
      }
      const name = entry.name;
      if (!entry.isFile() || name.startsWith('.') || name.startsWith('render-') || name.startsWith('design-') || name.endsWith('.attempt.json') || name === 'onset-scene.js') continue;
      if (!keptExtensions.has(path.extname(name).toLowerCase())) continue;
      const size = fs.statSync(full).size;
      if (size > 200 * 1024 || total + size > 1024 * 1024) continue;
      const target = path.join(dst, path.relative(src, full));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(full, target);
      total += size;
    }
  };
  walk(src);
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** 交给整理者的说明。 */
export function learnBrief(r: Relation, pairs: readonly LearnPair[], existing: readonly memory.Memory[]): string {
  const { renderer, model } = splitKey(r.student);
  let b = `# 向更好的那一方学

同一个镜头、同一份镜头说明，两位制作者各做了一遍，人看过之后判定「老师」那一份更好。下面有 ${pairs.length} 组这样的对照，
每组在 pairs/<编号>/ 下：teacher/ 是更好的那一份的合成代码，student/ 是另一份，note.md 是镜头说明与人的评语。
你要做的是读懂老师那一份好在哪、学生那一份差在哪，把差别写成学生以后能照着做的经验。

只在当前目录的 drafts/lessons/ 下写文件，一条经验一个 <name>.md。不要改动其他文件，不要渲染，不要运行其他命令。写完即结束。

## 文件格式

\`\`\`markdown
---
name: stagger-entrances-on-beat
description: 元素入场错开并卡在口播的重音上，不要所有元素同时淡入
status: trial
applies_when:
  features: [chart]      # 只对某类镜头成立时写；适用于所有镜头时省略 features
  keywords: [入场, 节奏]
checked_by: [audition.judged]
from_auditions: [audition-20261114-153012]
---

元素入场要错开，每个元素的入场落在它对应那句口播的重音上，入场后留足停顿再进下一个。

反例：
    gsap.from('.item', { opacity: 0, duration: 0.5 });   // 所有元素同时淡入

正例：
    tl.from('.item-1', { y: 40, opacity: 0, ease: 'power3.out' }, cue('第一个'))
      .from('.item-2', { y: 40, opacity: 0, ease: 'power3.out' }, cue('第二个'));
\`\`\`

## 硬性要求（不满足的草稿会被直接拒收）

- name 用小写字母、数字与连字符，与文件名一致，不得与已有记忆重名；description 不超过 80 字，正文不超过 600 字。
- checked_by 写 [audition.judged]（「人在试镜里判的」）；from_auditions 只能取下面各组的试镜编号，写明这条经验从哪几组来。
- 正文同时给出「反例」（学生那种做法）与「正例」（老师那种做法），正例尽量取自老师的代码。
- 写成可迁移的做法：构图、节奏、缓动、层次、留白、信息怎样一步步展开、代码怎样组织才稳定……不要写成只对这个镜头成立的话。
- 不得出现渲染工具名、模型名或厂商名，不得照抄镜头文案、写镜头编号或素材文件名。适用范围由 onset 写进 applies_when，你不用写 renderers / models。
- applies_when.features 只能取下面「镜头特征」里的值。
- 每个镜头最多注入 3 条经验：只写最能拉开差距的一两条，宁可少写。几组对照说的是同一件事时合成一条。
- 已有的同类经验说的是同一件事时，写成修订：换新名字，加 revises: <旧名>，正文写完整的新版本。

`;
  b += memory.lessonWritingGuide();
  b += '## 镜头特征\n\n';
  const features = memory.featureDescriptions();
  for (const name of Object.keys(features).sort(compareBytes)) b += `- \`${name}\`：${features[name]}\n`;
  b += '\n## 学生已有的、向这位老师学来的经验\n\n';
  let count = 0;
  for (const m of existing) {
    if (m.kind !== memory.KindLesson || (m.status !== memory.StatusActive && m.status !== memory.StatusTrial)) continue;
    if (!(m.learned_from ?? []).includes(r.teacher) || !m.applies_when.renderers.includes(renderer)) continue;
    if (model !== '' && !m.applies_when.models.includes(model)) continue;
    count++;
    b += `### ${m.name}（${m.status}）\n\n${m.description}\n\n${m.body}\n\n`;
  }
  if (count === 0) b += '（暂无）\n\n';
  b += '## 对照\n\n';
  pairs.forEach((p, i) => {
    b += `- pairs/${String(i + 1).padStart(2, '0')}/：试镜 ${p.audition}${p.features.length > 0 ? `，题材 ${p.features.join('、')}` : ''}${p.note ? `，人的评语「${p.note}」` : ''}\n`;
  });
  return b;
}

export interface LearnOptions {
  relation: Relation;
  rows: readonly VerdictRecord[];
  drafter: memory.Drafter;
  signal?: AbortSignal;
  now?: Date;
}

/** 收下草稿：强制写好范围与出处，过格式校验；only 非空时只收这几份（改稿后的第二轮）。 */
function ingest(store: memory.Store, r: Relation, dir: string, allowed: Set<string>, texts: string[], result: LearnResult, only: Set<string> | null): void {
  const { renderer, model } = splitKey(r.student);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, 'lessons'), { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const label = 'lessons/' + entry.name;
    if (only !== null && !only.has(label)) continue;
    let m: memory.Memory;
    try {
      m = memory.parse(memory.KindLesson, fs.readFileSync(path.join(dir, 'lessons', entry.name)));
    } catch (err) {
      result.rejected[label] = [(err as Error).message];
      continue;
    }
    m.status = memory.StatusTrial;
    m.verified_by = [];
    m.rejected_reason = '';
    m.checked_by = [memory.CheckerAudition];
    m.applies_when = { ...m.applies_when, renderers: [renderer], models: model === '' ? [] : [model] };
    m.learned_from = [r.teacher];
    const from = (m.from_auditions ?? []).filter((id) => allowed.has(id));
    m.from_auditions = from.length > 0 ? from : [...allowed].sort(compareBytes);
    const existing = store.memories().memories;
    const problems = memory.lint(m, { existing, sceneTexts: texts });
    if (m.name + '.md' !== entry.name) problems.push(`name ${goQuote(m.name)} 与文件名不一致`);
    if (existing.some((o) => o.name === m.name)) problems.push(`记忆 ${m.name} 已存在；修订请换一个新名字并写 revises: ${m.name}`);
    for (const id of m.from_auditions ?? []) if (!allowed.has(id)) problems.push(`from_auditions 引用了不在这次对照里的试镜：${id}`);
    if (problems.length > 0) {
      result.rejected[label] = problems;
      store.log({ time: '', type: memory.EventDraftReject, summary: `草稿 ${label} 未通过格式校验`, detail: { draft: label, problems } });
      continue;
    }
    store.write(m);
    result.accepted.push(m.name);
    store.log({
      time: '',
      type: memory.EventTrial,
      summary: `向 ${r.teacher} 学的经验 ${m.name} 进入试用：${m.description}`,
      detail: { memory: m.name, kind: m.kind, learned_from: r.teacher, student: r.student, from_auditions: m.from_auditions, revises: m.revises },
    });
  }
  result.accepted.sort(compareBytes);
}

export async function learn(store: memory.Store, opts: LearnOptions): Promise<LearnResult> {
  const r = opts.relation;
  const existing = store.memories().memories;
  const pairs = learnPairs(opts.rows, r, existing);
  if (pairs.length === 0) throw new Error(`没有可学的对照：${r.teacher} 赢过 ${r.student}、两边的画面还在、还没学过的试镜一场都没有`);
  const run = 'learn-' + stamp(opts.now ?? new Date());
  const workdir = path.join(store.dir, 'learn', run);
  fs.mkdirSync(path.join(workdir, 'drafts', 'lessons'), { recursive: true });
  const texts: string[] = [];
  pairs.forEach((p, i) => {
    const dir = path.join(workdir, 'pairs', String(i + 1).padStart(2, '0'));
    copyCode(p.teacher_dir, path.join(dir, 'teacher'));
    copyCode(p.student_dir, path.join(dir, 'student'));
    let text = '';
    try {
      text = loadScene(p.teacher_dir).text;
    } catch {
      text = '';
    }
    texts.push(text);
    let prompt = '';
    try {
      prompt = fs.readFileSync(path.join(p.teacher_dir, 'prompt.md'), 'utf8');
    } catch {
      prompt = '';
    }
    fs.writeFileSync(
      path.join(dir, 'note.md'),
      `# 试镜 ${p.audition}\n\n镜头口播：${text}\n\n题材：${p.features.join('、') || '（无）'}\n\n人的评语：${p.note || '（没写）'}\n\n## 镜头说明（prompt.md）\n\n${prompt}\n`,
    );
  });
  const result: LearnResult = { run, workdir, pairs, accepted: [], rejected: {} };
  const brief = learnBrief(r, pairs, existing);
  fs.writeFileSync(path.join(workdir, 'brief.md'), brief);
  fs.writeFileSync(path.join(workdir, 'pairs.json'), marshalIndent(pairs) + '\n');
  await opts.drafter(workdir, brief, opts.signal);
  const allowed = new Set(pairs.map((p) => p.audition));
  const drafts = path.join(workdir, 'drafts');
  ingest(store, r, drafts, allowed, texts, result, null);
  // 被拒的交回去改一稿，与记忆整理同一个做法。
  const first = Object.keys(result.rejected).sort(compareBytes);
  if (first.length > 0) {
    let b = '# 改稿：下面的草稿没有通过格式校验\n\n只原地改 drafts/ 下列出的这几份，文件名不变；不要动别的文件、不要新增。要求见 brief.md。\n\n';
    for (const label of first) b += `## drafts/${label}\n\n${result.rejected[label].map((x) => `- ${x}\n`).join('')}\n`;
    fs.writeFileSync(path.join(workdir, 'revise.md'), b);
    try {
      await opts.drafter(workdir, b, opts.signal);
      for (const label of first) delete result.rejected[label];
      ingest(store, r, drafts, allowed, texts, result, new Set(first));
    } catch {
      // 改稿没跑成：第一轮的结果照旧。
    }
  }
  return result;
}
