/**
 * 精简 hyperframes 工具交给 agent 的输出。
 *
 * HyperFrames CLI 的输出是写给终端的：render 一次两万多字，几乎全是进度条、`[INFO]` 跟踪日志、
 * 每个工作进程一遍的浏览器启动日志；check 先逐条打印「samples 3/9」「craft 17/52」，再给一份缩进的 JSON，
 * 里面每条问题带 bbox、dataAttributes、采样时刻数组。agent 每调一次，这些字就留在它的上下文里，
 * 之后每一步都要重读一遍：2026-11 统计 101 个镜头，这个工具的输出占渲染器上下文增长的四分之一，
 * 每个镜头约 2.7 万 token。
 *
 * 只在工具服务里用（toolsmcp 的 Jobs，内置制作人共用）；开发用命令行照旧原样输出。
 * 只删确定没用的：进度、调试跟踪、宣传语与 Electron 的安全提示（客户端借用自带的 Electron 当浏览器才有，
 * 与镜头无关）；错误、警告、结论与 JSON 里的问题一条不少，完整输出写进临时文件、末尾给路径。
 */

/** 整行删掉的：进度与调试跟踪。 */
const droppedLine: readonly RegExp[] = [
  /^\s*\[INFO\]/,
  /^\s*@hf-progress\b/,
  /[█░]/,
  /^\s*\[initSession:[^\]]*\]/,
  /^\s*\[BrowserManager\] Browser launched\b/,
  /^\s*\[hyperframes\] browserGpuMode probe\b/,
  /^\s*\[hyperframes\] [^:]+: [\w -]+ \d+\/\d+\s*$/,
  /^\s*\[HyperFrames\] render runtime fps\b/,
  /^\s*Checking browser\.\.\.\s*$/,
  /^\s*Browser: \S+\s*$/,
  /Keep editing by chatting with Framey/,
];

/** Electron 自己的安全提示：从这一行起，到「once the app is packaged.」为止。 */
const electronWarningStart = /Electron Security Warning/;
const electronWarningEnd = /once the app is packaged\.\s*$/;

/** JSON 里删掉的键：画面坐标、元素属性、本机地址与采样时刻，agent 改代码用不上；_meta 是版本与更新提示。 */
const droppedKeys = new Set(['bbox', 'dataAttributes', 'url', '_meta']);

export interface Compacted {
  text: string;
  /** 删掉了东西（行或 JSON 里的字段）。 */
  trimmed: boolean;
}

/** 精简一次 hyperframes 调用的完整输出。 */
export function compactHyperFrames(output: string): Compacted {
  const lines = output.split('\n');
  const jsonStart = lines.findIndex((line) => line === '{' || line === '[');
  const head = jsonStart >= 0 ? lines.slice(0, jsonStart) : lines;
  let tail = jsonStart >= 0 ? lines.slice(jsonStart).join('\n') : '';
  let trimmed = false;

  const kept: string[] = [];
  let inWarning = false;
  for (const line of head) {
    if (inWarning) {
      if (electronWarningEnd.test(line)) inWarning = false;
      trimmed = true;
      continue;
    }
    if (electronWarningStart.test(line)) {
      inWarning = !electronWarningEnd.test(line);
      trimmed = true;
      continue;
    }
    if (droppedLine.some((re) => re.test(line))) {
      trimmed = true;
      continue;
    }
    kept.push(line);
  }

  if (tail !== '') {
    const json = compactJSON(tail);
    if (json !== null) {
      trimmed = trimmed || json.trimmed;
      tail = json.text;
    }
  }

  const body = collapseRepeats(kept);
  if (body.length !== kept.length) trimmed = true;
  const text = [squeezeBlank(body).join('\n').trim(), tail.trim()].filter((part) => part !== '').join('\n');
  return { text, trimmed };
}

/** 连续相同的行合成一行，后面注明次数（几个工作进程各打一遍的那种）。 */
function collapseRepeats(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(j - i > 1 && lines[i].trim() !== '' ? `${lines[i]}（×${j - i}）` : lines[i]);
    i = j;
  }
  return out;
}

/** 连续的空行只留一行。 */
function squeezeBlank(lines: readonly string[]): string[] {
  return lines.filter((line, i) => line.trim() !== '' || (i > 0 && lines[i - 1].trim() !== ''));
}

/**
 * 解析 `--json` 的结果并重写成紧凑的一行：删掉 droppedKeys、纯数字的采样数组、Electron 的安全提示（并把计数改对），
 * 同一目录下的一串截图只写一次目录。解析不了返回 null，原样交出。
 */
function compactJSON(text: string): Compacted | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  let trimmed = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      if (droppedKeys.has(key)) {
        trimmed = true;
        continue;
      }
      if (key === 'samples' && Array.isArray(child) && child.every((x) => typeof x === 'number')) {
        trimmed = true;
        continue;
      }
      out[key] = walk(child);
    }
    if (Array.isArray(out.findings)) {
      const findings = out.findings as Record<string, unknown>[];
      const kept = findings.filter((f) => !(typeof f?.message === 'string' && electronWarningStart.test(f.message)));
      if (kept.length !== findings.length) {
        trimmed = true;
        for (const f of findings) {
          if (kept.includes(f)) continue;
          const key = f.severity === 'error' ? 'errorCount' : f.severity === 'info' ? 'infoCount' : 'warningCount';
          if (typeof out[key] === 'number') out[key] = Math.max((out[key] as number) - 1, 0);
        }
        out.findings = kept;
      }
    }
    if (Array.isArray(out.frames)) {
      const frames = out.frames as Record<string, unknown>[];
      const dirs = new Set(frames.map((f) => (typeof f?.path === 'string' ? dirname(f.path) : null)));
      const [dir] = [...dirs];
      if (frames.length > 1 && dirs.size === 1 && typeof dir === 'string' && dir !== '') {
        trimmed = true;
        out.frames_dir = dir;
        out.frames = frames.map((f) => ({ ...f, path: (f.path as string).slice(dir.length + 1) }));
      }
    }
    return out;
  };
  const compact = walk(value);
  return { text: JSON.stringify(compact), trimmed };
}

function dirname(file: string): string {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return i > 0 ? file.slice(0, i) : '';
}

/** 还在跑时给 agent 的一句进度（不交出半截日志）：取最后一条进度。 */
export function hyperFramesProgress(output: string): string {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const pct = /^@hf-progress (\{.*\})\s*$/.exec(line);
    if (pct) {
      try {
        const p = JSON.parse(pct[1]) as { code?: string; pct?: number };
        if (typeof p.pct === 'number') return `进度 ${p.pct}%${p.code ? `（${p.code}）` : ''}`;
      } catch {
        /* 下一行 */
      }
    }
    const step = /^\s*\[hyperframes\] ([^:]+: [\w -]+ \d+\/\d+)\s*$/.exec(line);
    if (step) return `进度：${step[1]}`;
  }
  return '';
}
