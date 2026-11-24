import path from 'node:path';
import { dataDir } from '../envutil';

/** 工具名：ORCHESTRATOR=director。 */
export const Tool = 'director';

/** 覆盖制作人数据目录（模型服务、会话）的环境变量。 */
export const DirEnv = 'ONSET_AGENT_DIR';

/** 制作人的数据目录：ONSET_AGENT_DIR，否则 <数据目录>/onset/agent。环境里什么都没有时为空。 */
export function defaultDir(env: Record<string, string | undefined>): string {
  if (env[DirEnv]) return env[DirEnv]!;
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'agent');
}

/**
 * 模型服务文件，权限 0600：{active, services: [{id, name, preset, protocol, base_url, model, vision, key | enc}]}。
 * key 在客户端里经 safeStorage 加密（enc），没有加密可用时是明文（key）。只有父进程读它（resolveService），
 * 制作人子进程与 pi 都不读。
 */
export function servicesFile(dir: string): string {
  return path.join(dir, 'services.json');
}

/** 会话文件的根目录：数据目录下的 sessions/，再按项目路径分子目录（见 packages/cli/src/agent/pi.ts）。 */
export function sessionsDir(dir: string): string {
  return path.join(dir, 'sessions');
}

/**
 * 协议：openai 是 OpenAI 的 Chat Completions（/chat/completions），国内几家与 OpenRouter 都兼容；
 * anthropic 是 Anthropic 的 Messages（/v1/messages），Claude 与 MiniMax 的 Anthropic 端点用它。
 */
export type Protocol = 'openai' | 'anthropic';
export const Protocols: readonly Protocol[] = ['openai', 'anthropic'];

/** 协议对应的 pi 接口名。 */
export function piApi(protocol: Protocol): 'openai-completions' | 'anthropic-messages' {
  return protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
}

/**
 * 预设：只用来预填表单。base URL 与模型取自 pi 1.4.0 自带的模型目录（2026-11 核对过）：预设的 base URL 与目录里
 * 那家服务商一致时，pi 目录里这个模型的上下文长度、推理参数会被沿用（见 packages/cli/src/agent/pi.ts 的 serviceModel），
 * 所以改预设时要对着目录改，packages/cli/src/agent/catalog.test.ts 钉着。
 */
export interface Preset {
  id: string;
  label: string;
  protocol: Protocol;
  baseURL: string;
  model: string;
  /** 推荐模型能不能读图。画面验收与整片复查要看截图，看不了图的模型只能请用户看。 */
  vision: boolean;
  /** 申请 API key 的页面，界面上给一个链接。 */
  keyURL: string;
}

export const Presets: readonly Preset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    vision: false,
    keyURL: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    protocol: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    vision: true,
    keyURL: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'glm',
    label: '智谱 GLM（Coding Plan）',
    protocol: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'glm-5.3',
    vision: false,
    keyURL: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    id: 'bailian',
    label: '阿里云百炼（Token Plan）',
    protocol: 'openai',
    baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    vision: true,
    keyURL: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'anthropic',
    baseURL: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M3',
    vision: true,
    keyURL: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'anthropic',
    label: 'Anthropic（Claude）',
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    model: 'claude-sonnet-5-5',
    vision: true,
    keyURL: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    vision: true,
    keyURL: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'anthropic',
    baseURL: 'https://openrouter.ai/api',
    model: 'anthropic/claude-sonnet-5.5',
    vision: true,
    keyURL: 'https://openrouter.ai/keys',
  },
];

/** base URL 去掉首尾空白与结尾的斜杠；不是 http(s) 地址时报错。 */
export function normalizeBaseURL(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error('base URL 不是合法的网址：' + raw);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('base URL 只能是 http 或 https 地址');
  return v;
}
