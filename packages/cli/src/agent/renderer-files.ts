import { mkdir, writeFile } from 'node:fs/promises';
import { createEditToolDefinition, createWriteToolDefinition, defineTool } from '@earendil-works/pi-coding-agent';

const maxTextLength = 8192;
const sourceFile = /\.(?:html?|css|[cm]?js|jsx|tsx?|svg)$/i;

export const rendererFileWorkflow =
  `先用 write 建立可运行的骨架，给各个区域留短而唯一的注释锚点。再用 edit 逐块补入内容、样式和动效。返修时只提交要改的片段。write 的正文和 edit 的匹配与替换文本各按单次调用合计，上限 ${maxTextLength}。有多个独立块时拆成多次调用。`;

function checkLength(tool: string, length: number): void {
  if (length <= maxTextLength) return;
  throw new Error(`${tool} 的单次文件文本上限为 ${maxTextLength}。先写小骨架，再用短锚点分块 edit。已有文件直接做局部 edit。`);
}

/** Reuse Pi's path resolution, parameter normalization and per-file mutation queue. */
export function rendererFileTools(workdir: string) {
  const write = createWriteToolDefinition(workdir, {
    operations: {
      mkdir: async dir => { await mkdir(dir, { recursive: true }); },
      writeFile: async (file, content) => {
        if (!sourceFile.test(file)) {
          await writeFile(file, content, 'utf8');
          return;
        }
        try {
          // Exclusive creation checks inside the mutation queue, including parallel write calls.
          await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          throw new Error('合成源码已存在，改用 edit 并用短而唯一的锚点定位要修改的片段。');
        }
      },
    },
  });
  const edit = createEditToolDefinition(workdir);
  return [
    defineTool({
      ...write,
      description: `创建文件，单次正文最多 ${maxTextLength} 字符。先写短骨架。已有 HTML、CSS、JS、TS 或 SVG 源码改用 edit。`,
      promptSnippet: '为新合成写入短骨架',
      promptGuidelines: [],
      execute: (...args: Parameters<typeof write.execute>) => {
        checkLength('write', args[1].content.length);
        return write.execute(...args);
      },
    }),
    defineTool({
      ...edit,
      description: `用短且唯一的原文锚点局部修改已有文件。每次匹配与替换文本合计最多 ${maxTextLength} 字符。`,
      execute: (...args: Parameters<typeof edit.execute>) => {
        const length = args[1].edits.reduce((total, part) => total + part.oldText.length + part.newText.length, 0);
        checkLength('edit', length);
        return edit.execute(...args);
      },
    }),
  ];
}
