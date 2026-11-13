/**
 * 编排工具与客户端界面之间的两条通道。移植自 internal/studio/view.go（am studio show 与客户端后端共用）。
 *
 * - 编排工具 → 界面：一轮对话里编排工具运行 am studio show <页面> [对象]，把一份请求写进这一轮的收件目录
 *   （ViewInboxEnv）；客户端在这一轮进行中轮询收件目录，译成 view 事件，界面切到那一页。写文件而不是发 HTTP：
 *   codex 的沙箱默认断网，连本机端口也连不上，项目目录却总是可写的。
 * - 界面 → 编排工具：界面发消息时带上用户此刻在看的页面（ViewState），客户端把它写进这一轮的提示词。
 */
import fs from 'node:fs';
import path from 'node:path';
import { marshal } from '../gojson';
import { goQuote } from '../gofmt';

/** 这一轮的收件目录；不在客户端里运行时没有它，am studio show 什么都不做。 */
export const ViewInboxEnv = 'AM_STUDIO_INBOX';
/** 客户端打开的项目根目录，am studio show 据此校验镜头与文件。 */
export const ViewProjectEnv = 'AM_STUDIO_PROJECT';
/** 会话事件里的切页请求。 */
export const KindView = 'view';
/** 一轮进行中查看收件目录的间隔（毫秒）。 */
export const ViewPollInterval = 300;

/** 界面上能被切到的一页。target：scene 要镜头编号，scene? 可以给，file 要项目里的相对路径。 */
export interface ViewPage {
  id: string;
  label: string;
  target: '' | 'scene' | 'scene?' | 'file';
}

/** 与界面 Preview.tsx 的标签一一对应。 */
export const ViewPages: readonly ViewPage[] = [
  { id: 'script', label: '口播稿', target: '' },
  { id: 'scene', label: '镜头', target: 'scene' },
  { id: 'compose', label: '合成', target: 'scene?' },
  { id: 'final', label: '成片', target: '' },
  { id: 'style', label: '风格', target: '' },
  { id: 'review', label: '复查', target: '' },
  { id: 'publish', label: '发布', target: '' },
  { id: 'memory', label: '记忆', target: '' },
  { id: 'file', label: '文件', target: 'file' },
];

export function viewPage(id: string): ViewPage | undefined {
  return ViewPages.find((page) => page.id === id);
}

/** 一次切页请求：编排工具写，界面执行。字段顺序与 Go 的 JSON tag 一致。 */
export interface ViewRequest {
  page: string;
  target?: string;
  /** 给用户的一句话，显示在对话里，说明为什么要看这一页。 */
  note?: string;
}

/** 用户此刻在界面上看的位置，随消息发来。 */
export interface ViewState {
  page?: string;
  scene?: string;
  file?: string;
}

/** 把用户在看的位置写成一句话，附在发给编排工具的消息后面。 */
export function describeView(v: ViewState | null | undefined): string {
  if (!v || !v.page) return '';
  const page = viewPage(v.page);
  if (!page) return '';
  let where = '「' + page.label + '」页';
  if (v.page === 'file' && v.file) where += '，文件 ' + v.file;
  else if ((v.page === 'scene' || v.page === 'compose' || v.page === 'memory') && v.scene) where += '，镜头 ' + v.scene;
  return '（用户发这条消息时，Studio 网页上开着' + where + '。）';
}

/** 项目里的镜头编号，按 Go filepath.WalkDir 的词法顺序；渲染记忆考场里的镜头副本不算。 */
export function sceneIDs(root: string): string[] {
  const out: string[] = [];
  const exams = path.join(root, 'production', 'memory-exams');
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== exams) walk(full);
      } else if (entry.name === 'scene.json') {
        try {
          const v = JSON.parse(fs.readFileSync(full, 'utf8')) as { id?: unknown };
          if (typeof v.id === 'string' && v.id !== '') out.push(v.id);
        } catch {
          // 读不懂的 scene.json 不算镜头。
        }
      }
    }
  };
  walk(root);
  return out;
}

/** 检查页面与对象：镜头要存在，文件要在项目里且不是 .env。返回规范化后的请求。 */
export function validateViewRequest(project: string, req: ViewRequest): ViewRequest {
  const out: ViewRequest = { ...req };
  const page = viewPage(req.page);
  if (!page) throw new Error(`没有页面 ${goQuote(req.page)}（可选：${ViewPages.map((p) => p.id).join('、')}）`);
  out.target = (req.target ?? '').trim();
  switch (page.target) {
    case 'scene':
    case 'scene?': {
      if (out.target === '') {
        if (page.target === 'scene') throw new Error(`${page.label} 页要给镜头编号：am studio show ${page.id} <镜头编号>`);
        break;
      }
      if (project === '') break;
      const ids = sceneIDs(project);
      if (!ids.includes(out.target)) throw new Error(`项目里没有镜头 ${goQuote(out.target)}（有：${ids.join('、')}）`);
      break;
    }
    case 'file': {
      if (out.target === '') throw new Error('文件页要给项目里的相对路径：am studio show file <路径>');
      if (project !== '') {
        let rel = out.target;
        if (path.isAbsolute(rel)) rel = path.relative(project, rel);
        rel = path.normalize(rel).split(path.sep).join('/');
        if (rel === '..' || rel.startsWith('../') || path.posix.basename(rel) === '.env') throw new Error(`只能打开项目里的文件：${out.target}`);
        if (!fs.existsSync(path.join(project, rel))) throw new Error(`项目里没有文件 ${rel}`);
        out.target = rel;
      }
      break;
    }
    default:
      if (out.target !== '') throw new Error(`${page.label} 页不带对象`);
  }
  if (out.target === '') delete out.target;
  return out;
}

let lastStamp = 0n;

/**
 * 「纳秒时间戳」：毫秒时间拼上 hrtime 的低位。hrtime 的低位在同一毫秒里会回绕，直接拼会让同一毫秒里
 * 先写的请求排到后面（Go 的 UnixNano 是单调的），所以保证同一进程里严格递增。
 */
function nextStamp(): bigint {
  let n = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  if (n <= lastStamp) n = lastStamp + 1n;
  lastStamp = n;
  return n;
}

/**
 * 把请求放进这一轮的收件目录。不在客户端里（没有收件目录）时返回 false。页面写错照样抛错：
 * 编排工具在 am run 里也会照着提示词调用，写错要让它知道。
 */
export function writeViewRequest(env: Record<string, string | undefined>, req: ViewRequest): boolean {
  const inbox = env[ViewInboxEnv] ?? '';
  const valid = validateViewRequest(env[ViewProjectEnv] ?? '', req);
  if (inbox === '') return false;
  fs.mkdirSync(inbox, { recursive: true, mode: 0o755 });
  const body = marshal({ page: valid.page, target: valid.target || undefined, note: valid.note || undefined });
  // 先写临时名再改名，轮询时不会读到写了一半的文件。文件名是纳秒时间戳，补零到 20 位以便按名字排序。
  const name = String(nextStamp()).padStart(20, '0');
  const tmp = path.join(inbox, '.' + name + '.tmp');
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, path.join(inbox, name + '.json'));
  return true;
}

/** 一轮对话的收件目录，在客户端状态目录里（不进快照）。 */
export function viewInbox(stateRoot: string, turnID: string): string {
  return path.join(stateRoot, 'inbox', turnID);
}

/** 按写入顺序读出并删除收件目录里的请求；读不懂的直接丢掉。 */
export function drainViewInbox(dir: string): ViewRequest[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const out: ViewRequest[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let body: string | undefined;
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      body = undefined;
    }
    fs.rmSync(file, { force: true });
    try {
      const req = JSON.parse(body ?? '') as ViewRequest;
      if (typeof req.page === 'string' && viewPage(req.page)) out.push(req);
    } catch {
      // 读不懂的丢掉。
    }
  }
  return out;
}

/** 写进对话约定（studioInteraction）的一条：怎样把用户带到某一页。 */
export function viewInteraction(): string {
  const pages = ViewPages.map((page) => {
    let item = page.id + '（' + page.label;
    if (page.target === 'scene') item += '，后面跟镜头编号';
    else if (page.target === 'scene?') item += '，可以跟镜头编号';
    else if (page.target === 'file') item += '，后面跟项目里的相对路径';
    return item + '）';
  });
  return (
    '- 要用户看某样东西时，运行 am studio show <页面> [对象] [--note "一句说明"]，网页会直接切到那一页，比在回复里贴大段内容或让用户自己去找好。页面：' +
    pages.join('、') +
    '。例如口播稿写好、请用户审稿时运行 am studio show script --note "口播稿写好了，请看一遍"；某个镜头渲染完请用户看效果时运行 am studio show scene scene-003。不要连续切来切去，一次只把用户带到眼下最该看的那一页。\n' +
    '- 用户的消息后面可能附一句「用户发这条消息时，Studio 网页上开着……」，说的是用户正在看的页面；用户说「这个镜头」「这段」时指的就是那里。'
  );
}
