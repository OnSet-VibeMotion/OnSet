/**
 * 编排工具与客户端界面之间的两条通道（onset studio show 与客户端后端共用）。
 *
 * - 编排工具 → 界面：一轮对话里编排工具运行 onset studio show <页面> [对象]，把一份请求写进这一轮的收件目录
 *   （ViewInboxEnv）；客户端在这一轮进行中轮询收件目录，译成 view 事件，界面切到那一页。写文件而不是发 HTTP：
 *   codex 的沙箱默认断网，连本机端口也连不上，项目目录却总是可写的。
 * - 界面 → 编排工具：界面发消息时带上用户此刻在看的页面（ViewState），客户端把它写进这一轮的提示词。
 */
import fs from 'node:fs';
import path from 'node:path';
import { marshal } from '../gojson';
import { goQuote } from '../gofmt';
import * as plugin from '../plugin';

/** 这一轮的收件目录；不在客户端里运行时没有它，onset studio show 什么都不做。 */
export const ViewInboxEnv = 'ONSET_STUDIO_INBOX';
/** 客户端打开的项目根目录，onset studio show 据此校验镜头与文件。 */
export const ViewProjectEnv = 'ONSET_STUDIO_PROJECT';
/** 会话事件里的切页请求。 */
export const KindView = 'view';
/** 一轮进行中查看收件目录的间隔（毫秒）。 */
export const ViewPollInterval = 300;

/**
 * 界面上能被切到的一页。target：scene 要镜头编号，scene? 可以给，file 要项目里的相对路径。
 * slot：第三方插件能把页面嵌进这一页（清单 slots 的 at）。
 */
export interface ViewPage {
  id: string;
  label: string;
  target: '' | 'scene' | 'scene?' | 'file';
  slot?: boolean;
}

/**
 * 宿主自己的页面。内置插件在 apply 里登记的页面（例如发布）按各自的 after 插进来，全部的页面用 viewPages()。
 * 合起来与界面 Preview.tsx 的标签一一对应。
 */
export const ViewPages: readonly ViewPage[] = [
  { id: 'progress', slot: true, label: '制作路线', target: '' },
  { id: 'script', slot: true, label: '口播稿', target: '' },
  { id: 'storyboard', slot: true, label: '分镜', target: '' },
  { id: 'scene', slot: true, label: '镜头', target: 'scene' },
  { id: 'compose', label: '合成', target: 'scene?' },
  { id: 'final', slot: true, label: '成片', target: '' },
  { id: 'style', label: '风格', target: '' },
  { id: 'voice', label: '音色', target: '' },
  { id: 'review', label: '复查', target: '' },
  { id: 'memory', label: '记忆', target: '' },
  { id: 'evidence', label: '进化', target: '' },
  { id: 'audition', label: '试镜', target: 'scene?' },
  { id: 'file', label: '文件', target: 'file' },
];

/** 全部页面：宿主的加上内置插件登记的（插在 after 那一页后面，找不到时接在最后）。 */
export function viewPages(): ViewPage[] {
  const out: ViewPage[] = [...ViewPages];
  for (const { value: p } of plugin.pluginPages()) {
    const at = out.findIndex((x) => x.id === p.after);
    out.splice(at < 0 ? out.length : at + 1, 0, { id: p.id, label: p.label, target: p.target, ...(p.slot ? { slot: true } : {}) });
  }
  return out;
}

/** 第三方插件能嵌小窗的页面（清单 slots 的 at 取值）：页面表里标了 slot 的，宿主的与内置插件登记的。 */
export function slotPages(): string[] {
  return viewPages()
    .filter((p) => p.slot)
    .map((p) => p.id);
}

export function viewPage(id: string): ViewPage | undefined {
  return viewPages().find((page) => page.id === id);
}

/** 一次切页请求：编排工具写，界面执行。字段顺序与 Go 的 JSON tag 一致。 */
export interface ViewRequest {
  /** 要切到的页面；只标步骤（studio_step）时为空。 */
  page: string;
  target?: string;
  /** 给用户的一句话，显示在对话里，说明为什么要看这一页。 */
  note?: string;
  /** 整片制作现在到了哪一步（StepIDs），顶栏的步骤上标出来；不切页。 */
  step?: string;
  /**
   * 用户在对话里确认了审核关卡（studio_confirm）：said 是用户的原话，gate 是关卡 id（空是路线上在等确认的那个）。
   * 不切页；后端核对原话确实出自这一轮用户的话才记下。
   */
  confirm?: { said: string; gate?: string };
}

/** 顶栏的一个步骤：id、名字、写给编排工具的一句说明；flow 是只有哪个流程用得上（内置插件登记的）。 */
export interface Step {
  id: string;
  label: string;
  hint: string;
  flow?: string;
}

/** 宿主自己的顶栏步骤（界面 Preview.tsx 的 stepTabs）。内置插件登记的步骤（ctx.step）见 steps。 */
const hostSteps: readonly Step[] = [
  { id: 'script', label: '口播稿', hint: '口播稿：整理、审稿、配音、对齐' },
  { id: 'storyboard', label: '分镜', hint: '分镜：处理方案、分镜计划、镜头画面描述、等用户确认分镜' },
  { id: 'scene', label: '镜头', hint: '镜头：渲染与修改镜头' },
  { id: 'final', label: '成片', hint: '成片：拼接、配乐混音、复查、试听' },
  { id: 'publish', label: '发布', hint: '发布：封面与发布信息' },
];

/** 全部步骤：宿主的加上内置插件登记的（插在 before 那一步前面，找不到时接在最后）。 */
export function steps(): Step[] {
  const out: Step[] = [...hostSteps];
  for (const { value: st } of plugin.pluginSteps()) {
    const at = st.before ? out.findIndex((x) => x.id === st.before) : -1;
    out.splice(at < 0 ? out.length : at, 0, { id: st.id, label: st.label, hint: st.hint, ...(st.flow ? { flow: st.flow } : {}) });
  }
  return out;
}

/** 顶栏的制作步骤（studio_step 能标的）：宿主的加上内置插件登记的（例如卡点项目的第一步 beat）。 */
export function stepIDs(): string[] {
  return steps().map((x) => x.id);
}

/**
 * 有专门页面的项目文件：编排工具要用户看它们时，切到那一页，不切到文件页显示原文。
 * 镜头目录里的文件切到那个镜头（合成代码 index.html 切到合成页）。返回 null 时照常开文件页。
 */
export function dedicatedPage(project: string, rel: string): { page: string; target?: string } | null {
  switch (rel) {
    case 'production/script-final.md':
      return { page: 'script' };
    case 'production/scene-plan.json':
    case 'production/scene-plan.md':
    case 'production/treatment.md':
      return { page: 'storyboard' };
    case 'final.mp4':
    case 'production/final.mp4':
    case 'production/audio/candidate.mp4':
    case 'production/silent-master.mp4':
      return { page: 'final' };
  }
  // 内置插件登记的页面声明的专门文件（例如发布页的 publish.md）。
  const owned = plugin.pluginPages().find(({ value }) => value.files?.includes(rel));
  if (owned) return { page: owned.value.id };
  if (project === '') return null;
  // 从文件所在目录往上找最近的 scene.json，到项目根为止。
  let dir = path.posix.dirname(rel);
  while (dir !== '.' && dir !== '/' && dir !== '') {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(project, dir, 'scene.json'), 'utf8')) as { id?: unknown };
      if (typeof v.id === 'string' && v.id !== '') {
        return path.posix.basename(rel) === 'index.html' ? { page: 'compose', target: v.id } : { page: 'scene', target: v.id };
      }
    } catch {
      // 这一层不是镜头目录。
    }
    dir = path.posix.dirname(dir);
  }
  return null;
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

/** 项目里的镜头编号，按 Go filepath.WalkDir 的词法顺序；渲染记忆考场与试镜（Studio 状态目录）里的镜头副本不算。 */
export function sceneIDs(root: string): string[] {
  const out: string[] = [];
  const exams = path.join(root, 'production', 'memory-exams');
  const studioState = path.join(root, 'production', 'studio');
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
        if (full !== exams && full !== studioState) walk(full);
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
  const step = (req.step ?? '').trim();
  if (step !== '' && !stepIDs().includes(step)) throw new Error(`没有步骤 ${goQuote(step)}（可选：${stepIDs().join('、')}）`);
  if (step === '') delete out.step;
  else out.step = step;
  // 只记关卡确认、不切页：原话由后端对照这一轮用户的话核对。
  if ((req.page ?? '') === '' && req.confirm) {
    const said = (req.confirm.said ?? '').trim();
    if (said === '') throw new Error('studio_confirm 要给 said：用户确认时的原话');
    delete out.target;
    return { ...out, page: '', confirm: { said, ...(req.confirm.gate ? { gate: req.confirm.gate.trim() } : {}) } };
  }
  // 只标步骤、不切页。
  if ((req.page ?? '') === '' && step !== '') {
    delete out.target;
    return { ...out, page: '' };
  }
  // 第三方站自己的页面：x:<站>:<页面>。这里只查写法，站加没加由客户端判断（打不开就不切）。
  if (/^x:[a-z][a-z0-9-]{1,39}:[a-z][a-z0-9-]*$/.test(req.page ?? '')) {
    delete out.target;
    return { ...out, page: req.page };
  }
  const page = viewPage(req.page);
  if (!page) throw new Error(`没有页面 ${goQuote(req.page)}（可选：${viewPages().map((p) => p.id).join('、')}）`);
  out.target = (req.target ?? '').trim();
  switch (page.target) {
    case 'scene':
    case 'scene?': {
      if (out.target === '') {
        if (page.target === 'scene') throw new Error(`${page.label} 页要给镜头编号：studio_show({"page": "${page.id}", "target": "<镜头编号>"})`);
        break;
      }
      if (project === '') break;
      const ids = sceneIDs(project);
      if (!ids.includes(out.target)) throw new Error(`项目里没有镜头 ${goQuote(out.target)}（有：${ids.join('、')}）`);
      break;
    }
    case 'file': {
      if (out.target === '') throw new Error('文件页要给项目里的相对路径：studio_show({"page": "file", "target": "<路径>"})');
      if (project !== '') {
        let rel = out.target;
        if (path.isAbsolute(rel)) rel = path.relative(project, rel);
        rel = path.normalize(rel).split(path.sep).join('/');
        if (rel === '..' || rel.startsWith('../') || path.posix.basename(rel) === '.env') throw new Error(`只能打开项目里的文件：${out.target}`);
        if (!fs.existsSync(path.join(project, rel))) throw new Error(`项目里没有文件 ${rel}`);
        out.target = rel;
        const special = dedicatedPage(project, rel);
        if (special) {
          out.page = special.page;
          if (special.target) out.target = special.target;
          else delete out.target;
          return out;
        }
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
 * 编排工具在 onset run 里也会照着提示词调用，写错要让它知道。
 */
export function writeViewRequest(env: Record<string, string | undefined>, req: ViewRequest): boolean {
  const inbox = env[ViewInboxEnv] ?? '';
  const valid = validateViewRequest(env[ViewProjectEnv] ?? '', req);
  if (inbox === '') return false;
  fs.mkdirSync(inbox, { recursive: true, mode: 0o755 });
  const body = marshal({ page: valid.page, target: valid.target || undefined, note: valid.note || undefined, step: valid.step || undefined, confirm: valid.confirm });
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
      const stepOnly = req.page === '' && typeof req.step === 'string' && stepIDs().includes(req.step);
      const confirmOnly = req.page === '' && !!req.confirm && typeof req.confirm.said === 'string';
      if (typeof req.page === 'string' && (viewPage(req.page) || stepOnly || confirmOnly)) out.push(req);
    } catch {
      // 读不懂的丢掉。
    }
  }
  return out;
}

/** 步骤说明：宿主的逐个列出，只有某个流程用得上的（插件登记的）注明是那个流程的第一步。 */
function stepHints(): string {
  const all = steps();
  const general = all.filter((x) => !x.flow).map((x) => `${x.id}（${x.hint}）`);
  const own = all.filter((x) => x.flow).map((x) => `${x.flow}项目的第一步是 ${x.id}（${x.hint}）`);
  return general.join('、') + own.map((x) => '；' + x).join('');
}

/** 写进对话约定（studioInteraction）的一条：怎样把用户带到某一页。 */
export function viewInteraction(): string {
  const pages = viewPages().map((page) => {
    let item = page.id + '（' + page.label;
    if (page.target === 'scene') item += '，后面跟镜头编号';
    else if (page.target === 'scene?') item += '，可以跟镜头编号';
    else if (page.target === 'file') item += '，后面跟项目里的相对路径';
    return item + '）';
  });
  return (
    '- 要用户看某样东西时，调用 studio_show({"page": "<页面>", "target": "<对象>", "note": "一句说明"})（对象与说明可省），网页会直接切到那一页，比在回复里贴大段内容或让用户自己去找好。页面：' +
    pages.join('、') +
    '。例如口播稿写好、请用户审稿时调用 studio_show({"page": "script", "note": "口播稿写好了，请看一遍"})；某个镜头渲染完请用户看效果时调用 studio_show({"page": "scene", "target": "scene-003"})。不要连续切来切去，一次只把用户带到眼下最该看的那一页。口播稿、分镜计划与处理方案、镜头、成片与配音合成版、发布信息都有自己的页面，用那一页，不要用 file 页打开它们的原文。\n' +
    '- 每一轮结束前（汇报、停下来等用户之前）调用 studio_step({"step": "<步骤>"})，标出整片制作现在处在哪一步，网页顶栏会标出来：' +
    stepHints() +
    '。它只做标记，不切页。\n' +
    '- 审核关卡（审稿、分镜审核这类停下来等用户确认的地方）：用户在对话里明确确认了（例如「就按这个分镜，开始渲染」），接着往下做之前先调用 studio_confirm({"said": "<用户确认的原话>"})，制作路线上那一关会标成已确认；用户只是提修改意见、或还没表态时不要调用，也不要替用户确认。\n' +
    '- 用户的消息后面可能附一句「用户发这条消息时，Studio 网页上开着……」，说的是用户正在看的页面；用户说「这个镜头」「这段」时指的就是那里。'
  );
}
export * from './permissions';
