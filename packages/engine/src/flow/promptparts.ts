/**
 * 第三方站进制作提示词的两种方式（运行期组合时用，compose.ts）：插进某个阶段末尾的补充（inserts）、
 * 接在提示词最后的各站说明。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LoadedStation } from './installed';
import { pageTab, toolName } from './pages';

/** 插进某个阶段末尾的一节。 */
export function insertBlock(s: LoadedStation, body: string): string {
  return `### 第三方站「${s.manifest.name}」的补充\n\n以下由用户添加的第三方插件「${s.manifest.name}」（${s.manifest.id} ${s.manifest.version}）提供；与本阶段上面的约定冲突时以上面为准。\n\n${body}\n\n`;
}

/** 项目的提示词里没有那个阶段时接在最后的一节。 */
export function orphanBlock(s: LoadedStation, title: string | undefined, body: string): string {
  return `### 第三方站「${s.manifest.name}」对「${title}」阶段的补充\n\n（这个项目的说明里没有这一阶段，按相应的步骤理解。）\n\n${body}`;
}

/**
 * 第三方站的提示词，接在项目制作提示词后面。每一站一节，开头说明来源，并声明冲突时以上面为准。
 */
export function extraPrompt(stations: readonly LoadedStation[]): string {
  const parts: string[] = [];
  for (const s of stations) {
    if (s.manifest.prompt === '') continue;
    const body = fs.readFileSync(path.join(s.dir, s.manifest.prompt), 'utf8').trim();
    const tools = s.manifest.ops.filter((o) => o.trigger === 'agent').map((o) => '`' + toolName(s.manifest.id, o.name) + '`');
    const userOps = s.manifest.ops.filter((o) => o.trigger === 'user').map((o) => o.summary);
    const lines = [
      `## 第三方站：${s.manifest.name}`,
      '',
      `以下一节由用户添加的第三方插件「${s.manifest.name}」（${s.manifest.id} ${s.manifest.version}）提供，不是本说明的一部分；与上面的约定冲突时以上面为准。`,
    ];
    if (tools.length > 0) lines.push(`它给你的工具：${tools.join('、')}（用 tool_help 查用法）。`);
    if (userOps.length > 0) lines.push(`这些动作只能由用户在客户端里点按钮执行，你不能代做，做到那一步时请用户去点：${userOps.join('；')}。`);
    const tsNames = { none: '不带时间戳，voice.srt 照常由强制对齐生成', sentence: '带句级时间戳', word: '带字级时间戳' } as const;
    if (s.manifest.provides.tts) {
      const p = s.manifest.provides.tts;
      lines.push(`它提供配音「${p.name}」（${tsNames[p.timestamps]}）：TTS_PROVIDER 是 \`x:${s.manifest.id}\` 时，用 \`${toolName(s.manifest.id, p.op)}\` 合成配音，产物要求与其他配音路径相同。`);
    }
    if (s.manifest.provides.align) {
      const p = s.manifest.provides.align;
      lines.push(`它提供字幕对齐「${p.name}」：ALIGN_PROVIDER 是 \`x:${s.manifest.id}\` 时，用 \`${toolName(s.manifest.id, p.op)}\` 做强制对齐，结果照样交给 \`align_build()\`。`);
    }
    for (const rs of s.manifest.renderer_skills) {
      lines.push(
        rs.scenes === 'all'
          ? `它给渲染器带了技能「${rs.name}」（${rs.summary}），每个镜头都会用上，你不用做什么。`
          : `它给渲染器带了技能「${rs.name}」（${rs.summary}）：要哪个镜头用，就在那个镜头 scene.json 的 plugin_skills 里加 "${s.manifest.id}/${rs.name}"。`,
      );
    }
    for (const page of s.manifest.pages) lines.push(`它在客户端里有自己的页面「${page.label}」，要用户看时运行 \`studio_show({"page": "${pageTab(s.manifest.id, page.id)}"})\`。`);
    lines.push('', body);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}
