/**
 * 设置页的后端：/api/settings。
 *
 * 全局设置在用户级目录（config/global.ts），与安装页、音色库一样在进程里直接写；
 * 「这个项目」一栏改的是项目的 onset.conf，那是项目文件，走写任务（config_set），
 * 不和一轮对话的快照打架。
 *
 *   GET  /api/settings          每一项：可选值、全局值、这个项目的值、现在实际用的值与来历
 *   POST /api/settings/global   {key, value}：改全局设置；value 为空回到内置默认
 *   POST /api/settings/project  {key, value}：改这个项目；value 为空改为跟随全局（写任务，返回 task_id）。
 *                               key 为 * 时把这个项目的全部几项都改回跟随全局
 */
import * as config from '../config';
import { envMap } from '../envutil';
import * as tools from '../tools';
import { agentOrder } from './agents';
import { DecodeError, decodeJSON, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import type { Server } from './studio';
import { runStudioOp, runWriteTask, writeTaskError } from './tasks';
import * as flow from '../flow';

/** 下拉框里的短名字：providers.ts 里的名字带着命令名与平台说明，放进下拉框会被截断。 */
const ttsNames: Record<string, string> = {
  minimax: 'MiniMax',
  bailian: '阿里云百炼',
  edge: '微软 Edge 朗读（免费，适合预览）',
  elevenlabs: 'ElevenLabs',
  tencent: '腾讯云',
  mlx: '本机 MLX（Qwen3-TTS）',
  breeze: process.platform === 'win32' ? 'Breeze TTS 2（本机 CUDA）' : 'Breeze TTS 2（本机）',
};
const alignNames: Record<string, string> = { mlx: '本机 MLX', funasr: 'FunASR' };

interface Option {
  value: string;
  label: string;
}

/** 每一项在界面上的名字、一句说明与可选值。 */
function describe(key: config.GlobalKey): { label: string; hint: string; options: Option[]; modelOf?: string } {
  const agents = agentOrder.map((a) => ({ value: a.id, label: a.label }));
  switch (key) {
    case 'ORCHESTRATOR':
      return { label: '对话助手', hint: '和你聊天、写口播稿、拆分镜、安排镜头去画的那位。选「导演」不用另装软件，在下面填一套模型服务就能用', options: agents };
    case 'ORCHESTRATOR_MODEL':
      // 可选的模型跟着工具变，由界面按工具去 /api/agents/{工具}/models 取，这里不列。
      return { label: '对话助手的模型', hint: '不确定就选「默认」，由上面那家工具自己决定；换了工具会自动回到默认', options: [], modelOf: 'ORCHESTRATOR' };
    case 'RENDERER':
      // 导演暂时只做编排（tools.ValidRenderers）。
      return { label: '画镜头的工具', hint: '把每个镜头的画面做出来的那位，要先装在这台电脑上', options: agents.filter((a) => tools.ValidRenderers.has(a.value)) };
    case 'RENDERER_MODEL':
      return { label: '画镜头的模型', hint: '不确定就选「默认」，由上面那家工具自己决定；换了工具会自动回到默认', options: [], modelOf: 'RENDERER' };
    case 'OPTIMIZER':
      // 空是跟随对话助手（promptopt.optimizerOf），界面把空显示成「跟随对话助手」。
      return {
        label: '润色与检查',
        hint: '润色你在输入框里写的话、检查镜头画面描述时用的工具；可以选一家便宜些的，留空跟随对话助手',
        options: agents,
      };
    case 'OPTIMIZER_MODEL':
      return { label: '润色与检查的模型', hint: '跟随对话助手时也跟随它的模型；换了工具会自动回到默认', options: [], modelOf: 'OPTIMIZER' };
    case 'TTS_PROVIDER':
      return { label: '配音', hint: '用谁把口播稿读出来', options: config.TTSProviders.map((p) => ({ value: p.id, label: ttsNames[p.id] ?? p.name })) };
    case 'ALIGN_PROVIDER':
      return {
        label: '字幕对齐',
        hint: '让字幕和声音一个字一个字对上。不确定就选「自动」，会按这台电脑挑合适的',
        options: [{ value: config.AlignAuto, label: '自动' }, ...config.Aligners.map((a) => ({ value: a.id, label: alignNames[a.id] ?? a.name }))],
      };
    case 'SCENE_JOBS':
      return { label: '同时画几个镜头', hint: '越多越快，但更占电脑，也更快用完 AI 的额度', options: Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 个镜头` })) };
    case 'MEMORY':
      return {
        label: '记住出过的问题',
        hint: '把画镜头时出过的错和你提过的要求记下来，下次画的时候提醒它',
        options: [
          { value: 'on', label: '记住' },
          { value: 'off', label: '不记' },
        ],
      };
    case 'AUTO_APPROVE':
      return {
        label: '执行操作前问我',
        hint: 'AI 有时要在你的电脑上执行不常见的操作。选「每次都问我」会先弹出卡片等你同意；不管选哪个，对话里都会记下它做了什么',
        options: [
          { value: 'off', label: '每次都问我' },
          { value: 'on', label: '不用问，直接做' },
        ],
      };
  }
}

export function settingsAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const env = envMap();
  const root = s.projectRoot();
  let rows: config.SettingRow[];
  try {
    rows = config.describeSettings(root, env);
  } catch (err) {
    return writeError(500, 'settings_unreadable', (err as Error).message);
  }
  return writeJSON(
    200,
    goMap({
      file: config.settingsFile(env),
      has_project: root !== '',
      rows: rows.map((r) => {
        const d = describe(r.key);
        // 已装的第三方插件提供的配音、对齐，也列进可选项。
        if (r.key === 'TTS_PROVIDER' || r.key === 'ALIGN_PROVIDER') d.options = [...d.options, ...pluginProviders(r.key === 'TTS_PROVIDER' ? 'tts' : 'align')];
        return goMap({
          key: r.key,
          label: d.label,
          hint: d.hint,
          options: d.options,
          model_of: d.modelOf,
          default: config.GlobalDefaults[r.key],
          global: r.global,
          project: r.project,
          effective: r.effective,
          source: r.source,
        });
      }),
    }),
  );
}

async function readKeyValue(request: Request): Promise<{ key: string; value: string } | Response> {
  try {
    const body = await decodeJSON(request);
    return { key: fieldString(body, 'key'), value: fieldString(body, 'value').trim() };
  } catch (err) {
    return writeError(400, 'invalid_json', err instanceof DecodeError ? err.message : (err as Error).message);
  }
}

export async function settingsGlobalAPI(request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const kv = await readKeyValue(request);
  if (kv instanceof Response) return kv;
  try {
    config.writeGlobal(envMap(), { [kv.key]: kv.value }, config.parseConfFile);
  } catch (err) {
    return writeError(400, 'invalid_setting', (err as Error).message);
  }
  return writeJSON(200, goMap({ key: kv.key, value: kv.value }));
}

export async function settingsProjectAPI(s: Server, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const kv = await readKeyValue(request);
  if (kv instanceof Response) return kv;
  if (kv.key === '*') {
    try {
      const t = runWriteTask(s, p, 'settings.project', '这个项目全部跟随全局设置', async (signal) => {
        for (const key of config.GlobalKeys) await runStudioOp(s, signal, p, 'config_set', { key, value: '', project_root: p.path });
      });
      return writeJSON(202, goMap({ task_id: t.task_id }));
    } catch (err) {
      return writeTaskError(err);
    }
  }
  const problem = config.validateSetting(kv.key, kv.value);
  if (problem !== '') return writeError(400, 'invalid_setting', problem);
  const label = config.isGlobalKey(kv.key) ? describe(kv.key).label : kv.key;
  try {
    const t = runWriteTask(s, p, 'settings.project', kv.value === '' ? `${label}改为跟随全局` : `这个项目的${label}：${kv.value}`, async (signal) => {
      await runStudioOp(s, signal, p, 'config_set', { key: kv.key, value: kv.value, project_root: p.path });
    });
    return writeJSON(202, goMap({ task_id: t.task_id }));
  } catch (err) {
    return writeTaskError(err);
  }
}

/** 已装的第三方插件提供的配音或对齐工具（设置页的可选项，全局与项目一栏都能选）。 */
function pluginProviders(kind: 'tts' | 'align'): { value: string; label: string }[] {
  return flow
    .loadStations()
    .stations.filter((s) => s.manifest.provides[kind])
    .map((s) => ({ value: `x:${s.manifest.id}`, label: `${s.manifest.provides[kind]!.name}（插件）` }));
}
