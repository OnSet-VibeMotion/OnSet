/**
 * 插件进制作提示词的几种方式：内置插件段落的标记（生成时包住、运行时去掉或整段删掉）、
 * 插进某个阶段末尾的补充（inserts）、接在提示词最后的各站说明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { allStageTitles } from './registered';
import type { LoadedStation } from './lock';
import { pageTab, toolName } from './pages';

const markerOpen = (id: string) => `<!-- am-plugin:${id} -->\n`;
const markerClose = (id: string) => `<!-- /am-plugin:${id} -->\n`;

/** 生成制作提示词时，用标记包住内置插件认领的一段。 */
export function markPluginSection(pluginID: string, text: string): string {
  return markerOpen(pluginID) + (text.endsWith('\n') ? text : text + '\n') + markerClose(pluginID);
}

/**
 * 老路径（兼容没有流程记录的项目）：运行时处理制作提示词里的插件标记：关掉的内置插件那几段整段去掉，其余只去掉标记行。
 * 编排工具看到的提示词里没有标记；老项目的提示词没有标记，原样不动。
 */
export function applyPluginMarkers(text: string, disabled: ReadonlySet<string>): string {
  let out = text;
  for (const id of disabled) {
    const open = markerOpen(id);
    const close = markerClose(id);
    for (;;) {
      const start = out.indexOf(open);
      if (start < 0) break;
      const end = out.indexOf(close, start);
      if (end < 0) break;
      out = out.slice(0, start) + out.slice(end + close.length);
    }
  }
  return out.replace(/^<!-- \/?am-plugin:[a-z][a-z0-9-]* -->\n/gm, '');
}

/** 插进某个阶段末尾的一节（老路径与运行期组合共用）。 */
export function insertBlock(s: LoadedStation, body: string): string {
  return `### 第三方站「${s.manifest.name}」的补充\n\n以下由用户添加的第三方插件「${s.manifest.name}」（${s.manifest.id} ${s.manifest.version}）提供；与本阶段上面的约定冲突时以上面为准。\n\n${body}\n\n`;
}

/** 项目的提示词里没有那个阶段时接在最后的一节。 */
export function orphanBlock(s: LoadedStation, title: string | undefined, body: string): string {
  return `### 第三方站「${s.manifest.name}」对「${title}」阶段的补充\n\n（这个项目的说明里没有这一阶段，按相应的步骤理解。）\n\n${body}`;
}

/**
 * 老路径（兼容没有流程记录的项目，以及用户改过的制作说明）：把第三方站的阶段说明插进项目的制作提示词：按阶段标题找到「## 第N阶段：<标题>」，插在这一阶段末尾
 * （下一个「## 」标题之前）。找不到这个阶段（老项目、别的流程）就接在最后，注明原本要插在哪。
 */
export function insertStageSections(prompt: string, stations: readonly LoadedStation[]): string {
  let out = prompt;
  const orphans: string[] = [];
  const stageTitles = allStageTitles();
  for (const s of stations) {
    for (const ins of s.manifest.inserts) {
      const body = fs.readFileSync(path.join(s.dir, ins.file), 'utf8').trim();
      const title = stageTitles[ins.stage];
      const block = insertBlock(s, body);
      const lines = out.split('\n');
      const at = lines.findIndex((l) => l.startsWith('## ') && l.endsWith('：' + title));
      if (at < 0) {
        orphans.push(orphanBlock(s, title, body));
        continue;
      }
      let next = lines.findIndex((l, i) => i > at && l.startsWith('## '));
      if (next < 0) next = lines.length;
      // 插在下一节标题之前，前面留一个空行。
      const before = lines.slice(0, next);
      while (before.length > 0 && before[before.length - 1] === '') before.pop();
      out = [...before, '', ...block.trimEnd().split('\n'), '', ...lines.slice(next)].join('\n');
    }
  }
  if (orphans.length > 0) out = out.replace(/\n*$/, '\n\n') + orphans.join('\n\n') + '\n';
  return out;
}

/**
 * 第三方站的提示词，接在项目制作提示词后面。每一站一节，开头说明来源，并声明冲突时以上面为准。
 */
export function extraPrompt(stations: readonly LoadedStation[], existing = ''): string {
  const parts: string[] = [];
  for (const s of stations) {
    if (s.manifest.prompt === '') continue;
    const body = fs.readFileSync(path.join(s.dir, s.manifest.prompt), 'utf8').trim();
    if (s.builtin) {
      // 内置插件的说明原样接上（它本来就是制作说明的一部分，自带标题）。老项目的提示词里已经有这一节时不重复。
      const heading = body.split('\n')[0];
      if (heading !== '' && existing.includes(heading)) continue;
      parts.push(body);
      continue;
    }
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
