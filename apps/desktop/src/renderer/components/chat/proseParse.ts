import { countChoicesBlocks, parseQuestionsBlock, stripValidQuestions } from './questionParse';

const choicesBlock = /```choices\s*\n([\s\S]*?)```/g;

/**
 * 推荐的整片风格：film-styles 代码块，每行「来源/目录名 理由」是全片的默认风格；
 * 「来源/目录名 [用在哪一段] 理由」是只给那一段换的风格（studio/sessions.ts 的 studioInteraction）。
 */
const filmStylesBlock = /```film-styles\s*\n([\s\S]*?)```/;

/** 去掉回复里的 choices / questions / film-styles 代码块：它们另外显示成交互卡片或按钮。 */
export function stripChoices(text: string): string {
  return stripValidQuestions(text).replace(choicesBlock, '').replace(filmStylesBlock, '').trimEnd();
}

export interface StylePick {
  key: string;
  reason: string;
  /** 只用在哪一段（方括号里写的，例如「回忆段，镜头 04–06」）；空是全片的默认风格。 */
  scope: string;
  /** 来自 film-styles 代码块。没有代码块、按回复里写到的风格标识认出来的，不知道是给全片还是给一段。 */
  explicit: boolean;
}

/**
 * 回复里推荐的整片风格。优先读 film-styles 代码块；没有代码块时，回复里写到的
 * 已知风格标识（「来源/目录名」，制作提示词要求推荐时写明）也算，按出现顺序。
 */
export function parseStylePicks(text: string, known: Set<string>): StylePick[] {
  const block = filmStylesBlock.exec(text);
  const picks: StylePick[] = [];
  const seen = new Set<string>();
  if (block) {
    for (const raw of block[1].split('\n')) {
      const line = raw.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim();
      const match = /^`?([\w.-]+\/[\w.-]+)`?\s*(?:[[【]([^\]】]*)[\]】])?\s*[:：—–-]*\s*(.*)$/.exec(line);
      if (!match) continue;
      const scope = (match[2] ?? '').trim();
      // 同一种风格可以既推荐给全片、又推荐给某一段，按「风格 + 范围」去重。
      if (seen.has(match[1] + '\u0000' + scope)) continue;
      seen.add(match[1] + '\u0000' + scope);
      picks.push({ key: match[1], reason: match[3].trim(), scope, explicit: true });
    }
    return picks.slice(0, 6);
  }
  if (known.size === 0) return [];
  for (const match of text.matchAll(/[\w.-]+\/[\w.-]+/g)) {
    const key = match[0];
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    picks.push({ key, reason: '', scope: '', explicit: false });
  }
  return picks.slice(0, 6);
}

/**
 * 解析单块 choices 代码块里的选项：每行一个，去掉列表符号（放宽上限至 16 项）。
 * 若回复已含 ```questions 块或 2 个及以上 ```choices 块，由 parseQuestionsBlock 接管渲染多题卡片。
 */
export function parseChoices(text: string): string[] {
  if (parseQuestionsBlock(text) !== null || countChoicesBlocks(text) >= 2) return [];
  const match = /```choices\s*\n([\s\S]*?)```/.exec(text);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 16);
}

/** 用户消息里服务端附上的附件说明，拆出来另外显示。 */
export function splitAttachmentText(text: string): { body: string; extra: string } {
  const index = text.search(/\n\n(用户上传的文件|用户引用的内容|附带的画面上下文)/);
  if (index < 0) return { body: text, extra: '' };
  return { body: text.slice(0, index), extra: text.slice(index).trim() };
}

/** 回复里提到的媒体文件：试听、封面、预览视频。 */
export interface MediaRef {
  path: string;
  kind: 'audio' | 'image' | 'video';
}

const mediaPattern =
  /[^\s`'"“”‘’（）()<>|，。、；：！？]+?\.(mp3|wav|m4a|aac|flac|ogg|opus|png|jpe?g|webp|gif|mp4|mov|webm)(?![\w])/gi;

function mediaKind(path: string): MediaRef['kind'] {
  if (/\.(mp4|mov|webm)$/i.test(path)) return 'video';
  if (/\.(png|jpe?g|webp|gif)$/i.test(path)) return 'image';
  return 'audio';
}

/**
 * 找出回复里写到的、项目里确实存在的媒体文件，按出现顺序。编排工具常常只写文件名
 * （表格里一列 `try-A.wav`，目录在前文另说），所以也按文件名找：同名的有多个时，
 * 优先回复里提到过的那个目录下的。
 */
export function findMedia(text: string, files: string[]): MediaRef[] {
  const out: MediaRef[] = [];
  const seen = new Set<string>();
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const name = file.split('/').pop() ?? file;
    byName.set(name, [...(byName.get(name) ?? []), file]);
  }
  const fileSet = new Set(files);
  for (const match of text.matchAll(mediaPattern)) {
    const token = match[0].replace(/^\.\//, '').replace(/^\/+/, '');
    let path = '';
    if (fileSet.has(token)) path = token;
    else if (token.includes('/')) {
      path = files.find((file) => file.endsWith('/' + token) || token.endsWith('/' + file)) ?? '';
    }
    if (!path) {
      const candidates = byName.get(token.split('/').pop() ?? token) ?? [];
      path = candidates.find((file) => text.includes(file.slice(0, file.lastIndexOf('/') + 1))) ?? candidates[0] ?? '';
    }
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, kind: mediaKind(path) });
  }
  return out.slice(0, 12);
}

/**
 * 点风格卡片发出的那句话；收起已答的选项时按它认出选的是哪个。
 * 全片默认、只给一段、不知道是哪种（回复里没有 film-styles 代码块）各是一种说法，不能都说成「整片风格」。
 */
export function stylePickMessage(name: string, pick: StylePick): string {
  if (!pick.explicit) return `选「${name}」（${pick.key}）这个风格`;
  if (pick.scope) return `${pick.scope}用「${name}」风格（${pick.key}），其余镜头不变`;
  return `整片风格用「${name}」（${pick.key}）`;
}
