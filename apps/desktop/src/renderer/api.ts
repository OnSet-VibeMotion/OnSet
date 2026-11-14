// Studio 接口的薄封装。错误统一抛 ApiError，message 用后端给的中文说明。

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    // 非 JSON 响应（例如 404 页面）按空对象处理，下面按状态码报错。
  }
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, String(body.code ?? ''), body);
  }
  return body as T;
}

export function post<T>(path: string, payload: unknown = {}): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 项目内文件的原始地址（视频、图片、音频）。v 用来在文件变化后绕过缓存。 */
export function rawURL(path: string, version?: number): string {
  const query = new URLSearchParams({ path });
  if (version) query.set('v', String(version));
  return `/api/raw?${query}`;
}

export function errorText(err: unknown): string {
  // fetch 连不上服务时浏览器只给一句英文（Chrome「Failed to fetch」、Firefox「NetworkError…」、
  // Safari「Load failed」），用户看不出是什么；多半是后台服务停了或正在重启。
  if (err instanceof TypeError && /failed to fetch|networkerror|load failed|network request failed/i.test(err.message)) {
    return '连不上客户端的后台服务：可能正在重启，稍等一下再试，或者重启客户端';
  }
  return forUser(err instanceof Error ? err.message : String(err));
}

/** 工具调用写法：beat_cues()、film_style_add({"style": "x"})。 */
const toolCall = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*\((?:\{[^)]*\})?\)/;

/**
 * 引擎报错与 onset 输出是写给编排工具的，里面常带「请重新运行 beat_cues()」这类下一步。
 * 用户不会去调工具（要改什么是跟编排工具说），显示给用户之前把这些话去掉，只留出了什么问题：
 * 带工具调用的括注整段去掉；一句话里从带工具调用的那一小句起，到句末都去掉。
 * 原文仍原样交给编排工具（对话里、工具输出里），这里只管界面上的显示。
 */
export function forUser(text: string): string {
  if (!toolCall.test(text)) return text;
  return text
    .split('\n')
    .map((line) => {
      // 全角括注里可以有半角括号（工具调用本身），按全角括号配对。
      let out = line.replace(/（[^（）]*）/g, (m) => (toolCall.test(m) ? '' : m));
      // 按句号断句；每句里找第一处带工具调用的小句（逗号、分号、冒号、破折号分隔），从那里截掉。
      out = out
        .split(/(?<=[。！？])/)
        .map((sentence) => {
          const hit = sentence.search(toolCall);
          if (hit < 0) return sentence;
          const head = sentence.slice(0, hit);
          const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf('：'), head.lastIndexOf('——'), head.lastIndexOf(','), head.lastIndexOf(';'));
          if (cut < 0) return '';
          const end = /[。！？]$/.test(sentence) ? sentence.slice(-1) : '';
          return sentence.slice(0, cut) + end;
        })
        .join('');
      return out.replace(/[，；：,;]\s*$/, '').trimEnd();
    })
    .filter((line, i, all) => line.trim() !== '' || all[i] === '')
    .join('\n');
}
