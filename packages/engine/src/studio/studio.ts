/**
 * Studio 后端的服务骨架：项目登记、路由表、写锁、当前项目、项目状态，
 * 以及 /api/assets、/api/review、/api/review/run。
 *
 * Go 版是 net/http 服务；TS 版是 fetch 风格的 handle(request)：Electron 主进程用 onset://app/ 协议
 * 承接界面的 /api/…、EventSource 与上传请求后直接调它。路由、JSON 字段、状态码与错误文案与 Go 版一致。
 * 界面本身（Go 版 go:embed 的 web/）由 Electron 自己加载，这里不服务静态文件。
 *
 * 镜头、发布与合成预览的接口在 features.ts，记忆面板在 memory.ts。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { onsetExecutable } from '../envutil';
import * as filmstyle from '../filmstyle';
import { goClean, goPathError, goTrimSpace } from '../gofmt';
import { marshalIndent } from '../gojson';
import * as preset from '../preset';
import * as projectinit from '../projectinit';
import { agentKeysAPI, agentVisionAPI } from './agentkeys';
import { agentModelsAPI, agentsAPI } from './agents';
import { rawAPI, stylesAPI, treeAPI } from './api_ui';
import { commandAPI, filesAPI, productionStartAPI, sessionAPI, sessionsAPI, turnAPI } from './api_sessions';
import { previewAPI, renderAllAPI, sceneFeatureAPI, scenesAPI } from './features';
import { filmStylePosterAPI, filmStylesAPI, projectFilmStyleAPI, startFilmStyleTask } from './filmstyle';
import {
  DecodeError,
  decodeJSONStrict,
  fieldString,
  formatRFC3339Nano,
  goMap,
  goValue,
  methodNotAllowed,
  nowRFC3339,
  notFound,
  writeError,
  writeJSON,
} from './http';
import { memoryAPI, memoryActionAPI, memoryRecallAPI } from './memory';
import { namingAPI, recordNamingUsage } from './naming';
import { discoverScenes, fileExists, type SceneSummary } from './scenes';
import { scriptAPI } from './script';
import { computeStations, flowView, latestOutput, progressAPI } from './progress';
import { stationMediaAPI, stationsAPI, stationUIAPI, tickStationSchedules } from './stations';
import { storyboardAPI } from './storyboard';
import { readStepMark, viewPages } from './view';
import { BusyError, type Session } from './sessions';
import { renderCheckAPI } from './rendercheck';
import { cancelSetup, setupAPI, setupCancelAPI, setupRunAPI } from './setup';
import { currentSkinAPI, skinsAPI } from './skins';
import * as skin from '../skin';
import { voiceAPI, voiceDesignAPI, voiceDraftAPI, voiceRecordAPI, voicesAPI } from './voices';
import { settingsAPI, settingsGlobalAPI, settingsProjectAPI } from './settings';
import { SkillsState, installSkills, skillsAPI, skillsInstallAPI } from './skills';
import { TaskState, loadPersistedTasks, runStudioOp, runWriteTask, taskFeatureAPI, tasksAPI, writeTaskError } from './tasks';
import { uploadsAPI } from './uploads';
import * as flow from '../flow';
import * as plugin from '../plugin';
import * as studioview from '../studioview';

export interface Config {
  projectPath?: string;
  configPath?: string;
  /** 对应 onset --unsafe：编排工具与 onset 子命令都关闭权限隔离。 */
  unsafe?: boolean;
  /**
   * onset 命令行入口（Go 版是 os.Executable()）：写任务经它运行 onset 子命令，编排工具的 PATH 里也放它所在的目录。
   * 不给时用 envutil.onsetExecutable()（ONSET_SELF）。
   */
  executable?: string;
}

/** 登记的一个项目。字段名照抄 Go 的 JSON tag。 */
export interface Project {
  id: string;
  path: string;
  name: string;
  last_opened_at?: string;
}

function projectJSON(p: Project): Record<string, unknown> {
  return { id: p.id, path: p.path, name: p.name, last_opened_at: p.last_opened_at || undefined };
}

interface Registry {
  schema: number;
  /** Go 的 nil 切片写成 null。 */
  projects: Project[] | null;
  /** 上次新建项目时选的父目录，首页的「保存到」默认用它。 */
  last_parent?: string;
  /** 客户端用哪套界面皮肤（studio/skins.ts）；空是放映室。 */
  skin?: string;
}

/** 最近项目列表里每个项目的一行状态：做到哪一步、出了几个镜头、是否正忙。 */
export interface ProjectSummary {
  /** 制作走到了顶栏的哪一步（步骤 id）与它的名字。 */
  stage: string;
  stage_label: string;
  completed: number;
  total: number;
  busy?: string;
  missing?: boolean;
}

function summaryJSON(s: ProjectSummary): Record<string, unknown> {
  return { stage: s.stage, stage_label: s.stage_label, completed: s.completed, total: s.total, busy: s.busy || undefined, missing: s.missing || undefined };
}

/** summaryLimit 是首页侧栏要摘要的最近项目数：每个摘要要扫一遍项目目录。 */
const summaryLimit = 15;

/** os.UserConfigDir()。 */
function userConfigDir(): string {
  const home = process.env.HOME || os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

function defaultConfigPath(): string {
  if (process.env.ONSET_STUDIO_CONFIG) return process.env.ONSET_STUDIO_CONFIG;
  try {
    return path.join(userConfigDir(), 'onset', 'studio', 'projects.json');
  } catch {
    return path.join(os.tmpdir(), 'onset-studio-projects.json');
  }
}

type Handler = (request: Request, rest: string) => Response | Promise<Response>;

export class Server {
  readonly config: Required<Pick<Config, 'configPath' | 'unsafe'>> & Config;
  private registry: Registry = { schema: 1, projects: null };
  private current = '';
  readonly started = new Date();
  readonly tasks = new TaskState();
  readonly sessions = new Map<string, Session>();
  readonly loadedProjects = new Set<string>();
  private readonly busy = new Map<string, string>();
  readonly skills = new SkillsState();
  private readonly routes: [string, Handler][];

  constructor(cfg: Config = {}) {
    this.config = { ...cfg, configPath: cfg.configPath || defaultConfigPath(), unsafe: cfg.unsafe ?? false };
    this.loadRegistry();
    if (cfg.projectPath) this.current = this.openProject(cfg.projectPath).id;
    loadPersistedTasks(this);
    this.routes = this.routeTable();
    // 第三方站的定时任务：每分钟看一次。unref：不让这个定时器拖住进程退出（测试里会建很多个 Server）。
    this.scheduleTimer = setInterval(() => tickStationSchedules(this), 60_000);
    this.scheduleTimer.unref?.();
  }

  private readonly scheduleTimer: ReturnType<typeof setInterval>;

  /**
   * 退出前停掉进行中的每一轮对话与每个写任务。Go 版是独立进程，被整组结束时子进程跟着结束；
   * 在客户端主进程里，编排工具与 onset 子命令各自成进程组，不显式取消就会在客户端退出后继续跑。
   */
  shutdown(): void {
    clearInterval(this.scheduleTimer);
    for (const session of this.sessions.values()) session.cancel?.abort();
    for (const controller of this.tasks.cancel.values()) controller.abort();
    cancelSetup();
  }

  /** 当前项目的目录；没有打开项目时为空（前置资源按项目配置挑配音与对齐工具）。 */
  projectRoot(): string {
    try {
      return this.currentProject().path;
    } catch {
      return '';
    }
  }

  /** onset 命令行入口（Go 版的 os.Executable()）。 */
  executable(): string {
    return this.config.executable || onsetExecutable();
  }

  private loadRegistry(): void {
    this.registry = { schema: 1, projects: null };
    let body: string;
    try {
      body = fs.readFileSync(this.config.configPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('读取 Studio 项目登记失败：' + goPathError('open', this.config.configPath, err), { cause: err });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch (err) {
      throw new Error('项目登记损坏（Studio）：' + (err as Error).message, { cause: err });
    }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      if (typeof r.schema === 'number') this.registry.schema = r.schema;
      if (Array.isArray(r.projects)) {
        this.registry.projects = r.projects.map((item) => {
          const p = (item ?? {}) as Record<string, unknown>;
          const str = (key: string) => (typeof p[key] === 'string' ? (p[key] as string) : '');
          return { id: str('id'), path: str('path'), name: str('name'), last_opened_at: str('last_opened_at') || undefined };
        });
      }
      if (typeof r.last_parent === 'string' && r.last_parent !== '') this.registry.last_parent = r.last_parent;
      if (typeof r.skin === 'string' && r.skin !== '') this.registry.skin = r.skin;
    }
    if (this.registry.schema === 0) this.registry.schema = 1;
  }

  private saveRegistry(): void {
    const dir = path.dirname(this.config.configPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const body =
      marshalIndent({
        schema: this.registry.schema,
        projects: this.registry.projects ? this.registry.projects.map(projectJSON) : null,
        last_parent: this.registry.last_parent || undefined,
        skin: this.registry.skin || undefined,
      }) + '\n';
    const tmp = path.join(dir, `.projects-${crypto.randomBytes(5).toString('hex')}`);
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.config.configPath);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /** 用哪套界面皮肤（studio/skins.ts）。 */
  skinChoice(): string {
    return this.registry.skin ?? '';
  }

  setSkinChoice(id: string): void {
    this.registry.skin = id === skin.DefaultSkinID ? undefined : id;
    this.saveRegistry();
  }

  private trySaveRegistry(): void {
    try {
      this.saveRegistry();
    } catch {
      // 与 Go 版一样忽略。
    }
  }

  openProject(file: string): Project {
    const canonical = canonicalProjectPath(file);
    const projects = this.registry.projects ?? [];
    for (const p of projects) {
      if (p.path === canonical) {
        p.last_opened_at = nowRFC3339();
        this.trySaveRegistry();
        return { ...p };
      }
    }
    const p: Project = { id: projectID(canonical), path: canonical, name: path.basename(canonical), last_opened_at: nowRFC3339() };
    this.registry.projects = [...projects, p];
    this.saveRegistry();
    return { ...p };
  }

  // ---- 写锁 ----

  /** acquire 占用项目的写权。同一时间只允许一个写入者：一轮对话或一个会改文件的任务。被占用时抛 BusyError。 */
  acquire(projectPath: string, holder: string): void {
    const current = this.busy.get(projectPath);
    if (current !== undefined) throw new BusyError(current);
    this.busy.set(projectPath, holder);
  }

  release(projectPath: string): void {
    this.busy.delete(projectPath);
  }

  busyHolder(projectPath: string): string {
    return this.busy.get(projectPath) ?? '';
  }

  // ---- 当前项目 ----

  /** 当前项目；没有打开或目录不在时抛错。路径是登记时 realpath 过的。 */
  currentProject(): Project {
    for (const p of this.registry.projects ?? []) {
      if (p.id === this.current) {
        let ok = false;
        try {
          ok = fs.statSync(p.path).isDirectory();
        } catch {
          ok = false;
        }
        if (!ok) throw new Error('当前项目目录不存在或不可访问');
        return { ...p };
      }
    }
    throw new Error('尚未打开项目');
  }

  /**
   * 「在 Finder 中显示」要选中的路径。`projectID` 为空时用当前项目；`target` 是项目内的相对路径或绝对路径，
   * 空表示项目文件夹本身。解析后（含符号链接）必须在项目里，`.env` 不显示；文件还不存在（镜头还没渲染）时
   * 退到最近一层存在的上级目录。返回 `{ path, folder }`：`folder` 为 true 时直接打开它，否则在 Finder 里选中它。
   */
  revealPath(projectID: string, target: string): { path: string; folder: boolean } {
    const p = projectID === '' ? this.currentProject() : (this.registry.projects ?? []).find((x) => x.id === projectID);
    if (!p) throw new Error('项目没有登记');
    const root = fs.realpathSync(p.path);
    if (target === '') return { path: root, folder: true };
    let full = path.resolve(root, target);
    const rel = path.relative(root, full);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('路径不在项目里');
    if (path.basename(full) === '.env') full = path.dirname(full);
    while (!fs.existsSync(full) && full !== root) full = path.dirname(full);
    const real = fs.realpathSync(full);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('路径不在项目里');
    return { path: real, folder: real === root };
  }

  /** 当前项目，或一个 404 no_project 响应。 */
  projectOr404(): Project | Response {
    try {
      return this.currentProject();
    } catch (err) {
      return writeError(404, 'no_project', (err as Error).message);
    }
  }

  // ---- 路由 ----

  private routeTable(): [string, Handler][] {
    return [
      ['/api/health', () => this.health()],
      ['/api/projects', () => this.projectsAPI()],
      ['/api/projects/open', (r) => this.openAPI(r)],
      ['/api/projects/create', (r) => this.createAPI(r)],
      ['/api/projects/name', (r) => namingAPI(r)],
      ['/api/directories', (r) => this.directoriesAPI(r)],
      ['/api/projects/recent/remove', (r) => this.removeAPI(r)],
      ['/api/workspaces/current', () => this.currentAPI()],
      ['/api/workspaces/switch', (r) => this.switchAPI(r)],
      ['/api/state', () => this.stateAPI()],
      ['/api/scenes', () => scenesAPI(this)],
      ['/api/script', (r) => scriptAPI(this, r)],
      ['/api/storyboard', (r) => storyboardAPI(this, r)],
      ['/api/progress', (r) => progressAPI(this, r, '')],
      ['/api/progress/', (r, rest) => progressAPI(this, r, rest)],
      ['/api/stations', (r) => stationsAPI(this, r, '')],
      ['/api/stations/', (r, rest) => stationsAPI(this, r, rest)],
      ['/station-ui/', (r, rest) => stationUIAPI(this, r, rest)],
      ['/station-media/', (r, rest) => stationMediaAPI(this, r, rest)],
      ['/api/assets', () => this.assetsAPI()],
      ['/api/scenes/', (r, rest) => sceneFeatureAPI(this, r, rest)],
      ['/api/tasks', (r) => tasksAPI(this, r)],
      ['/api/tasks/', (r, rest) => taskFeatureAPI(this, r, rest)],
      ['/api/review', () => this.reviewAPI()],
      ['/api/review/run', (r) => this.reviewRunAPI(r)],
      ['/api/render/all', (r) => renderAllAPI(this, r)],
      ['/api/sessions', (r) => sessionsAPI(this, r)],
      ['/api/sessions/', (r, rest) => sessionAPI(this, r, rest)],
      ['/api/production/start', (r) => productionStartAPI(this, r)],
      ['/api/turns/', (r, rest) => turnAPI(this, r, rest)],
      ['/api/commands/', (r, rest) => commandAPI(this, r, rest)],
      ['/api/files', (r) => filesAPI(this, r)],
      ['/api/uploads', (r) => uploadsAPI(this, r)],
      ['/api/skills', () => skillsAPI(this)],
      ['/api/skills/install', (r) => skillsInstallAPI(this, r)],
      ['/api/agents', (r) => agentsAPI(this, r)],
      ['/api/agents/', (r, rest) => agentModelsAPI(r, rest)],
      ['/preview/scenes/', (r, rest) => previewAPI(this, r, rest)],
      ['/api/styles', (r) => stylesAPI(r)],
      ['/api/tree', (r) => treeAPI(this, r)],
      ['/api/raw', (r) => rawAPI(this, r)],
      ['/api/memory', (r) => memoryAPI(this, r)],
      ['/api/memory/recall', (r) => memoryRecallAPI(this, r)],
      ['/api/memory/actions/', (r, rest) => memoryActionAPI(this, r, rest)],
      // 先按当前项目换上第三方插件带来的风格库。
      ['/api/film-styles', (r) => filmStylesAPI(r)],
      ['/api/film-styles/', (r, rest) => filmStylePosterAPI(r, rest)],
      ['/api/film-style', (r) => projectFilmStyleAPI(this, r)],
      ['/api/settings', (r) => settingsAPI(this, r)],
      ['/api/agent-keys', (r) => agentKeysAPI(r)],
      ['/api/agent-keys/vision', (r) => agentVisionAPI(r)],
      ['/api/settings/global', (r) => settingsGlobalAPI(r)],
      ['/api/settings/project', (r) => settingsProjectAPI(this, r)],
      ['/api/voices', (r) => voicesAPI(this, r)],
      ['/api/voices/', (r, rest) => voiceAPI(r, rest)],
      ['/api/voice-record', (r) => voiceRecordAPI(r)],
      ['/api/voice-design', (r) => voiceDesignAPI(r)],
      ['/api/voice-drafts/', (r, rest) => voiceDraftAPI(r, rest)],
      ['/api/skins', (r) => skinsAPI(this, r)],
      ['/api/skins/current', (r) => currentSkinAPI(this, r)],
      ['/api/setup', (r) => setupAPI(r, this.projectRoot())],
      ['/api/setup/run', (r) => setupRunAPI(r, this.projectRoot())],
      ['/api/setup/cancel', (r) => setupCancelAPI(r)],
      ['/api/setup/render-check', (r) => renderCheckAPI(r)],
      // 内置插件在 apply 里登记的接口（例如发布页的 /api/publish）。
      ...plugin.pluginRoutes().map(({ value: route }): [string, Handler] => [route.pattern, (r, rest) => route.handle(this, r, rest)]),
    ];
  }

  /**
   * fetch 风格的入口：按 Go 的 http.ServeMux 规则匹配（精确路径优先、以 / 结尾的模式按最长前缀匹配，
   * 不规整的路径 301 到规整后的路径）。
   */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // 插件页面在沙箱 iframe 里（不透明源，Origin 是 "null"），只能经宿主转交，不能直接调接口：
    // CSP 已经拦下它的请求，这里再兜一层，免得哪天 CSP 写漏了。
    if (url.pathname.startsWith('/api/') && request.headers.get('Origin') === 'null') {
      return writeError(403, 'forbidden', '插件页面不能直接调用 Studio 接口');
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('400 Bad Request', { status: 400 });
    }
    let clean = goClean(pathname);
    if (pathname.endsWith('/') && clean !== '/') clean += '/';
    if (clean !== pathname) return redirect(url, clean);
    let best: [string, Handler] | undefined;
    for (const route of this.routes) {
      const [pattern] = route;
      if (pattern === pathname) {
        best = route;
        break;
      }
      if (pattern.endsWith('/') && pathname.startsWith(pattern) && (!best || pattern.length > best[0].length)) best = route;
    }
    // 只注册了子树（/api/turns/）时，不带斜杠的请求 301 到带斜杠的路径。
    if (!best && this.routes.some(([pattern]) => pattern === pathname + '/')) return redirect(url, pathname + '/');
    try {
      if (!best) return this.fallback(pathname);
      const [pattern, handler] = best;
      return await handler(request, pattern.endsWith('/') ? pathname.slice(pattern.length) : '');
    } catch (err) {
      return writeError(500, 'internal_error', (err as Error).message);
    }
  }

  /** Go 版的 static：/api/ 下不存在的路径给 JSON 404；界面文件由 Electron 加载，这里一律 404。 */
  private fallback(pathname: string): Response {
    if (pathname.startsWith('/api/')) return writeError(404, 'not_found', 'Studio API 路径不存在');
    return notFound();
  }

  // ---- 项目 ----

  private health(): Response {
    return writeJSON(200, goMap({ ok: true, service: 'onset-studio', started_at: formatRFC3339Nano(this.started) }));
  }

  private directoriesAPI(request: Request): Response {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const root = studioBrowseRoot();
    const requested = new URL(request.url).searchParams.get('path') ?? '';
    const dir = requested !== '' ? path.resolve(requested) : root;
    const withinRoot = path.relative(root, dir);
    if (withinRoot === '..' || withinRoot.startsWith('..' + path.sep) || path.isAbsolute(withinRoot)) {
      return writeError(403, 'directory_outside_root', '只能浏览服务器用户目录下的文件夹');
    }
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return writeError(400, 'directory_unavailable', '目录不存在或不可读取');
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return writeError(403, 'directory_unreadable', '没有权限读取这个目录');
    }
    const entries = items
      .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
      .map((item) => {
        const child = path.join(dir, item.name);
        return { name: item.name, path: child, is_project: isStudioProjectDir(child) };
      });
    entries.sort((a, b) => {
      if (a.is_project !== b.is_project) return a.is_project ? -1 : 1;
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const parent = dir !== root ? path.dirname(dir) : '';
    return writeJSON(200, goMap({ path: dir, parent, root, entries }));
  }

  private projectsAPI(): Response {
    const projects = [...(this.registry.projects ?? [])].map((p) => ({ ...p }));
    const current = this.current;
    const lastParent = this.registry.last_parent ?? '';
    const recent = [...projects].sort((a, b) => {
      const x = a.last_opened_at ?? '';
      const y = b.last_opened_at ?? '';
      return x > y ? -1 : x < y ? 1 : 0;
    });
    const summaries: Record<string, unknown> = {};
    recent.forEach((p, i) => {
      if (i < summaryLimit) summaries[p.id] = summaryJSON(this.summarize(p));
      // 只查目录还在不在，便宜；完整摘要只给最近的几个。
      else if (!dirExists(p.path)) summaries[p.id] = summaryJSON({ stage: '', stage_label: '', completed: 0, total: 0, missing: true });
    });
    return writeJSON(
      200,
      goMap({
        projects: projects.map(projectJSON),
        current_project_id: current,
        summaries: goMap(summaries),
        default_parent: defaultParent(lastParent, recent),
      }),
    );
  }

  private summarize(p: Project): ProjectSummary {
    if (!dirExists(p.path)) return { stage: '', stage_label: '', completed: 0, total: 0, missing: true };
    const scenes = discoverScenes(p.path);
    const at = stageFor(p.path, scenes);
    const summary: ProjectSummary = { stage: at.stage, stage_label: at.label, completed: 0, total: scenes.length, busy: this.busyHolder(p.path) || undefined };
    for (const sc of scenes) if (sc.exists && !sc.stale) summary.completed++;
    return summary;
  }

  private async createAPI(request: Request): Promise<Response> {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let req: { parent: string; name: string; canvas: string; delivery: string; narration: string; film_style: string; naming: string };
    try {
      const body = await decodeJSONStrict(request);
      req = {
        parent: fieldString(body, 'parent'),
        name: fieldString(body, 'name'),
        canvas: fieldString(body, 'canvas'),
        // delivery 与 narration 同 onset init --delivery / --narration，缺省为 speech / solo。
        delivery: fieldString(body, 'delivery'),
        narration: fieldString(body, 'narration'),
        // film_style 是整片风格（风格库目录名、中文名或英文名），空表示不用。
        // 建好项目后在后台起一个 onset film-style use 任务，任务编号随响应返回。
        film_style: fieldString(body, 'film_style'),
        // naming 是起名那次调用的凭据（/api/projects/name 给的），建好后把那次的用量记进新项目。
        naming: fieldString(body, 'naming'),
      };
    } catch {
      return writeError(400, 'invalid_request', '请填写项目名称');
    }
    if (goTrimSpace(req.name) === '') return writeError(400, 'invalid_request', '请填写项目名称');
    if (req.canvas === '') req.canvas = preset.defaultPreset().id;
    const parent = path.resolve(req.parent);
    if (!isWithinStudioBrowseRoot(parent)) return writeError(403, 'directory_outside_root', '只能在服务器用户目录下创建项目');
    if (!dirExists(parent)) return writeError(400, 'directory_unavailable', '父目录不存在');
    const name = path.basename(goClean(req.name));
    if (name === '.' || name === '..' || name !== req.name || /[/\\]/.test(name)) {
      return writeError(400, 'invalid_project_name', '项目名称只能是一个文件夹名称');
    }
    const target = path.join(parent, name);
    if (fileExists(target)) return writeError(409, 'project_exists', '这个目录已经存在');
    let filmStyle: filmstyle.Style | undefined;
    if (req.film_style !== '') {
      try {
        filmStyle = filmstyle.lookup(req.film_style);
      } catch (err) {
        return writeError(400, 'unknown_film_style', (err as Error).message);
      }
    }
    if (req.delivery === '') req.delivery = projectinit.DeliverySpeech;
    if (req.narration === '') req.narration = projectinit.NarrationSolo;
    const opts: projectinit.Options = { target, canvas: req.canvas, delivery: req.delivery, narration: req.narration };
    try {
      projectinit.validate(opts);
    } catch (err) {
      return writeError(400, 'invalid_mode', (err as Error).message);
    }
    if (!preset.byID(req.canvas)) return writeError(400, 'invalid_canvas', '未知画幅：' + req.canvas);
    try {
      projectinit.create(opts);
    } catch (err) {
      return writeError(400, 'project_create_failed', (err as Error).message);
    }
    let p: Project;
    try {
      p = this.openProject(target);
    } catch (err) {
      return writeError(500, 'project_register_failed', (err as Error).message);
    }
    // 官方技能从本机缓存拷进项目（前置资源由 onset setup 准备，这里不联网），放到后台：项目先打开。
    // 用登记后的路径（已 realpath），与 currentProject() 返回的一致。
    installSkills(this, p.path);
    recordNamingUsage(req.naming, p.path);
    this.current = p.id;
    this.registry.last_parent = parent;
    this.trySaveRegistry();
    const resp: Record<string, unknown> = { project: projectJSON(p) };
    if (filmStyle) {
      // 第一次要下载风格库，放到后台；它占项目写锁，装好之前开工会被告知项目正忙。
      try {
        resp.film_style_task = startFilmStyleTask(this, p, filmStyle, false).task_id;
      } catch (err) {
        resp.film_style_error = (err as Error).message;
      }
    }
    return writeJSON(201, goMap(resp));
  }

  private async openAPI(request: Request): Promise<Response> {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let file: string;
    try {
      file = fieldString(await decodeJSONStrict(request), 'path');
    } catch {
      return writeError(400, 'invalid_json', '请求不是合法 JSON');
    }
    let p: Project;
    try {
      p = this.openProject(file);
    } catch (err) {
      return writeError(400, 'project_unavailable', (err as Error).message);
    }
    this.current = p.id;
    this.trySaveRegistry();
    return writeJSON(200, goMap({ project: projectJSON(p) }));
  }

  private async removeAPI(request: Request): Promise<Response> {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let id = '';
    try {
      id = fieldString(await decodeJSONStrict(request), 'project_id');
    } catch {
      id = '';
    }
    if (id === '') return writeError(400, 'invalid_request', '缺少 project_id');
    if (this.registry.projects) this.registry.projects = this.registry.projects.filter((p) => p.id !== id);
    if (this.current === id) this.current = '';
    try {
      this.saveRegistry();
    } catch (err) {
      return writeError(500, 'registry_write_failed', (err as Error).message);
    }
    return writeJSON(200, goMap({ ok: true }));
  }

  private currentAPI(): Response {
    for (const p of this.registry.projects ?? []) if (p.id === this.current) return writeJSON(200, goMap({ project: projectJSON(p) }));
    return writeJSON(200, goMap({ project: null }));
  }

  private async switchAPI(request: Request): Promise<Response> {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let id: string;
    try {
      id = fieldString(await decodeJSONStrict(request), 'project_id');
    } catch (err) {
      if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
      throw err;
    }
    for (const p of this.registry.projects ?? []) {
      if (p.id === id) {
        this.current = p.id;
        this.trySaveRegistry();
        return writeJSON(200, goMap({ project: projectJSON(p) }));
      }
    }
    return writeError(404, 'project_not_found', '项目未登记');
  }

  private stateAPI(): Response {
    const p = this.projectOr404();
    if (p instanceof Response) return p;
    return writeJSON(200, inspectProject(p));
  }

  private assetsAPI(): Response {
    const p = this.projectOr404();
    if (p instanceof Response) return p;
    const assets: { path: string; size: number }[] = [];
    for (const root of ['assets', 'cast']) walkFiles(path.join(p.path, root), (file, info) => {
      assets.push({ path: path.relative(p.path, file).split(path.sep).join('/'), size: info.size });
    });
    return writeJSON(200, goMap({ assets }));
  }

  private reviewAPI(): Response {
    const p = this.projectOr404();
    if (p instanceof Response) return p;
    const file = path.join(p.path, 'production', 'review', 'review.json');
    let body: string;
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return writeJSON(200, goMap({ available: false, issues: [] }));
      return writeError(500, 'review_read_failed', goPathError('open', file, err));
    }
    let report: unknown;
    try {
      report = goValue(JSON.parse(body));
    } catch {
      report = goMap({ raw: body });
    }
    return writeJSON(200, goMap({ available: true, report }));
  }

  private reviewRunAPI(request: Request): Response {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const p = this.projectOr404();
    if (p instanceof Response) return p;
    try {
      const t = runWriteTask(this, p, 'project.review', '运行成片审查', async (signal) => {
        const dir = path.join(p.path, 'production', 'review');
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
        const video = findProjectVideo(p.path);
        if (video === '') throw new Error('找不到可审查的成片，请先生成 candidate.mp4 或 final.mp4');
        await runStudioOp(this, signal, p, 'review', { video, out: dir });
      });
      return writeJSON(202, goMap({ task_id: t.task_id }));
    } catch (err) {
      return writeTaskError(err);
    }
  }
}

/** New：读项目登记、打开 cfg.projectPath、恢复任务记录。 */
export function newServer(cfg: Config = {}): Server {
  return new Server(cfg);
}

function redirect(url: URL, pathname: string): Response {
  const location = pathname + url.search;
  return new Response(`<a href="${location}">Moved Permanently</a>.\n\n`, {
    status: 301,
    headers: { Location: location, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function canonicalProjectPath(file: string): string {
  if (file === '') throw new Error('项目路径不能为空');
  const abs = path.resolve(file);
  let clean: string;
  try {
    clean = fs.realpathSync(abs);
  } catch (err) {
    throw new Error('项目目录不可用：' + goPathError('lstat', abs, err), { cause: err });
  }
  if (!dirExists(clean)) throw new Error('项目路径必须是目录');
  return clean;
}

function projectID(file: string): string {
  return 'project-' + crypto.createHash('sha256').update(file).digest().subarray(0, 8).toString('hex');
}

function studioBrowseRoot(): string {
  const home = process.env.HOME || os.homedir();
  if (home) return path.resolve(home);
  return path.resolve(process.cwd());
}

function isWithinStudioBrowseRoot(file: string): boolean {
  const rel = path.relative(studioBrowseRoot(), path.resolve(file));
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function isStudioProjectDir(dir: string): boolean {
  try {
    if (!fs.statSync(path.join(dir, 'frame.md')).isDirectory()) return true;
  } catch {
    // 没有 frame.md。
  }
  return dirExists(path.join(dir, 'scenes'));
}

function dirExists(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** 遍历 root 下的全部非目录条目（filepath.WalkDir，d.Info() 是 lstat）。 */
function walkFiles(root: string, visit: (file: string, info: fs.Stats) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, visit);
      continue;
    }
    try {
      visit(full, fs.lstatSync(full));
    } catch {
      // 竞态删除。
    }
  }
}

/** defaultParent 是新建项目的默认父目录：上次选的，否则最近一个项目所在的目录，否则家目录。 */
function defaultParent(last: string, recent: Project[]): string {
  for (const candidate of [last, ...recent.map((p) => path.dirname(p.path))]) {
    if (candidate === '' || !isWithinStudioBrowseRoot(candidate)) continue;
    if (dirExists(candidate)) return candidate;
  }
  return studioBrowseRoot();
}

function findProjectVideo(root: string): string {
  for (const candidate of [path.join(root, 'production', 'audio', 'candidate.mp4'), path.join(root, 'final.mp4'), path.join(root, 'production', 'final.mp4')]) {
    if (fileExists(candidate)) return candidate;
  }
  return '';
}

export function inspectProject(p: Project): Record<string, unknown> {
  const scenes = discoverScenes(p.path);
  let done = 0;
  let stale = 0;
  for (const sc of scenes) {
    if (sc.exists) done++;
    if (sc.stale) stale++;
  }
  const meta = projectMetadata(p.path);
  // 整片风格的名字给顶栏用。
  try {
    const { manifest, ok } = filmstyle.installed(p.path);
    if (ok) meta.film_style = manifest.cn;
  } catch {
    // 读不了就不显示。
  }
  // 项目的流程：顶栏的步骤、第一步与用不上的页面都按它（界面不按片型写死）。没有流程记录的目录排不出路线：
  // 不给 flow 与 step，flow_error 照实说缺什么（界面据此提示，「开始制作」也会报同一句）。
  let flowState: Record<string, unknown>;
  try {
    flowState = { ...stepOf(p.path, scenes), flow: flowView(p.path) };
  } catch (err) {
    if (!(err instanceof flow.MissingFlowRecordError)) throw err;
    flowState = { flow_error: err.message };
  }
  return goMap({
    project: projectJSON(p),
    ...flowState,
    // 客户端有哪些页（宿主的加上内置插件登记的）：界面只列这里有的，组件仍在界面里按 id 对上。
    pages: viewPages().map((pg) => goMap({ id: pg.id, label: pg.label })),
    metadata: goMap(meta),
    scenes: goMap({ total: scenes.length, completed: done, stale }),
  });
}

/**
 * projectMetadata 从 frame.md 的 front matter 取画幅。Studio 只是观察者，项目改到一半、
 * front matter 写坏了也照样返回能读到的部分，不报错。
 *
 * 只看顶层键：front matter 里 colors.canvas 这类同名的嵌套键是颜色值，按行扫描会读错。
 */
export function projectMetadata(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'frame.md'), 'utf8').replaceAll('\r\n', '\n');
  } catch {
    return result;
  }
  if (!text.startsWith('---\n')) return result;
  const end = text.slice(4).indexOf('\n---');
  if (end < 0) return result;
  let front: unknown;
  try {
    front = YAML.parse(text.slice(4, 4 + end));
  } catch {
    return result;
  }
  if (front === null || front === undefined) return result;
  if (typeof front !== 'object' || Array.isArray(front)) return result;
  const f = front as Record<string, unknown>;
  const canvas = f.canvas;
  if (canvas !== null && typeof canvas === 'object' && !Array.isArray(canvas)) {
    const c = canvas as Record<string, unknown>;
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : 0);
    const width = int(c.width_px);
    const height = int(c.height_px);
    const fps = int(c.fps);
    const orientation = typeof c.orientation === 'string' ? c.orientation : '';
    if (width > 0 && height > 0) result.canvas = `${width}×${height}`;
    if (fps > 0) result.fps = String(fps);
    if (orientation !== '') result.orientation = orientation;
    const p = preset.byCanvas(width, height, fps, orientation);
    if (p) result.canvas_id = p.id;
  }
  return result;
}

/**
 * 顶栏标出的「现在在哪一步」：编排工具每轮结束前用 studio_step 标的为准（step_marked）；
 * 还没标过（老项目、没在客户端里做过）时按产物推一个。
 */
export function stepOf(root: string, scenes: SceneSummary[]): { step?: string; step_marked?: boolean } {
  const mark = readStepMark(root);
  // 编排工具的标记只在它比项目里最新的产物还新时才算：之后又有了新产物，说明它标的已经过时。
  if (mark && Date.parse(mark.at) >= latestOutput(root, scenes) - 1000) return { step: mark.step, step_marked: true };
  const { stations, current } = computeStations(root, scenes);
  const at = stations.find((s) => s.id === current);
  // 全部做完：停在最后一步。
  return { step: (at ?? stations[stations.length - 1]).step };
}

/**
 * stageFor 是首页最近项目那一行的阶段：与顶栏同一个来源（stepOf：编排标的步骤，否则制作路线当前一站所在的步骤），
 * 不另看文件。没有流程记录的目录排不出路线，为空。
 */
export function stageFor(root: string, scenes: SceneSummary[]): { stage: string; label: string } {
  let step: string;
  try {
    step = stepOf(root, scenes).step ?? '';
  } catch (err) {
    if (err instanceof flow.MissingFlowRecordError) return { stage: '', label: '' };
    throw err;
  }
  return { stage: step, label: studioview.steps().find((x) => x.id === step)?.label ?? step };
}
