/**
 * 调用选项的一行文字（effort=high,fast=on）在界面里的读写，与后端 tools/options.ts 的 parseAgentOptions /
 * formatAgentOptions 同一种写法：键按字母排，空值不写。
 */
import type { AgentOptionSpec, ModelOption } from './types';

export function parseOptions(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (text ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (key !== '' && value !== '') out[key] = value;
  }
  return out;
}

export function formatOptions(options: Record<string, string>): string {
  return Object.keys(options)
    .filter((key) => options[key] !== '')
    .sort()
    .map((key) => `${key}=${options[key]}`)
    .join(',');
}

/** 改一项：value 为空就去掉这一项。 */
export function withOption(text: string, key: string, value: string): string {
  const options = parseOptions(text);
  if (value === '') delete options[key];
  else options[key] = value;
  return formatOptions(options);
}

const effortNames: Record<string, string> = {
  auto: '自动',
  none: '不推理',
  off: '不思考',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '极限',
  ultracode: 'Ultracode',
};

/** 分段按钮上的短名：档位用两三个字（后端的名字可能带说明，例如「极限（自动分派子任务）」放进提示）。 */
export function shortLabel(spec: AgentOptionSpec, value: string): string {
  if (spec.kind === 'choice') return effortNames[value] ?? labelOf(spec, value);
  return labelOf(spec, value);
}

/**
 * 一项选项能选的值：推理强度按模型收窄（codex 的目录里每个模型的档位不一样），模型报了表里没有的新档位也列上；
 * 快速模式是开 / 关；上下文长度是常用的几档。当前值不在里面时照样列出来，不被悄悄换掉。
 */
export function optionChoices(spec: AgentOptionSpec, model: ModelOption | undefined, current: string): { value: string; label: string }[] {
  let list: { value: string; label: string }[];
  if (spec.kind === 'toggle') list = [{ value: 'on', label: '开' }, { value: 'off', label: '关' }];
  else if (spec.kind === 'number') {
    // 模型报了能选的长度（qoder）就只列这几档，不然列常用的几档。
    const windows = spec.perModel && model?.contextWindows && model.contextWindows.length > 0 ? model.contextWindows : null;
    list = windows ? windows.map((n) => ({ value: String(n), label: labelOf(spec, String(n)) })) : [...(spec.presets ?? [])];
  }
  else {
    list = [...(spec.choices ?? [])];
    if (spec.perModel && model?.efforts && model.efforts.length > 0) {
      const known = new Map(list.map((c) => [c.value, c.label]));
      list = model.efforts.map((value) => ({ value, label: known.get(value) ?? effortNames[value] ?? value }));
    }
  }
  if (current !== '' && !list.some((c) => c.value === current)) list.push({ value: current, label: labelOf(spec, current) });
  return list;
}

/** 一个值给人看的写法：上下文长度写成 200K、1M，档位用中文名。 */
export function labelOf(spec: AgentOptionSpec, value: string): string {
  if (spec.kind === 'toggle') return value === 'on' ? '开' : value === 'off' ? '关' : value;
  if (spec.kind === 'number') {
    const preset = spec.presets?.find((p) => p.value === value);
    if (preset) return preset.label;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1000) return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;
    return value;
  }
  return spec.choices?.find((c) => c.value === value)?.label ?? effortNames[value] ?? value;
}

/** 不选这一项时这个模型实际用的值（qoder 的模型表给默认推理档位与上下文长度）；不知道时为空。 */
export function modelDefault(spec: AgentOptionSpec, model: ModelOption | undefined): string {
  if (!model) return '';
  if (spec.key === 'effort') return model.defaultEffort ?? '';
  if (spec.key === 'context') return model.defaultContextWindow ? String(model.defaultContextWindow) : '';
  return '';
}

/** 模型列表里的额度标签：免费、「8.00x」、打折前的倍率与活动。 */
export function creditTag(model: ModelOption): { text: string; before?: string; promotion?: string } | null {
  if (model.free) return { text: '免费', ...(model.creditBefore ? { before: `${model.creditBefore.toFixed(2)}x` } : {}), ...(model.promotion ? { promotion: model.promotion } : {}) };
  if (model.credit === undefined) return null;
  return { text: `${model.credit.toFixed(2)}x`, ...(model.creditBefore ? { before: `${model.creditBefore.toFixed(2)}x` } : {}), ...(model.promotion ? { promotion: model.promotion } : {}) };
}

/** 这一项此时该不该出现：模型明确不支持快速档位时不列（已经开着的照样列，好关掉）。 */
export function optionVisible(spec: AgentOptionSpec, model: ModelOption | undefined, current: string): boolean {
  if (spec.key === 'fast' && model?.fast === false && current === '') return false;
  // 模型表说这个模型不推理（qoder 的 efforts 是空数组）：没有推理强度可选。
  if (spec.key === 'effort' && spec.perModel && model?.efforts && model.efforts.length === 0 && current === '') return false;
  return true;
}
