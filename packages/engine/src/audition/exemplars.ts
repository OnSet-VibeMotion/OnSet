/**
 * 范例库：人在试镜里选中的那一份的合成代码，存进记忆库目录的 exemplars/，带上它出自谁（「渲染工具/模型」）
 * 与镜头题材。学生渲染时，按已确认的学习关系挑老师在同类镜头上的范例，把目录交给渲染器读来学
 * （scene.ExemplarRecall）。只收评判里的胜者：范例代表的是人的判断，不是机器的。
 *
 * 一场试镜只存一份；改判换了胜者就换掉，改成差不多或都不行就删掉。人评考试的作品不进范例库。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, ProjectSkippedDirs } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import type { ExemplarRecall } from '../scene';
import { contestantKey, type Audition } from './audition';
import { loadLearning, studentMatches } from './learning';

export const ExemplarsDir = 'exemplars';
export const ExemplarMeta = 'exemplar.json';
/** 每个镜头最多带几份范例：多了渲染器读不过来，也互相打架。 */
export const MaxExemplars = 2;

const keptExtensions = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.svg', '.md', '.ts']);
const fileLimit = 200 * 1024;
const totalLimit = 1024 * 1024;

export interface Exemplar {
  id: string;
  at: string;
  /** 出自谁：contestantKey。 */
  key: string;
  project: string;
  audition: string;
  scene_id: string;
  features: string[];
  /** 镜头口播的开头，给人认是哪个镜头。 */
  text: string;
  note: string;
  /** 存下的全部文件的摘要：进渲染指纹（范例换了，带它的镜头说得出为什么 Stale）。 */
  digest: string;
  files: string[];
  /** 范例目录（读出来时填）。 */
  dir?: string;
}

function root(memDir: string): string {
  return path.join(memDir, ExemplarsDir);
}

function exemplarID(project: string, audition: string): string {
  return (project.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project') + '--' + audition;
}

/** 把一位选手目录里的合成代码拷进 dst：只拷文本源码，跳过日志、尝试记录、渲染记录与大文件。 */
function copySources(src: string, dst: string): { files: string[]; digest: string } {
  const files: string[] = [];
  const hash = crypto.createHash('sha256');
  let total = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ProjectSkippedDirs.has(entry.name) && !['fonts', 'node_modules'].includes(entry.name) && !entry.name.startsWith('.')) walk(full);
        continue;
      }
      const name = entry.name;
      if (!entry.isFile() || name.startsWith('.') || name.endsWith('.attempt.json') || name.startsWith('render-') || name.startsWith('design-') || name === 'onset-scene.js') continue;
      if (!keptExtensions.has(path.extname(name).toLowerCase())) continue;
      const size = fs.statSync(full).size;
      if (size > fileLimit || total + size > totalLimit) continue;
      const body = fs.readFileSync(full);
      const rel = path.relative(src, full).split(path.sep).join('/');
      fs.mkdirSync(path.dirname(path.join(dst, rel)), { recursive: true });
      fs.writeFileSync(path.join(dst, rel), body, { mode: 0o644 });
      hash.update(rel + '\0' + body.length + '\0');
      hash.update(body);
      files.push(rel);
      total += size;
    }
  };
  walk(src);
  return { files, digest: hash.digest('hex') };
}

/**
 * 评判之后同步范例库：胜者的代码存一份（已存的同一场试镜先删掉），没有胜者就删掉这一场的。
 * projectRoot 是试镜所在的项目，project 是它在记录里的名字（memory.projectName）。
 */
export function syncExemplar(memDir: string, projectRoot: string, project: string, a: Audition, sceneText = ''): Exemplar | null {
  const dir = path.join(root(memDir), exemplarID(project, a.id));
  fs.rmSync(dir, { recursive: true, force: true });
  if (a.exam || a.verdict === null || a.verdict.kind !== 'winner') return null;
  const c = a.contestants.find((x) => x.slot === a.verdict!.winner);
  if (!c || c.outcome !== 'succeeded') return null;
  const { files, digest } = copySources(path.join(projectRoot, c.workdir), path.join(dir, 'code'));
  if (files.length === 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const e: Exemplar = {
    id: exemplarID(project, a.id),
    at: a.verdict.at,
    key: contestantKey(c),
    project,
    audition: a.id,
    scene_id: a.scene_id,
    features: a.features,
    text: [...sceneText].slice(0, 120).join(''),
    note: a.verdict.note,
    digest,
    files,
  };
  atomicWrite(path.join(dir, ExemplarMeta), marshalIndent(e) + '\n');
  return { ...e, dir };
}

/** 范例库里的全部范例，新的在前。 */
export function listExemplars(memDir: string): Exemplar[] {
  let names: string[];
  try {
    names = fs.readdirSync(root(memDir));
  } catch {
    return [];
  }
  const out: Exemplar[] = [];
  for (const name of names) {
    const dir = path.join(root(memDir), name);
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, ExemplarMeta), 'utf8')) as Exemplar;
      if (typeof e.key === 'string' && typeof e.digest === 'string') out.push({ ...e, features: e.features ?? [], dir });
    } catch {
      // 跳过。
    }
  }
  return out.sort((a, b) => compareBytes(b.at, a.at) || compareBytes(a.id, b.id));
}

export interface ExemplarQuery {
  renderer: string;
  model: string;
  features: readonly string[];
  /** 正在渲染的镜头：同一个项目同一个镜头的范例不给（那等于抄答案）。 */
  project: string;
  sceneID: string;
}

/**
 * 给学生挑范例：它有已确认的学习关系时，取老师在同类镜头上被人选中的那几份，按共同题材多少、再按新旧排，最多 MaxExemplars 份。
 * 没有关系、没有范例时返回 null，提示词与指纹都不变。
 */
export function pickExemplars(memDir: string, q: ExemplarQuery): ExemplarRecall | null {
  const relations = loadLearning(memDir).relations.filter((r) => studentMatches(r.student, q.renderer, q.model));
  if (relations.length === 0) return null;
  const scored: { e: Exemplar; overlap: number }[] = [];
  for (const e of listExemplars(memDir)) {
    if (e.project === q.project && e.scene_id === q.sceneID) continue;
    const overlap = e.features.filter((f) => q.features.includes(f)).length;
    const ok = relations.some((r) => r.teacher === e.key && (r.features.length === 0 || r.features.some((f) => q.features.includes(f) && e.features.includes(f))));
    if (ok) scored.push({ e, overlap });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.overlap - a.overlap || compareBytes(b.e.at, a.e.at));
  const chosen = scored.slice(0, MaxExemplars).map((x) => x.e);
  let section =
    '\n参考范例（按你在这类镜头上的学习关系挑的，与上面的强制要求冲突时以上面为准）：\n' +
    '下面几个目录是同类镜头里被人选为更好的那一份的完整合成代码。开工前读一读，学它的构图、节奏、动效与代码组织；\n' +
    '不要照抄它的文案、素材、配色与镜头内容——本镜头讲的是自己的东西。\n';
  for (const e of chosen) {
    section += `- ${path.join(e.dir!, 'code')}${e.features.length > 0 ? `（题材：${e.features.join('、')}）` : ''}${e.note ? `；选中它的理由：${e.note}` : ''}\n`;
  }
  const digest = crypto
    .createHash('sha256')
    .update(chosen.map((e) => e.id + ':' + e.digest).join('\n'))
    .digest('hex');
  return { names: chosen.map((e) => e.id), section, digest, dirs: chosen.map((e) => path.join(e.dir!, 'code')) };
}
