import { formatFixed } from '../gofmt';
import { marshal } from '../gojson';
import {
  decodeLyria,
  elevenPlan,
  murekaPrompt,
  runeCount,
  saveAudio,
  sortKeys,
  validateLyrics,
  withTaskID,
} from './hosted_codecs';
import { HttpClient, type HttpResponse, readLimited, sleep } from './http';
import { decodeFirst, type RawMessage, type Schema } from './jsondecode';
import { providerInfo } from './platforms';
import { idPattern, parseGoURL } from './store';
import type { Config } from './types';

export { decodeLyria, elevenPlan, murekaPrompt, saveAudio, taskIDOf, validateLyrics } from './hosted_codecs';

/**
 * HostedClient never retries a POST. Only fal/Mureka jobs with persisted IDs are resumable.
 * API origins are fixed; credentials are never attached to media downloads.
 */
export class HostedClient {
  /** 轮询间隔（毫秒）。 */
  interval = 3000;

  constructor(
    readonly config: Config,
    readonly key: string,
    readonly base: string,
    /** 测试可替换 transport（对应 Go 的 h.http.Transport）。 */
    readonly http: HttpClient,
  ) {}

  async request(method: string, p: string, body: unknown, signal?: AbortSignal): Promise<HttpResponse> {
    const payload = body === null || body === undefined ? null : Buffer.from(marshal(body));
    const url = this.base + p;
    if (!parseGoURL(url)) throw new Error('歌曲 API 地址无效');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    switch (this.config.provider) {
      case 'lyria':
        headers['x-goog-api-key'] = this.key;
        break;
      case 'elevenlabs':
        headers['xi-api-key'] = this.key;
        break;
      case 'fal':
        headers.Authorization = 'Key ' + this.key;
        break;
      default:
        headers.Authorization = 'Bearer ' + this.key;
    }
    let r: HttpResponse;
    try {
      r = await this.http.do({ method, url, headers, body: payload, signal });
    } catch {
      throw new Error(`${this.config.provider} 请求未完成；提交结果可能不明，未自动重发`);
    }
    if (r.status < 200 || r.status >= 300) {
      r.close?.();
      let hint = '';
      switch (r.status) {
        case 401:
          hint = '；检查 API Key 与地域';
          break;
        case 403:
          hint = '；检查模型权限、邀测及账户额度';
          break;
        case 429:
          hint = '；检查额度或限流';
          break;
      }
      throw new Error(
        `${this.config.provider} HTTP ${r.status}${hint}（song_providers({"platform": "${this.config.provider}"}) 查看配置）`,
      );
    }
    return r;
  }

  async json<T>(method: string, p: string, body: unknown, schema: Schema, signal?: AbortSignal): Promise<T> {
    const r = await this.request(method, p, body, signal);
    try {
      const text = (await readLimited(r.body, 4 << 20)).toString('utf8');
      return decodeFirst<T>(text, schema);
    } catch {
      throw new Error(`${this.config.provider} 返回无效 JSON`);
    } finally {
      r.close?.();
    }
  }

  async generate(lyrics: string, dest: string, signal?: AbortSignal): Promise<string> {
    validateLyrics(this.config, lyrics);
    if (this.config.provider === 'lyria') return this.generateLyria(lyrics, dest, signal);
    if (this.config.provider === 'elevenlabs') {
      const body = elevenPlan(this.config, lyrics);
      const r = await this.request('POST', '/v1/music?output_format=mp3_44100_128', body, signal);
      try {
        let id = r.headers.get('song-id') ?? '';
        if (!idPattern.test(id)) id = '';
        await withTaskID(id, saveAudio(r.body, dest));
        return id;
      } finally {
        r.close?.();
      }
    }
    const input: Record<string, unknown> = { format: 'mp3', is_instrumental: false, lyrics };
    // required by preview; ignored with lyrics
    if (this.config.model === 'fun-music-preview') input.prompt = this.config.style;
    const result = await this.json<{ request_id: string; output: { audio: { url: string } } }>(
      'POST',
      '/api/v1/services/audio/music/generation',
      { input: sortKeys(input), model: this.config.model },
      {
        struct: [
          ['request_id', 'string'],
          ['output', { struct: [['audio', { struct: [['url', 'string']] }]] }],
        ],
      },
      signal,
    );
    let id = result.request_id;
    if (!idPattern.test(id)) id = '';
    await withTaskID(id, this.download(result.output.audio.url, dest, signal));
    return id;
  }

  async submit(c: Config, lyrics: string, signal?: AbortSignal): Promise<string> {
    if (c.provider === 'mureka') return this.submitMureka(c, lyrics, signal);
    const result = await this.json<{ request_id: string }>(
      'POST',
      '/' + c.model,
      { duration: c.target_seconds, lyrics, tags: c.style },
      { struct: [['request_id', 'string']] },
      signal,
    );
    if (!idPattern.test(result.request_id)) throw new Error('fal 未返回有效任务 ID；勿自动重发');
    return result.request_id;
  }

  async resume(id: string, dest: string, signal?: AbortSignal): Promise<void> {
    if (this.config.provider === 'mureka') return this.resumeMureka(id, dest, signal);
    if (!idPattern.test(id)) throw new Error('fal 任务 ID 无效');
    const p = '/' + this.config.model + '/requests/' + id;
    for (;;) {
      const status = await this.json<{ status: string; error: RawMessage | null }>(
        'GET',
        p + '/status',
        null,
        {
          struct: [
            ['status', 'string'],
            ['error', 'raw'],
          ],
        },
        signal,
      );
      switch (status.status) {
        case 'COMPLETED': {
          if (status.error !== null && status.error.raw !== null) throw new Error('fal 任务失败；未重新提交');
          const result = await this.json<{ audio: { url: string } }>(
            'GET',
            p,
            null,
            { struct: [['audio', { struct: [['url', 'string']] }]] },
            signal,
          );
          return this.download(result.audio.url, dest, signal);
        }
        case 'IN_QUEUE':
        case 'IN_PROGRESS':
          break;
        default:
          throw new Error('fal 返回未知或失败任务状态');
      }
      await sleep(this.interval, signal);
    }
  }

  async download(ref: string, dest: string, signal?: AbortSignal): Promise<void> {
    const u = parseGoURL(ref);
    if (!u || u.hasUser || u.fragment !== '' || u.port !== '') throw new Error('歌曲下载地址无效');
    const host = u.hostname.toLowerCase();
    let allowed: boolean;
    if (this.config.provider === 'bailian') allowed = host.endsWith('.oss-cn-beijing.aliyuncs.com');
    else if (this.config.provider === 'mureka') allowed = host === 'cdn.mureka.ai' || host.endsWith('.mureka.ai');
    else allowed = host === 'fal.media' || host.endsWith('.fal.media') || host === 'storage.googleapis.com';
    if (!allowed || (u.scheme !== 'https' && u.scheme !== 'http'))
      throw new Error('歌曲下载地址不在平台存储域名清单内');
    // Official Bailian examples return HTTP OSS links; use TLS for the same signed resource.
    let target: string;
    try {
      const parsed = new URL(ref);
      parsed.protocol = 'https:';
      target = parsed.toString();
    } catch {
      throw new Error('歌曲下载请求无效');
    }
    let r: HttpResponse;
    try {
      r = await this.http.do({ method: 'GET', url: target, headers: {}, body: null, signal });
    } catch {
      throw new Error('歌曲下载中断；未重新生成');
    }
    try {
      if (r.status !== 200) throw new Error(`歌曲下载 HTTP ${r.status}；未重新生成`);
      await saveAudio(r.body, dest);
    } finally {
      r.close?.();
    }
  }

  // ---- Mureka（mureka.go）----

  async submitMureka(c: Config, lyrics: string, signal?: AbortSignal): Promise<string> {
    if (runeCount(lyrics) > 5000 || runeCount(murekaPrompt(c)) > 1024) {
      throw new Error('歌曲平台 Mureka 歌词最多 5000 字符，曲风及生成要求最多 1024 字符');
    }
    const task = await this.json<{ id: string }>(
      'POST',
      '/v1/song/generate',
      { lyrics, model: c.model, n: 1, prompt: murekaPrompt(c), stream: false },
      { struct: [['id', 'string']] },
      signal,
    );
    if (!idPattern.test(task.id)) throw new Error('歌曲平台 Mureka 未返回有效任务 ID；勿自动重发');
    return task.id;
  }

  async resumeMureka(id: string, dest: string, signal?: AbortSignal): Promise<void> {
    if (!idPattern.test(id)) throw new Error('歌曲平台 Mureka 任务 ID 无效');
    for (;;) {
      const task = await this.json<{ id: string; status: string; choices: Array<{ url: string }> | null }>(
        'GET',
        '/v1/song/query/' + id,
        null,
        {
          struct: [
            ['id', 'string'],
            ['status', 'string'],
            ['choices', { slice: { struct: [['url', 'string']] } }],
          ],
        },
        signal,
      );
      if (task.id !== id) throw new Error('歌曲平台 Mureka 查询结果与任务不一致');
      switch (task.status) {
        case 'succeeded':
          if (!task.choices || task.choices.length !== 1 || task.choices[0].url === '') {
            throw new Error('歌曲平台 Mureka 请求一首但结果数量或下载地址异常；未自动挑选');
          }
          return this.download(task.choices[0].url, dest, signal);
        case 'failed':
        case 'timeouted':
        case 'cancelled':
          throw new Error('歌曲平台 Mureka 任务失败或已终止；未自动重发');
        case 'preparing':
        case 'queued':
        case 'running':
        case 'streaming':
          break;
        default:
          throw new Error('歌曲平台 Mureka 未知任务状态');
      }
      await sleep(this.interval, signal);
    }
  }

  // ---- Lyria（lyria.go）----

  /**
   * Lyria returns inline MP3 in model_output steps. No remote URI is fetched and
   * no model-supplied lyric/timing text overwrites the project's verified lyrics.
   */
  async generateLyria(lyrics: string, dest: string, signal?: AbortSignal): Promise<string> {
    const c = this.config;
    const prompt = `Create a complete solo vocal song. Style: ${c.style}. Language: ${c.language}. Target duration: ${formatFixed(c.target_seconds, 0)} seconds. Tempo: ${c.bpm} BPM. Sing the provided lyrics verbatim in order, including every repeated section. Do not rewrite, translate, add or omit lyrics. Return MP3 audio.\nLyrics:\n${lyrics}`;
    const r = await this.request(
      'POST',
      '/v1beta/interactions',
      { input: prompt, model: c.model, store: false, stream: false },
      signal,
    );
    try {
      return await decodeLyria(r.body, dest);
    } finally {
      r.close?.();
    }
  }
}

export function newHosted(c: Config, env: Record<string, string> | null): HostedClient {
  let base = 'https://api.elevenlabs.io';
  if (c.provider === 'mureka') base = 'https://api.mureka.ai';
  if (c.provider === 'lyria') base = 'https://generativelanguage.googleapis.com';
  if (c.provider === 'fal') base = 'https://queue.fal.run';
  if (c.provider === 'bailian') base = 'https://' + c.workspace + '.cn-beijing.maas.aliyuncs.com';
  return new HostedClient(c, env?.[providerInfo(c.provider).key] ?? '', base, new HttpClient(20 * 60 * 1000));
}
