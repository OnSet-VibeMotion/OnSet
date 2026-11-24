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
import fs from 'node:fs';
import path from 'node:path';
import { onsetExecutable } from '../envutil';
import * as series from '../series';
import * as skin from '../skin';
import { formatRFC3339Nano, goMap, nowRFC3339, writeError, writeJSON } from './http';
import { BusyError, type Session } from './sessions';
import { cancelSetup } from './setup';
import { SkillsState } from './skills';
import { tickStationSchedules } from './stations';
import { type Config, canonicalProjectPath, type Project, projectID, type Registry } from './studio_inspect';
import type { ProjectAPIHost } from './studio_projects_api';
import { defaultConfigPath, loadRegistryFile, revealProjectPath, saveRegistryFile } from './studio_registry';
import { buildRouteTable, dispatchRoute, type Handler } from './studio_routes';
import { loadPersistedTasks, TaskState } from './tasks';

export {
  type Config,
  inspectProject,
  type Project,
  type ProjectSummary,
  projectMetadata,
  stageFor,
  stepOf,
} from './studio_inspect';

export class Server {
  readonly config: Required<Pick<Config, 'configPath' | 'unsafe'>> & Config;
  private registry: Registry = { schema: 1, projects: null };
  private current = '';
  readonly started = new Date();
  readonly tasks = new TaskState();
  readonly sessions = new Map<string, Session>();
  readonly loadedProjects = new Set<string>();
  private readonly busy = new Map<string, string>();
  /**
   * 每个项目有过几个写入者（占写锁的、不占写锁的插件网页操作都算）：不占写锁的操作据此判断期间有没有别人在写，
   * 越界写入还能不能归到它头上。
   */
  private readonly writeEpochs = new Map<string, number>();
  /** 不占写锁、但重启会打断的事（插件网页操作，例如正在上传）：任务编号 → 项目与说明。 */
  private readonly shared = new Map<string, { project: string; holder: string }>();
  readonly skills = new SkillsState();
  private readonly routes: [string, Handler][];
  private readonly scheduleTimer: ReturnType<typeof setInterval>;

  constructor(cfg: Config = {}) {
    this.config = { ...cfg, configPath: cfg.configPath || defaultConfigPath(), unsafe: cfg.unsafe ?? false };
    this.loadRegistry();
    if (cfg.projectPath) this.current = this.openProject(cfg.projectPath).id;
    loadPersistedTasks(this);
    this.routes = buildRouteTable(this, this.projectHost(), () => this.health());
    // 第三方站的定时任务：每分钟看一次。unref：不让这个定时器拖住进程退出（测试里会建很多个 Server）。
    this.scheduleTimer = setInterval(() => tickStationSchedules(this), 60_000);
    this.scheduleTimer.unref?.();
  }

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
    this.registry = loadRegistryFile(this.config.configPath);
  }

  private saveRegistry(): void {
    saveRegistryFile(this.config.configPath, this.registry);
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
    let binding: series.ProjectSeriesBinding | null = null;
    try {
      binding = series.readBinding(canonical);
    } catch {
      binding = null;
    }
    const projects = this.registry.projects ?? [];
    for (const p of projects) {
      if (p.path === canonical) {
        p.last_opened_at = nowRFC3339();
        p.series_id = binding?.series_id;
        p.episode = binding?.episode;
        this.trySaveRegistry();
        return { ...p };
      }
    }
    const p: Project = {
      id: projectID(canonical),
      path: canonical,
      name: path.basename(canonical),
      last_opened_at: nowRFC3339(),
      series_id: binding?.series_id,
      episode: binding?.episode,
    };
    this.registry.projects = [...projects, p];
    this.saveRegistry();
    return { ...p };
  }

  /** 更新已登记项目的专栏归属缓存（写完 onset.series.json 后调用）。 */
  updateProjectSeries(projectId: string, seriesId?: string, episode?: number): Project | null {
    for (const p of this.registry.projects ?? []) {
      if (p.id === projectId) {
        p.series_id = seriesId || undefined;
        p.episode = seriesId ? episode : undefined;
        this.saveRegistry();
        return { ...p };
      }
    }
    return null;
  }

  /** 专栏被删除后，清理登记表里所有指向它的缓存（不删任何项目）。 */
  clearSeriesProjects(seriesId: string): void {
    let changed = false;
    for (const p of this.registry.projects ?? []) {
      if (p.series_id === seriesId) {
        p.series_id = undefined;
        p.episode = undefined;
        changed = true;
      }
    }
    if (changed) this.trySaveRegistry();
  }

  // ---- 写锁 ----

  /** acquire 占用项目的写权。同一时间只允许一个写入者：一轮对话或一个会改文件的任务。被占用时抛 BusyError。 */
  acquire(projectPath: string, holder: string): void {
    const current = this.busy.get(projectPath);
    if (current !== undefined) throw new BusyError(current);
    this.busy.set(projectPath, holder);
    this.bumpWriteEpoch(projectPath);
  }

  private bumpWriteEpoch(projectPath: string): void {
    this.writeEpochs.set(projectPath, (this.writeEpochs.get(projectPath) ?? 0) + 1);
  }

  writeEpoch(projectPath: string): number {
    return this.writeEpochs.get(projectPath) ?? 0;
  }

  /** 登记、撤销一件不占写锁的事（见 shared）。 */
  beginShared(id: string, projectPath: string, holder: string): void {
    this.shared.set(id, { project: projectPath, holder });
    this.bumpWriteEpoch(projectPath);
  }

  /** 这个项目里是否有未结束的插件网页操作。 */
  hasSharedWriter(projectPath: string, exceptID?: string): boolean {
    return [...this.shared.entries()].some(([id, writer]) => id !== exceptID && writer.project === projectPath);
  }

  endShared(id: string): void {
    this.shared.delete(id);
  }

  release(projectPath: string): void {
    this.busy.delete(projectPath);
  }

  busyHolder(projectPath: string): string {
    return this.busy.get(projectPath) ?? '';
  }

  /** 所有项目里正占着写锁的事（一轮对话、渲染、拼接……）与不占写锁的插件网页操作（正在上传）：重启装更新之前要告诉用户会打断什么。 */
  activeWork(): { project: string; holder: string }[] {
    return [...[...this.busy.entries()].map(([project, holder]) => ({ project, holder })), ...this.shared.values()];
  }

  // ---- 当前项目 ----

  /** 已登记的项目副本；历史考试可沿明确来源读取对应项目的口播，不切换当前工作区。 */
  registeredProjects(): Project[] {
    return (this.registry.projects ?? []).map((p) => ({ ...p }));
  }

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

  revealPath(projectID: string, target: string): { path: string; folder: boolean } {
    return revealProjectPath(this.registry, () => this.currentProject(), projectID, target);
  }

  /** 当前项目，或一个 404 no_project 响应。 */
  projectOr404(): Project | Response {
    try {
      return this.currentProject();
    } catch (err) {
      return writeError(404, 'no_project', (err as Error).message);
    }
  }

  async handle(request: Request): Promise<Response> {
    return dispatchRoute(this.routes, request);
  }

  private health(): Response {
    return writeJSON(200, goMap({ ok: true, service: 'onset-studio', started_at: formatRFC3339Nano(this.started) }));
  }

  private projectHost(): ProjectAPIHost {
    return {
      server: this,
      projects: () => (this.registry.projects ?? []).map((p) => ({ ...p })),
      currentId: () => this.current,
      setCurrentId: (id) => {
        this.current = id;
      },
      lastParent: () => this.registry.last_parent ?? '',
      setLastParent: (parent) => {
        this.registry.last_parent = parent;
      },
      removeProjectById: (id) => {
        if (this.registry.projects) this.registry.projects = this.registry.projects.filter((p) => p.id !== id);
        if (this.current === id) this.current = '';
      },
      saveRegistry: () => this.saveRegistry(),
      trySaveRegistry: () => this.trySaveRegistry(),
    };
  }
}

/** New：读项目登记、打开 cfg.projectPath、恢复任务记录。 */
export function newServer(cfg: Config = {}): Server {
  return new Server(cfg);
}
