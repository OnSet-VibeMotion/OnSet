import type { PrereqStatus, SetupStatus } from '../../types';

/** 路径里的家目录换成 ~（只为显示短一些）。 */
export function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, '~');
}

// ---- 把技术上的几项合成用户听得懂的「组」 ----

export interface Crew {
  key: string;
  /** 图标名（icons 的键）；不写用 key。 */
  icon?: string;
  title: string;
  desc: string;
  items: PrereqStatus[];
}

export type State = 'ready' | 'missing' | 'waiting' | 'working' | 'failed' | 'paused';

const voiceNames: Record<string, string> = {
  minimax: 'MiniMax',
  bailian: '阿里云百炼',
  edge: '微软 Edge 朗读',
  elevenlabs: 'ElevenLabs',
  tencent: '腾讯云',
  mlx: '本机合成',
  breeze: 'Breeze TTS 2（本机）',
};

/** 要一起就位的几个组；没有对应项（例如这台机器不配音）就不显示。 */
export function coreCrews(items: PrereqStatus[]): Crew[] {
  const pick = (test: (item: PrereqStatus) => boolean) => items.filter(test);
  const voice = items.find((item) => item.group === 'tts');
  const voiceName = voice ? (voiceNames[voice.id.slice('tts:'.length)] ?? '') : '';
  const crews: Crew[] = [
    {
      key: 'render',
      title: '画面',
      desc: '把每个镜头画出来、渲染成视频',
      items: pick((i) => ['skills', 'cli', 'browser'].includes(i.group)),
    },
    { key: 'media', title: '剪辑', desc: '检查、拼接画面与声音', items: pick((i) => i.group === 'ffmpeg') },
    {
      key: 'voice',
      title: '配音',
      desc: voiceName ? `把文稿读成配音 · ${voiceName}` : '把文稿读成配音',
      items: pick((i) => i.group === 'tts'),
    },
    { key: 'align', title: '字幕', desc: '让字幕和配音逐字对上', items: pick((i) => i.group === 'align') },
  ];
  return crews.filter((c) => c.items.length > 0);
}

/** 以后可能用到、要单独点的：体积大，用到才装。 */
export function laterCrews(items: PrereqStatus[]): Crew[] {
  const out: Crew[] = [];
  // 内置插件登记的（例如卡点的节拍分析环境、各整片风格来源）：同一 group 里名字相同的合成一张卡片，名字、说明与图标由插件登记。
  // 不只按 group 合：两个风格来源同在 styles 组，合成一张的话一个装了、一个没装时卡片上看不出缺的是哪个。
  const cardKey = (i: PrereqStatus) => i.group + ':' + i.later!.title;
  for (const key of [...new Set(items.filter((i) => i.later).map(cardKey))]) {
    const own = items.filter((i) => i.later && cardKey(i) === key);
    const later = own[0].later!;
    out.push({ key, icon: later.icon ?? own[0].group, title: later.title, desc: later.desc, items: own });
  }
  const design = items.filter((i) => i.group === 'voice');
  if (design.length) {
    out.push({
      key: 'design',
      title: '音色设计',
      desc:
        window.onset?.platform === 'win32'
          ? '在音色页按描述做一个新声音 · Windows CUDA Q8_0 · 约 6.2 GB'
          : '在音色页按描述做一个新声音 · 约 4.6 GB',
      items: design,
    });
  }
  return out;
}

/** 几项合成一个组之后的状态与进度（0–100）。 */
export function crewState(c: Crew, task: SetupStatus['task']): { state: State; percent: number } {
  const running = task?.running ?? false;
  const progress = c.items.map((item) => task?.items[item.id]);
  const done = c.items.map((item, i) => item.ready || progress[i]?.state === 'done');
  const finished = done.filter(Boolean).length;
  // 用户点了暂停：后端把那一项记成失败、原因是「已取消」，在界面上不算出错。
  const stopped = progress.find((p) => p?.state === 'failed');
  if (stopped) {
    return { state: stopped.error === '已取消' ? 'paused' : 'failed', percent: (100 * finished) / c.items.length };
  }
  if (finished === c.items.length) return { state: 'ready', percent: 100 };
  const active = progress.findIndex((p) => p?.state === 'running');
  if (active >= 0) {
    // 每一项占同样的份额：已完成的算满，正在进行的按它自己的百分比。量不出百分比（npm、pip、浏览器下载）的
    // 不算——以前按一半算，Windows 上下浏览器时就一直停在 50%，看着像卡死了；那种步骤改为显示下了多少字节。
    const current = (progress[active]?.percent ?? 0) / 100;
    return { state: 'working', percent: Math.round((100 * (finished + current)) / c.items.length) };
  }
  if (running && progress.some((p) => p?.state === 'pending')) {
    return { state: 'waiting', percent: (100 * finished) / c.items.length };
  }
  return { state: 'missing', percent: 0 };
}

/** 每一项用大白话说是在干什么（「正在赶来」那一条的第二行）。 */
const purposes: Record<string, string> = {
  skills: '下载画面组的制作手册',
  cli: '安装渲染程序',
  browser: '下载渲染用的浏览器，约 390 MB',
  ffmpeg: '下载剪辑工具',
  tts: '安装配音工具',
  voice: '安装音色设计工具',
  align: '安装字幕对齐工具',
  styles: '下载风格库',
  beat: '准备节拍分析环境',
  song: '准备本机歌曲生成环境（ACE-Step 1.5）',
};

export function purposeOf(item: PrereqStatus): string {
  return purposes[item.id] ?? purposes[item.group] ?? item.name;
}

/** 字节数写成 MB / GB。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1_048_576) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

/** 秒数写成「3 分 12 秒」。 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 一个组正在准备的那一项，以及它是第几步。 */
export function runningStep(
  c: Crew,
  task: SetupStatus['task'],
): { item: PrereqStatus; progress: NonNullable<SetupStatus['task']>['items'][string]; index: number } | null {
  const index = c.items.findIndex((item) => task?.items[item.id]?.state === 'running');
  if (index < 0 || !task) return null;
  return { item: c.items[index], progress: task.items[c.items[index].id], index };
}

/**
 * 人在路上走到哪：已完成的项加上正在准备的那一项走了多少。量得出百分比的按百分比；只知道字节数的，
 * 下得越多越往前挪（最多走到这一段的 85%），一点都量不出的按用了多久慢慢挪——画面上看得出在走，
 * 但不拿它冒充百分比，卡片与顶上的数字仍只按量得出的算。
 */
export function walkPercent(c: Crew, task: SetupStatus['task'], percent: number): number {
  const step = runningStep(c, task);
  if (!step || step.progress.percent !== undefined) return percent;
  const share = 100 / c.items.length;
  const p = step.progress;
  const amount =
    p.bytes !== undefined ? p.bytes / (80 * 1_048_576) : p.started_at ? (Date.now() - p.started_at) / 180_000 : 0;
  return percent + share * 0.85 * (1 - Math.exp(-amount));
}

/** 悬停时给懂行的人看：具体是哪些工具、版本、装在哪。 */
export function technical(c: Crew): string {
  return c.items
    .map((i) => `${i.name}${i.version ? ' ' + i.version : ''}${i.ready ? '\n  ' + i.location : ''}`)
    .join('\n');
}

/** 这一组有没有参与这次安装（没参与的在安装进行中变暗，让正在装的那一组跳出来）。 */
export function inTask(c: Crew, task: SetupStatus['task']): boolean {
  return c.items.some((item) => task?.items[item.id] !== undefined);
}

export const stateLabel: Record<State, string> = {
  ready: '已就位',
  missing: '待准备',
  waiting: '排队中',
  working: '在路上',
  failed: '没成功',
  paused: '已暂停',
};
