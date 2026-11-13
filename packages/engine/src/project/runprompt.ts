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
}

/**
 * 按项目的流程组合出整片制作的提示词（flow.composeFlowPrompt）：流程只来自锁文件里的记录（没有记录直接报错），
 * 画幅取记录里的，关掉的内置插件的站不参与，第三方站的阶段补充与说明按组合规则插进去。项目里不放提示词文件。
 */
export function composeProjectPrompt(root: string): { text: string; flow: flow.FlowID; name: string } {
  const rec = flow.flowRecord(root);
  const extras = flow.loadProjectStations(root);
  if (extras.problems.length > 0) throw new Error(extras.problems.join('\n'));
  const id = flow.detectFlow(root, flow.projectExtras(root));
  // detectFlow 没报错就一定有记录；画幅不认得时说清楚是哪一段写错了。
  const p = preset.byID(rec?.canvas ?? '');
  if (!p) throw new flow.MissingFlowRecordError(`${flow.LockFile} 的 production.canvas 不是认得的画幅：${rec?.canvas ?? ''}（可选：${preset.ids().join('、')}）`);
  const text = flow.composeFlowPrompt({ flow: id, stations: extras.stations, disabled: new Set(flow.disabledAmStations(root)), canvas: (t) => substituteCanvas(p, t) });
  return { text, flow: id, name: flow.flow(id, flow.projectExtras(root)).name };
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
    return { prompt, path: file, label: file };
  }
  const { text, name } = composeProjectPrompt(root);
  return { prompt: Buffer.from(text), path: '', label: `${name}流程` };
}
