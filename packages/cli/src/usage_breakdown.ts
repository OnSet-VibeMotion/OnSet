/**
 * 用量诊断拆账（缓存命中率、重试/返修浪费、预览次数与高耗镜头排行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as scene from '@onset/engine/scene';
import * as tools from '@onset/engine/tools';
import type { Out } from './cobra';

export interface SceneDiagnostics {
  scene_id: string;
  attempts: number;
  retries: number;
  repairs: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cache_hit_rate: number | null;
  turns: number;
  preview_calls: number;
  cost_usd: number;
}

export interface UsageBreakdown {
  render_cache_hit_rate: number | null;
  orchestrator_cache_hit_rate: number | null;
  retry_and_repair_input_tokens: number;
  retry_and_repair_output_tokens: number;
  top_scenes: SceneDiagnostics[];
}

function cacheHitRate(u: tools.Usage): number | null {
  const input = u.input_tokens ?? 0;
  const cached = u.cached_input_tokens ?? 0;
  if (input <= 0) return null;
  return Math.round((cached / input) * 1000) / 10;
}

function isPreviewTool(name: string, args: unknown): boolean {
  if (name.includes('scene_preview_check')) return true;
  if (name === 'call_mcp_tool' && args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    const nested = String(a.ToolName ?? a.tool_name ?? '');
    return isPreviewTool(nested, a.Arguments ?? a.arguments);
  }
  if (name.includes('hyperframes')) {
    const raw = typeof args === 'string' ? args : JSON.stringify(args ?? '');
    return raw.includes('snapshot');
  }
  if (/^(?:bash|shell|run_command)$/i.test(name)) {
    const cmd =
      typeof args === 'string'
        ? args
        : args && typeof args === 'object'
          ? String((args as Record<string, unknown>).command ?? (args as Record<string, unknown>).CommandLine ?? '')
          : '';
    return /\bhyperframes\b[^\n]*\bsnapshot\b/.test(cmd);
  }
  return false;
}

function countStreamPreviews(dir: string, id: string): number {
  const file = path.join(dir, `render-${id}.stream.jsonl`);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const seen = new Set<string>();
  let anonSeq = 0;
  let fallback = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || (!line.includes('scene_preview_check') && !line.includes('hyperframes'))) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      const val = JSON.parse(line);
      if (val && typeof val === 'object' && !Array.isArray(val)) parsed = val as Record<string, unknown>;
    } catch {
      // Fall through to line-level fallback.
    }
    if (!parsed) {
      if (/scene_preview_check|hyperframes[^}\n]*snapshot/.test(line)) fallback++;
      continue;
    }
    // agy stream-json：同一 tool 调用会发 ACTIVE 与 DONE 两条 step_update，按 step_index 去重。
    if (parsed.event === 'step_update' && parsed.step_update && typeof parsed.step_update === 'object') {
      const step = parsed.step_update as Record<string, unknown>;
      if (step.step_type === 'tool') {
        const name = typeof step.tool_name === 'string' ? step.tool_name : '';
        const info =
          step.tool_info && typeof step.tool_info === 'object'
            ? (step.tool_info as Record<string, unknown>)
            : undefined;
        if (isPreviewTool(name, info?.parameters)) {
          const idx = step.step_index !== undefined ? String(step.step_index) : `anon:${anonSeq++}`;
          seen.add(`agy:${idx}`);
        }
      }
      continue;
    }
    // claude / qoder / codebuddy / director：assistant 消息里的 tool_use 块，按 id 去重。
    if (parsed.type === 'assistant' && parsed.message && typeof parsed.message === 'object') {
      const content = (parsed.message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use' && typeof b.name === 'string' && isPreviewTool(b.name, b.input)) {
            seen.add(`tu:${typeof b.id === 'string' && b.id ? b.id : `anon:${anonSeq++}`}`);
          }
        }
      }
      continue;
    }
    // 忽略 tool_result / user / result 汇总行，防止正文里提到工具名被重复计数。
    if (parsed.event === 'result' || parsed.type === 'user' || parsed.type === 'result') continue;
    // codex / mcode / opencode item 事件。
    if (parsed.item && typeof parsed.item === 'object') {
      const item = parsed.item as Record<string, unknown>;
      const name = typeof item.tool === 'string' ? item.tool : typeof item.name === 'string' ? item.name : '';
      if (name && isPreviewTool(name, item.arguments ?? item.input)) {
        seen.add(`item:${typeof item.id === 'string' && item.id ? item.id : `anon:${anonSeq++}`}`);
      }
      continue;
    }
    if (/scene_preview_check|hyperframes[^}\n]*snapshot/.test(line)) fallback++;
  }
  return seen.size + fallback;
}

export function buildBreakdown(
  scenes: readonly scene.Scene[],
  renderTotal: tools.Usage,
  orchestratorTotal: tools.Usage,
): UsageBreakdown {
  let retryInput = 0;
  let retryOutput = 0;
  const rows: SceneDiagnostics[] = [];
  for (const s of scenes) {
    const history = scene.attemptHistory(s.directory, s.id);
    if (history.length === 0) continue;
    const sum = tools.newUsage();
    let retries = 0;
    let repairs = 0;
    for (const attempt of history) {
      const u = attempt.usage ?? tools.newUsage();
      tools.usageAdd(sum, u);
      if (attempt.retry) {
        retries++;
        retryInput += u.input_tokens ?? 0;
        retryOutput += u.output_tokens ?? 0;
      }
      if (attempt.local_repair) {
        repairs++;
        retryInput += u.input_tokens ?? 0;
        retryOutput += u.output_tokens ?? 0;
      }
    }
    rows.push({
      scene_id: s.id,
      attempts: history.length,
      retries,
      repairs,
      input_tokens: sum.input_tokens ?? 0,
      cached_input_tokens: sum.cached_input_tokens ?? 0,
      output_tokens: sum.output_tokens ?? 0,
      cache_hit_rate: cacheHitRate(sum),
      turns: sum.turns ?? 0,
      preview_calls: countStreamPreviews(s.directory, s.id),
      cost_usd: sum.cost_usd ?? 0,
    });
  }
  rows.sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
  return {
    render_cache_hit_rate: cacheHitRate(renderTotal),
    orchestrator_cache_hit_rate: cacheHitRate(orchestratorTotal),
    retry_and_repair_input_tokens: retryInput,
    retry_and_repair_output_tokens: retryOutput,
    top_scenes: rows.slice(0, 5),
  };
}

export function writeBreakdown(out: Out, breakdown: UsageBreakdown): void {
  const fmtPct = (v: number | null) => (v === null ? '无数据' : `${v.toFixed(1)}%`);
  out.write('\n降本诊断拆账：\n');
  out.write(
    `  缓存命中率：渲染 ${fmtPct(breakdown.render_cache_hit_rate)}，编排 ${fmtPct(breakdown.orchestrator_cache_hit_rate)}\n`,
  );
  out.write(
    `  重试与返修消耗：输入 ${breakdown.retry_and_repair_input_tokens}，输出 ${breakdown.retry_and_repair_output_tokens}\n`,
  );
  if (breakdown.top_scenes.length > 0) {
    out.write('  高耗镜头 Top 5：\n');
    for (const row of breakdown.top_scenes) {
      out.write(
        `    ${row.scene_id}：输入 ${row.input_tokens}（缓存 ${fmtPct(row.cache_hit_rate)}），输出 ${row.output_tokens}，` +
          `${row.attempts} 次尝试（重试 ${row.retries} / 返修 ${row.repairs}），${row.turns} 轮，预览 ${row.preview_calls} 次\n`,
      );
    }
  }
}
