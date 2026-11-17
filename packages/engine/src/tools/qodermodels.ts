/**
 * Qoder 两个版本（qoder / qoder-intl）能选的模型，连同它们的说明、额度倍率、推理档位与上下文长度。
 *
 * `--list-models` 只打印显示名。完整的模型表只在 Qoder 自己的 SDK 协议里给（1.1.89 实测）：
 * `<命令> --sdk` 起一个守护进程，stdin / stdout 一行一个 JSON，按顺序发三个 control_request——
 *
 *   1. `daemon.initialize`：`daemon_protocol_version: 2`、能力里要有 `multi_session_v2`、`auth: {type: "qodercli"}`
 *      （沿用这台电脑上命令行已经登录的账号，只读；不给 auth 时第三步报 AUTH_PAYLOAD_REQUIRED）；
 *   2. `daemon.open_session`：`cwd` 与 `worker_args`（不能为空，按命令行参数解析；给 stream-json 两项），回应带 `session_id`；
 *   3. 带这个 `session_id` 的 `initialize`：回应的 `models` 每项有 `value`（模型键）、`displayName`、`priceFactor`（额度倍率）、
 *      `originalPriceFactor` / `promotion`（打折前的倍率与活动说明）、`isFree`、`efforts` 与 `defaultEffort`、
 *      `availableContextWindows` 与 `defaultContextWindow`。
 *
 * 整个过程不发提示词、不调模型，不花额度。说明文字不在协议里（`description` 是空的），Qoder 的模型选择器从
 * `<状态目录>/.auth/dynamic-texts.json` 读：`locales.<语言>["modelSelector.item.<模型键>.markdownDescription"]`。
 *
 * 读不出来（没登录、版本不认这套协议、超时）时由调用方退回 `--list-models`，界面至少还有名字可选。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { killTree, start } from '../procgroup';
import type { ModelOption } from './modellist';
import { qoderBinary } from './tools';

export const QoderSDKTimeout = 30_000;

/** 守护进程报回的一个模型（只取用到的字段）。 */
interface QoderModel {
  value?: unknown;
  displayName?: unknown;
  description?: unknown;
  isEnabled?: unknown;
  isDefault?: unknown;
  isFree?: unknown;
  priceFactor?: unknown;
  originalPriceFactor?: unknown;
  promotion?: unknown;
  efforts?: unknown;
  defaultEffort?: unknown;
  supportsDisabled?: unknown;
  availableContextWindows?: unknown;
  defaultContextWindow?: unknown;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** 两个版本各自的状态目录（说明文字的缓存在这里）。 */
export function qoderStateDir(tool: string, home = os.homedir()): string {
  return path.join(home, tool === 'qoder-intl' ? '.qoder' : '.qoder-cn');
}

/** 读模型说明：`<状态目录>/.auth/dynamic-texts.json`，中文优先，没有就英文。 */
export function readQoderDescriptions(stateDir: string): Map<string, string> {
  const out = new Map<string, string>();
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path.join(stateDir, '.auth', 'dynamic-texts.json'), 'utf8'));
  } catch {
    return out;
  }
  const locales = obj(obj(data).locales);
  const prefix = 'modelSelector.item.';
  const suffix = '.markdownDescription';
  // 先英文、后中文：中文覆盖英文。
  for (const locale of ['en', 'zh-CN']) {
    for (const [key, value] of Object.entries(obj(locales[locale]))) {
      if (!key.startsWith(prefix) || !key.endsWith(suffix) || typeof value !== 'string') continue;
      const model = key.slice(prefix.length, -suffix.length);
      if (model.includes('.')) continue; // .teams 这类团队版文案不用
      // 「[查看详情](https://…)」这类链接在下拉框里点不了，连文字一起去掉，再收掉留下的结尾标点。
      const text = value.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().replace(/[，,、；;：:\s]+$/u, '');
      if (text !== '') out.set(model, text);
    }
  }
  return out;
}

/** 活动的一句话（「错峰2折」）：只在活动生效时给。 */
function promotionBadge(promotion: unknown): string {
  const p = obj(promotion);
  if (p.active !== true) return '';
  const badge = obj(p.badge);
  return str(badge.zh) || str(badge.en);
}

/** 把守护进程报回的模型表译成下拉框的选项。id 用显示名：`-m` 对系统模型认的是名字（`--help` 原话）。 */
export function qoderModelOptions(models: unknown[], descriptions: Map<string, string>): ModelOption[] {
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const m = obj(raw) as QoderModel;
    if (m.isEnabled === false) continue;
    const key = str(m.value);
    const name = str(m.displayName) || key;
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const credit = num(m.priceFactor);
    const before = num(obj(m.promotion).before_promotion_price_factor) ?? num(m.originalPriceFactor);
    const efforts = Array.isArray(m.efforts) ? m.efforts.filter((e): e is string => typeof e === 'string' && /^[a-z]+$/.test(e) && e !== 'none') : [];
    const windows = Array.isArray(m.availableContextWindows) ? m.availableContextWindows.map(num).filter((n): n is number => n !== undefined && n > 0) : [];
    const description = descriptions.get(key.toLowerCase()) || str(m.description);
    const badge = promotionBadge(m.promotion);
    out.push({
      id: name,
      label: name,
      ...(description ? { description } : {}),
      ...(key && key !== name ? { key } : {}),
      ...(credit !== undefined ? { credit } : {}),
      ...(before !== undefined && credit !== undefined && before > credit ? { creditBefore: before } : {}),
      ...(m.isFree === true || (credit === 0 && before !== undefined) ? { free: true } : {}),
      ...(badge ? { promotion: badge } : {}),
      ...(m.isDefault === true ? { isDefault: true } : {}),
      // 推理档位按从低到高排，界面的分段按钮才不乱。不推理的模型给空数组：界面据此不出推理强度（不给是「不知道」）。
      efforts: efforts.length > 0 ? sortEfforts([...efforts, ...(m.supportsDisabled === true ? ['none'] : [])]) : [],
      ...(str(m.defaultEffort) ? { defaultEffort: str(m.defaultEffort) } : {}),
      ...(windows.length > 0 ? { contextWindows: [...new Set(windows)].sort((a, b) => a - b) } : {}),
      ...(num(m.defaultContextWindow) !== undefined ? { defaultContextWindow: num(m.defaultContextWindow) } : {}),
    });
  }
  return out;
}

const effortOrder = ['none', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'];
function sortEfforts(efforts: string[]): string[] {
  const rank = (e: string) => (effortOrder.includes(e) ? effortOrder.indexOf(e) : effortOrder.length);
  return [...new Set(efforts)].sort((a, b) => rank(a) - rank(b));
}

/**
 * 起 `<命令> --sdk`、按三步握手取模型表，拿到就结束进程。binary 是已经找到的可执行文件（lookPath 之后），
 * cwd 用一个空的临时目录（open_session 要一个工作目录；不在项目里起，免得它扫项目、跑项目的钩子）。
 */
export async function fetchQoderModels(tool: string, binary: string, env: Record<string, string>, signal?: AbortSignal, timeout = QoderSDKTimeout): Promise<ModelOption[]> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-qoder-models-'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${qoderBinary(tool)} 在 ${timeout / 1000} 秒内没有给出模型表`)), timeout);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const started = await start(binary, ['--sdk'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], signal: controller.signal });
  const child = started.child;
  const send = (frame: Record<string, unknown>) => child.stdin?.write(JSON.stringify(frame) + '\n');
  try {
    const models = await new Promise<unknown[]>((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('已取消')), { once: true });
      started.wait().then(
        () => reject(new Error(`${qoderBinary(tool)} --sdk 提前退出了`)),
        (err: Error) => reject(new Error(`${qoderBinary(tool)} --sdk 提前退出了：${err.message}`)),
      );
      const lines = readline.createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        let frame: Record<string, unknown>;
        try {
          frame = obj(JSON.parse(line));
        } catch {
          return;
        }
        if (frame.type !== 'control_response') return;
        const response = obj(frame.response);
        if (response.subtype === 'error') {
          reject(new Error(`${str(response.error) || '握手失败'}${response.code ? `（${str(response.code)}）` : ''}`));
          return;
        }
        switch (response.request_id) {
          case 'onset-daemon':
            send({ type: 'control_request', request_id: 'onset-open', request: { subtype: 'daemon.open_session', cwd, worker_args: ['--output-format', 'stream-json', '--input-format', 'stream-json'] } });
            break;
          case 'onset-open': {
            const session = str(frame.session_id) || str(response.session_id);
            if (session === '') reject(new Error('daemon.open_session 没有给会话号'));
            else send({ type: 'control_request', request_id: 'onset-init', session_id: session, request: { subtype: 'initialize' } });
            break;
          }
          case 'onset-init': {
            const models = obj(response.response).models ?? response.models;
            if (Array.isArray(models)) resolve(models);
            else reject(new Error('initialize 的回应里没有模型表'));
            break;
          }
        }
      });
      send({
        type: 'control_request',
        request_id: 'onset-daemon',
        request: { subtype: 'daemon.initialize', daemon_protocol_version: 2, sdk_version: '1.0.0', capabilities: ['multi_session_v2'], auth: { type: 'qodercli' } },
      });
    });
    return qoderModelOptions(models, readQoderDescriptions(qoderStateDir(tool, env.HOME || os.homedir())));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    child.stdin?.end();
    if (child.pid !== undefined && child.exitCode === null && !killTree(child.pid)) child.kill();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
