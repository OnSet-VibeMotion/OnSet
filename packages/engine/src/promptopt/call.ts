/**
 * 调一次模型：用设置里的优化工具（OPTIMIZER，空则跟随编排工具）在一个空的临时目录里跑一次，收回它说的话。
 *
 * 不开对话轮次、不挂 onset 的工具服务、不放行任何命令：要的材料都在提示词里，它只需要回一个 JSON。
 * 花的钱照样记进项目的账本（ledger），失败与取消也记。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agentrun from '../agentrun';
import type { Config } from '../config';
import { addToolsLocation, lookPath } from '../envutil';
import * as ledger from '../ledger';
import * as tools from '../tools';

/** 实际用的优化工具与模型：OPTIMIZER 为空时跟随（这一轮的）编排工具与编排模型。 */
export function optimizerOf(cfg: Pick<Config, 'optimizer' | 'optimizerModel' | 'orchestrator' | 'orchestratorModel'>): { tool: string; model: string } {
  if (cfg.optimizer !== '') return { tool: cfg.optimizer, model: cfg.optimizerModel };
  return { tool: cfg.orchestrator, model: cfg.orchestratorModel };
}

export interface CallOptions {
  tool: string;
  model: string;
  prompt: string;
  /** 子进程环境，由调用方按安全模式白名单算好（config.childEnvironment）。 */
  env: Record<string, string>;
  unsafe: boolean;
  signal?: AbortSignal;
  /** 记账的文件（ledger.projectFile）；空则不记。 */
  ledgerFile?: string;
  /** 记账的来源（ledger.SourcePolish / SourcePromptCheck）。 */
  source: string;
}

/** 跑一次，返回它说的全部正文（多段之间换行）。失败时抛错，取消时抛 AbortError。 */
export async function callOnce(o: CallOptions): Promise<string> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-promptopt-'));
  const texts: string[] = [];
  // 与起名（studio/naming.ts）一样：onset setup 装的工具目录接在 PATH 末尾，找得到导演之外的几家 CLI。
  const env = { ...o.env };
  addToolsLocation(env);
  try {
    const { result, error } = await agentrun.run(
      {
        tool: o.tool,
        model: o.model,
        workdir,
        prompt: o.prompt,
        unsafe: o.unsafe,
        sessionID: agentrun.newSessionID(o.tool),
        // 只要它回话，不需要任何命令。
        access: { commands: [] },
        env,
        lookPath: (name) => lookPath(name, env.PATH ?? ''),
      },
      (event) => {
        if (event.kind === agentrun.KindText && event.text) texts.push(event.text);
      },
      o.signal,
    );
    if (result.started && o.ledgerFile) record(o, result, error);
    if (o.signal?.aborted) throw abortError();
    if (error) throw new Error(`${o.tool} 没有跑完：${error.message}${result.stderr ? `\n${result.stderr.trim()}` : ''}`, { cause: error });
    return texts.join('\n');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function abortError(): Error {
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

function record(o: CallOptions, result: agentrun.Result, error: Error | null): void {
  const model = result.model !== '' ? result.model : o.model !== '' ? o.model : tools.configuredModel(o.tool, o.env);
  const cancelled = (o.signal?.aborted ?? false) || error?.name === 'AbortError';
  try {
    ledger.append(o.ledgerFile!, ledger.fromResult(o.source, o.tool, model, result.sessionID, result.usage, error, cancelled));
  } catch {
    // 账没记上不让一次已经跑完的调用失败。
  }
}
