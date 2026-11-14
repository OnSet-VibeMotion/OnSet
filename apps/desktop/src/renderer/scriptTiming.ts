import type { ScriptBlock, ScriptNode } from './types';
import { align } from './voiceTiming';

type Times = NonNullable<ScriptNode['timings']>;

function spoken(node: ScriptNode): string {
  if (node.kind === 'phrase') return (node.children ?? []).map(spoken).join('');
  const text = node.kind === 'alt' ? node.spoken ?? '' : node.text ?? '';
  // 服务的表演标签不是要念出的文字。
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, '');
}

/** 未对齐时仅按朗读长度估算；不解码整段长音频，也不把估算写回字幕。 */
export function estimateScriptTiming(blocks: ScriptBlock[], seconds: number): ScriptBlock[] {
  if (!Number.isFinite(seconds) || seconds <= 0) return blocks;
  const text = blocks.filter((b) => b.kind === 'para').map((b) => (b.nodes ?? []).map(spoken).join('')).join('\n');
  const times: Times = align(text, { duration: seconds, envelope: new Float32Array() }).flatMap((token) => {
    const chars = [...token.text];
    return chars.map((_, i) => token.weight > 0 ? {
      start: token.start + (token.end - token.start) * i / chars.length,
      end: token.start + (token.end - token.start) * (i + 1) / chars.length,
    } : null);
  });
  let offset = 0;
  const visit = (node: ScriptNode): ScriptNode => {
    if (node.kind === 'phrase') return { ...node, children: (node.children ?? []).map(visit) };
    const read = spoken(node);
    const own = times.slice(offset, offset + [...read].length);
    offset += [...read].length;
    const display = node.text || node.spoken || '';
    if (display === read) return { ...node, timings: own };
    const valid = own.filter((t) => t !== null);
    const start = valid[0]?.start, end = valid.at(-1)?.end;
    const chars = [...display];
    return { ...node, timings: chars.map((_, i) => start !== undefined && end !== undefined ? {
      start: start + (end - start) * i / chars.length,
      end: start + (end - start) * (i + 1) / chars.length,
    } : null) };
  };
  return blocks.map((block) => {
    if (block.kind !== 'para') return block;
    const nodes = (block.nodes ?? []).map(visit);
    offset++; // 段落间换行。
    return { ...block, nodes };
  });
}
