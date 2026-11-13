/**
 * 设置页的后端：/api/settings。
 *
 * 全局设置在用户级目录（config/global.ts），与安装页、音色库一样在进程里直接写；
 * 「这个项目」一栏改的是项目的 article-to-motion.conf，那是项目文件，走写任务（config_set），
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
  breeze: 'Breeze TTS 2（本机）',
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
      return { label: '编排', hint: '和你对话、写稿、定分镜、调度渲染的工具；导演不用另装，填下面的模型服务密钥就能用', options: agents };
    case 'ORCHESTRATOR_MODEL':
      // 可选的模型跟着工具变，由界面按工具去 /api/agents/{工具}/models 取，这里不列。
      return { label: '编排模型', hint: '留空用这家工具自己的默认模型；换了工具会回到默认', options: [], modelOf: 'ORCHESTRATOR' };
    case 'RENDERER':
      // 导演暂时只做编排（tools.ValidRenderers）。
      return { label: '渲染', hint: '把每个镜头画出来的工具', options: agents.filter((a) => tools.ValidRenderers.has(a.value)) };
    case 'RENDERER_MODEL':
      return { label: '渲染模型', hint: '留空用这家工具自己的默认模型；换了渲染工具会回到默认', options: [], modelOf: 'RENDERER' };
    case 'TTS_PROVIDER':
      return { label: '配音', hint: '把口播稿读成配音', options: config.TTSProviders.map((p) => ({ value: p.id, label: ttsNames[p.id] ?? p.name })) };
    case 'ALIGN_PROVIDER':
      return {
        label: '字幕对齐',
        hint: '让字幕和配音逐字对上；自动是 Apple Silicon 用本机 MLX，其余用 FunASR',
        options: [{ value: config.AlignAuto, label: '自动' }, ...config.Aligners.map((a) => ({ value: a.id, label: alignNames[a.id] ?? a.name }))],
      };
    case 'SCENE_JOBS':
      return { label: '同时渲染', hint: '一次并排渲染几个镜头；越多越快，也越吃机器和额度', options: Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 个镜头` })) };
    case 'MEMORY':
      return {
        label: '渲染记忆',
        hint: '记下渲染里出过的问题和你的要求，下次带上',
        options: [
          { value: 'on', label: '打开' },
          { value: 'off', label: '关闭' },
        ],
      };
    case 'AUTO_APPROVE':
      return {
        label: '自动批准',
        hint: 'AI 要跑白名单外的命令时，不再弹卡片问你、直接允许；对话里照样记下它跑了什么',
        options: [
          { value: 'off', label: '每次问我' },
          { value: 'on', label: '直接允许' },
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
