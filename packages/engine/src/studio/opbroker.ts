import fs from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import * as director from '../director';
import { envMap } from '../envutil';
import { operationBroker, OpBrokerEnv, OpBrokerRelayedEnv } from '../opworker';
import { runStudioOpWith } from './tasks';
import type { Server } from './studio';

/** 外部 CLI 经 MCP 发起的渲染交给客户端解密配置，再由原执行进程链继续执行。 */
export function startOperationBroker(s: Server): () => void {
  const broker = operationBroker(async (request, signal, write) => {
    if (!director.KeyOps.has(request.name)) throw new Error('该操作不支持客户端转发');
    const project = s.currentProject();
    const relative = path.relative(fs.realpathSync(project.path), fs.realpathSync(request.cwd));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('操作目录不在当前项目内');
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
