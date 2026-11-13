import type { Attachment } from '../../types';

/**
 * 输入框的 @ 与 / 补全。
 *
 *   @  在任意位置：项目里的镜头、文件（口播稿排最前）。选中后文字里留 @编号 / @路径，
 *      发送时每个能认出来的 @ 都变成一条引用（Attachment.ref），编排工具拿到明确的出处。
 *   /  只在开头：Studio 命令。有的在网页里直接执行（新对话、渲染、切页……），
 *      有的把一句话交给编排工具（确认口播稿、重做镜头……）。认不出的 /xxx 照常发出。
 */

export interface Suggestion {
  /** 替换进输入框的文字（不含前缀符号）。 */
  value: string;
  label: string;
  hint?: string;
  kind: 'scene' | 'file' | 'script' | 'command' | 'page';
}

export interface CompletionContext {
  scenes: string[];
  files: string[];
}

/** 命令要的参数：镜头编号或页面。 */
export type CommandArg = 'scene' | 'page';

export interface SlashCommand {
  name: string;
  label: string;
  arg?: CommandArg;
  /** 只在这一轮进行中可用（停止）。 */
  whileRunning?: boolean;
}

export const slashCommands: SlashCommand[] = [
  { name: 'new', label: '开一个新对话' },
  { name: 'stop', label: '停止这一轮', whileRunning: true },
  { name: 'start', label: '开始整片制作' },
  { name: 'script', label: '打开口播稿' },
  { name: 'show', label: '切到某一页', arg: 'page' },
  { name: 'confirm-script', label: '告诉编排工具：口播稿没问题，开始配音' },
  { name: 'redo', label: '让编排工具重做一个镜头', arg: 'scene' },
  { name: 'render', label: '渲染一个镜头', arg: 'scene' },
  { name: 'render-all', label: '渲染全部镜头' },
  { name: 'validate', label: '校验一个镜头', arg: 'scene' },
  { name: 'concat', label: '拼接无声母版' },
  { name: 'review', label: '整片复查' },
  { name: 'remember', label: '记下一条偏好（编排工具用 am memory remember 记住）' },
];

export const pageNames: [string, string][] = [
  ['script', '口播稿'],
  ['scene', '镜头'],
  ['compose', '合成'],
  ['final', '成片'],
  ['style', '风格'],
  ['review', '复查'],
  ['publish', '发布'],
  ['memory', '记忆'],
  ['file', '文件'],
];

const scriptPath = 'production/script-final.md';
const LIMIT = 8;

/** 正在补全的片段：光标前的 @xxx 或开头的 /xxx [参数]。 */
export interface Token {
  trigger: '@' | '/';
  /** 片段在输入框里的起止（含前缀符号）。 */
  start: number;
  end: number;
  query: string;
  /** / 命令已经写完名字、正在写参数时，是哪条命令。 */
  command?: SlashCommand;
}

export function findToken(text: string, caret: number): Token | null {
  const before = text.slice(0, caret);
  const slash = /^\/([\w-]*)(?: +(\S*))?$/.exec(before);
  if (slash) {
    const [, name, arg] = slash;
    if (arg === undefined) return { trigger: '/', start: 0, end: caret, query: name };
    const command = slashCommands.find((c) => c.name === name);
    if (!command?.arg) return null;
    return { trigger: '/', start: caret - arg.length, end: caret, query: arg, command };
  }
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { trigger: '@', start: caret - at[2].length - 1, end: caret, query: at[2] };
  return null;
}

function matches(query: string, ...fields: string[]): boolean {
  const q = query.toLowerCase();
  return !q || fields.some((f) => f.toLowerCase().includes(q));
}

function sceneSuggestions(query: string, ctx: CompletionContext): Suggestion[] {
  return ctx.scenes.filter((id) => matches(query, id)).map((id) => ({ value: id, label: id, hint: '镜头', kind: 'scene' as const }));
}

export function suggest(token: Token, ctx: CompletionContext, running: boolean): Suggestion[] {
  if (token.trigger === '/') {
    if (token.command?.arg === 'scene') return sceneSuggestions(token.query, ctx).slice(0, LIMIT);
    if (token.command?.arg === 'page') {
      return pageNames
        .filter(([id, label]) => matches(token.query, id, label))
        .map(([id, label]) => ({ value: id, label, hint: id, kind: 'page' as const }));
    }
    return slashCommands
      .filter((c) => (!c.whileRunning || running) && matches(token.query, c.name, c.label))
      .map((c) => ({ value: c.name, label: '/' + c.name + (c.arg === 'scene' ? ' <镜头>' : c.arg === 'page' ? ' <页面>' : ''), hint: c.label, kind: 'command' as const }));
  }
  const out: Suggestion[] = [];
  if (ctx.files.includes(scriptPath) && matches(token.query, '口播稿', 'script', scriptPath)) {
    out.push({ value: scriptPath, label: '口播稿', hint: scriptPath, kind: 'script' });
  }
  out.push(...sceneSuggestions(token.query, ctx));
  for (const path of ctx.files) {
    if (path === scriptPath || !matches(token.query, path)) continue;
    out.push({ value: path, label: path.split('/').pop() ?? path, hint: path, kind: 'file' });
  }
  // 名字以查询开头的排前面。
  const q = token.query.toLowerCase();
  out.sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)));
  return out.slice(0, LIMIT);
}

/** 把选中的补全写回输入框，返回新文字与光标位置。 */
export function applySuggestion(text: string, token: Token, item: Suggestion): { text: string; caret: number } {
  const prefix = token.trigger === '@' ? '@' : token.command ? '' : '/';
  const start = token.trigger === '@' ? token.start : token.command ? token.start : 0;
  const insert = prefix + item.value + ' ';
  const next = text.slice(0, start) + insert + text.slice(token.end).replace(/^ /, '');
  return { text: next, caret: start + insert.length };
}

/** 整条输入是不是一条认得的 / 命令（参数齐全）。 */
export function parseCommand(text: string): { command: SlashCommand; arg: string } | null {
  const match = /^\/([\w-]+)(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!match) return null;
  const command = slashCommands.find((c) => c.name === match[1]);
  if (!command) return null;
  const arg = match[2] ?? '';
  if (command.arg && !arg) return null;
  if (!command.arg && arg) return null;
  return { command, arg };
}

/** 发送前把文字里认得的 @镜头 / @文件 变成引用；已经有的不重复加。 */
export function mentionAttachments(text: string, ctx: CompletionContext, existing: Attachment[]): Attachment[] {
  const out: Attachment[] = [];
  const seen = new Set(existing.filter((a) => a.ref).map((a) => a.scene_id ?? a.source ?? ''));
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const value = match[1].replace(/[，。,.;；:：!！?？)）]+$/, '');
    if (seen.has(value)) continue;
    if (ctx.scenes.includes(value)) out.push({ ref: true, scene_id: value });
    else if (ctx.files.includes(value)) out.push({ ref: true, source: value });
    else continue;
    seen.add(value);
  }
  return out;
}
