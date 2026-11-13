/**
 * 前置资源清单：要联网准备的每一项、怎么判断就绪、怎么准备。移植自 internal/prereqs。
 *
 * am setup（下载）与客户端的引导（只读状态）共用这一份清单，两边说的永远是同一组东西。
 * 判断就绪不联网；准备只由 am setup 调用。错误类型与文案约定见 ../prereq。
 */
import * as filmstyle from '../filmstyle';
import '../filmstyle/sources';
import * as hyperframes from '../hyperframes';

/** 一次准备要用的环境与输出：git 走代理、npm 走自己的配置；工具的原始输出写进 log，stage 汇报进行到哪一步。 */
export interface Run {
  base: Record<string, string>;
  git: Record<string, string>;
  npm: Record<string, string>;
  mixed: Record<string, string>;
  log: hyperframes.Writer;
  stage: (text: string) => void;
}

/** 一项前置资源。 */
export interface Item {
  /** --only 认的大类（skills、cli、styles）。 */
  group: string;
  /** 这一项自己的名字；风格来源每个一项，ID 为 styles:<来源>。 */
  id: string;
  /** 与 version 分两列显示。 */
  name: string;
  version: string;
  /** 做片必需（技能与 CLI）；整片风格来源只有选了风格才要。 */
  required: boolean;
  /** 不联网地判断是否已就绪；where 是给人看的位置。 */
  ready: (env: Record<string, string>) => [ok: boolean, where: string];
  prepare: (run: Run, signal?: AbortSignal) => Promise<void>;
}

/** 把 HyperFrames 的进度译成一行说明。 */
function hyperframesStage(p: hyperframes.Progress): string {
  if (p.indeterminate || p.percent <= 0 || p.percent >= 100) return p.stage;
  return `${p.stage} ${Math.trunc(p.percent)}%`;
}

/** 全部前置资源，顺序即准备顺序。 */
export function items(): Item[] {
  const version = hyperframes.PinnedVersion;
  const out: Item[] = [
    {
      group: 'skills',
      id: 'skills',
      required: true,
      name: 'HyperFrames 技能',
      version,
      ready: (env) => {
        const dir = hyperframes.defaultCacheDir(env);
        return [hyperframes.skillsReady(dir), dir];
      },
      prepare: (run, signal) =>
        hyperframes.prepareSkills(
          { env: run.git, cacheDir: hyperframes.defaultCacheDir(run.base), output: run.log, progress: (p) => run.stage(hyperframesStage(p)) },
          signal,
        ),
    },
    {
      group: 'cli',
      id: 'cli',
      required: true,
      name: 'HyperFrames CLI',
      version,
      ready: (env) => {
        const dir = hyperframes.cliDir(env, hyperframes.PinnedVersion);
        return [hyperframes.cliReady(dir, hyperframes.PinnedVersion), dir];
      },
      prepare: async (run, signal) => {
        await hyperframes.ensureCLI({ env: run.npm, output: run.log, progress: (p) => run.stage(hyperframesStage(p)) }, signal);
      },
    },
  ];
  for (const source of filmstyle.sources()) {
    out.push({
      group: 'styles',
      id: 'styles:' + source.id(),
      name: '整片风格 ' + source.id(),
      version: '',
      required: false,
      ready: (env) => {
        let ok = true;
        try {
          source.check(env);
        } catch {
          ok = false;
        }
        return [ok, source.location(env)];
      },
      // 来源可能既用 git 又用 npm：git 的代理与 npm 的源合在一份环境里。
      prepare: (run, signal) =>
        source.prepare({ env: run.mixed, output: run.log, progress: (p) => run.stage(`(${p.step}/${p.steps}) ${p.stage}`) }, signal),
    });
  }
  return out;
}

/** 一项的就绪状态（给客户端与 --check 用）。字段顺序与 Go 的 JSON tag 一致。 */
export interface Status {
  id: string;
  group: string;
  name: string;
  version?: string;
  required: boolean;
  ready: boolean;
  location: string;
}

/** 不联网地返回全部项的状态。 */
export function check(env: Record<string, string>): Status[] {
  return items().map((item) => {
    const [ok, where] = item.ready(env);
    return { id: item.id, group: item.group, name: item.name, version: item.version || undefined, required: item.required, ready: ok, location: where };
  });
}
