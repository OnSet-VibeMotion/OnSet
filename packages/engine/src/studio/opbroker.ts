import fs from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import * as director from '../director';
import { envMap } from '../envutil';
import { operationBroker, OpBrokerEnv, OpBrokerRelayedEnv } from '../opworker';
import { runStudioOpWith } from './tasks';
import type { Project, Server } from './studio';

/**
 * 请求目录所属的已登记项目（最深的那个）。不看客户端此刻打开的是哪个项目：一轮对话在后台照常跑，
 * 用户切去看别的项目时，这一轮派的渲染仍属于它自己的项目（2026-11 实测：按当前项目判断，切走后整批派发被拒）。
 */
export function projectContaining(projects: Project[], dir: string): Project | null {
  let real: string;
  try { real = fs.realpathSync(dir); } catch { return null; }
  let best: Project | null = null;
  let bestLength = -1;
  for (const p of projects) {
    let root: string;
    try { root = fs.realpathSync(p.path); } catch { continue; }
    const relative = path.relative(root, real);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    if (root.length > bestLength) { best = p; bestLength = root.length; }
  }
  return best;
}

/** 外部 CLI 经 MCP 发起的渲染交给客户端解密配置，再由原执行进程链继续执行。 */
export function startOperationBroker(s: Server): () => void {
  const broker = operationBroker(async (request, signal, write) => {
    if (!director.KeyOps.has(request.name)) throw new Error('该操作不支持客户端转发');
    const project = projectContaining(s.registeredProjects(), request.cwd);
    if (!project) throw new Error('操作目录不在任何已登记的项目内');
    const cfg = config.load(project.path, envMap());
    const result = await runStudioOpWith(s, signal, project, {
      tool: typeof request.orchestrator === 'string' ? request.orchestrator : cfg.orchestrator,
      renderer: typeof request.renderer === 'string' ? request.renderer : cfg.renderer,
      rendererModel: typeof request.rendererModel === 'string' ? request.rendererModel : undefined,
      rendererOptions: typeof request.rendererOptions === 'string' ? request.rendererOptions : undefined,
    }, request.name, request.params, { env: { [OpBrokerRelayedEnv]: '1' }, onText: write });
    void result; // 输出（包括执行进程的结果标记）已经流式交回。
    return 0;
  });
  process.env[OpBrokerEnv] = broker.address;
  return () => {
    if (process.env[OpBrokerEnv] === broker.address) delete process.env[OpBrokerEnv];
    broker.close();
  };
}
