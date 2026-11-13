// 移植自 internal/memory/models.go。
import path from 'node:path';
import { sortedKeys } from '../gojson';
import { configuredModel } from '../tools';
import { rfc3339 } from './gostr';
import { readJSON, writeJSON } from './io';
import type { Store } from './store';

/**
 * 记录每个渲染工具最近一次实测到的模型。
 *
 * 召回发生在渲染器启动之前，而 claude 这类工具只在输出流里报模型名，
 * 所以渲染前能拿到的「当前模型」只能是上一次实测到的那个；换了模型的
 * 第一次渲染会按旧模型召回，渲染完立刻更新。
 */
export const modelsFile = 'models.json';

interface ObservedModel {
  model: string;
  seen_at: string;
}

/** `_ = readJSON(path, &seen)`：读不出来就当空表。 */
function readSeen(file: string): Record<string, ObservedModel> {
  const seen: Record<string, ObservedModel> = {};
  let raw: unknown;
  try {
    raw = readJSON(file);
  } catch {
    return seen;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return seen;
  for (const [renderer, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = (value ?? {}) as Record<string, unknown>;
    seen[renderer] = {
      model: typeof v.model === 'string' ? v.model : '',
      seen_at: typeof v.seen_at === 'string' ? v.seen_at : '',
    };
  }
  return seen;
}

/** 记下渲染工具这次实测到的模型。 */
export function observeModel(s: Store, renderer: string, model: string): void {
  if (renderer === '' || model === '') return;
  const file = path.join(s.dir, modelsFile);
  const seen = readSeen(file);
  if (seen[renderer]?.model === model) return;
  seen[renderer] = { model, seen_at: rfc3339(s.clock()) };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(seen)) out[key] = { model: value.model, seen_at: value.seen_at };
  writeJSON(file, sortedKeys(out));
}

/**
 * 渲染工具当前的模型：工具配置文件声明的默认模型优先
 * （codex 的 config.toml），否则取最近一次实测到的；都没有时返回空串。
 */
export function currentModel(s: Store, renderer: string, env: Record<string, string | undefined>): string {
  const configured = configuredModel(renderer, env);
  if (configured !== '') return configured;
  return readSeen(path.join(s.dir, modelsFile))[renderer]?.model ?? '';
}
