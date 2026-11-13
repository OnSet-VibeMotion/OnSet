import fs from 'node:fs';
import path from 'node:path';
import * as flow from '../flow';
import * as preset from '../preset';
import { substituteCanvas } from '../preset/gen/gen';

export interface RunPromptResult {
  prompt: Buffer;
  /** 显式指定的提示词文件（override）；按流程组合时为空。 */
  path: string;
  /** 给人看的出处：override 时是那份文件的路径，组合时是「<流程名>流程」。 */
  label: string;
  /** 读不出来、但不参与这个项目制作的插件：照常开工，要让用户看见。 */
  warnings: string[];
}

/**
 * 按项目的流程组合出整片制作的提示词（flow.composeFlowPrompt）：流程只来自锁文件里的记录（没有记录直接报错），
 * 画幅取记录里的，第三方插件的阶段补充与说明按组合规则插进去。项目里不放提示词文件。
 *
 * 插件装在用户级：读不出来的插件只在它参与这个项目的制作时（流程是它带来的、它顶替或接进了这条路线）让开工报错，
 * 其余的放进 warnings，由调用方让用户看见。
 */
export function composeProjectPrompt(root: string): { text: string; flow: flow.FlowID; name: string; warnings: string[] } {
  const rec = flow.flowRecord(root);
  const loaded = flow.loadStations();
  const extras = loaded.stations.map((s) => flow.toExtra(s.manifest));
  const own = rec?.id.startsWith('x:') ? loaded.problems.find((p) => `x:${p.id}` === rec.id) : undefined;
  if (own) throw new flow.MissingFlowRecordError(`这个项目用的是插件「${own.id}」带来的做法，但它现在读不出来：${own.message}`);
  const id = flow.detectFlow(root, extras);
  const def = flow.flow(id, extras);
  const blocking = flow.brokenParticipants(
    id,
    loaded.problems,
    def.stations,
    flow.route(id, extras).map((r) => r.node),
  );
  if (blocking.length > 0) throw new Error(blocking.map((p) => p.message).join('\n'));
  const warnings = loaded.problems.map((p) => `${p.message}（这个项目用不到它的站，照常开工；它带的说明、技能与风格这次不在）`);
  // 流程自己的配置（例如歌曲讲解的 song.yaml）由登记它的插件核对：宿主不 import 任何功能包。
  def.check?.(root);
  // detectFlow 没报错就一定有记录；画幅不认得时说清楚是哪一段写错了。
  const p = preset.byID(rec?.canvas ?? '');
  if (!p) throw new flow.MissingFlowRecordError(`${flow.LockFile} 的 production.canvas 不是认得的画幅：${rec?.canvas ?? ''}（可选：${preset.ids().join('、')}）`);
  const text = flow.composeFlowPrompt({ flow: id, stations: loaded.stations, canvas: (t) => substituteCanvas(p, t) });
  return { text, flow: id, name: def.name, warnings };
}

/**
 * runPrompt 给出整片制作发给编排工具的提示词，am run 与客户端的「开始制作」共用。
 *
 * override 非空时原样读那份文件（显式指定的提示词，不再组合、不接任何插件的说明）；否则按流程组合（composeProjectPrompt）。
 */
export function runPrompt(root: string, override: string): RunPromptResult {
  if (override !== '') {
    const file = path.resolve(override);
    let prompt: Buffer;
    try {
      prompt = fs.readFileSync(file);
    } catch (err) {
      throw new Error(`找不到 prompt 文件：${file}`, { cause: err });
    }
    return { prompt, path: file, label: file, warnings: [] };
  }
  const { text, name, warnings } = composeProjectPrompt(root);
  return { prompt: Buffer.from(text), path: '', label: `${name}流程`, warnings };
}
