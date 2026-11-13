// 移植自 internal/song/provider.go。
import fs from 'node:fs';
import path from 'node:path';
import { marshal } from '../gojson';
import { saveStream } from './download';
import { HttpClient, abortError, readLimited, sleep, type HttpResponse } from './http';
import { decodeFirst, decodeValue, unmarshal, type RawMessage, type Schema } from './jsondecode';
import { parseGoURL } from './store';
import type { Config } from './types';

/** 可提交、可按任务 ID 续跑的歌曲平台（ACE-Step、fal、Mureka）。 */
export interface ResumableProvider {
  submit(c: Config, lyrics: string, signal?: AbortSignal): Promise<string>;
  resume(id: string, dest: string, signal?: AbortSignal): Promise<void>;
}

export interface ACEClientOptions {
  endpoint: string;
  key?: string;
  /** 轮询间隔（毫秒），0 表示默认 3 秒。 */
  pollInterval?: number;
}

/**
 * ACEClient deliberately does not retry submissions or expose service response
 * bodies: a disconnected POST may have succeeded and errors can contain secrets.
 */
export class ACEClient implements ResumableProvider {
  endpoint: string;
  key: string;
  pollInterval: number;
  /** 测试可替换（对应 Go 里 http.Client 的 Transport 走 http.DefaultTransport）。 */
  http: HttpClient;

  constructor(options: ACEClientOptions) {
    this.endpoint = options.endpoint;
    this.key = options.key ?? '';
    this.pollInterval = options.pollInterval ?? 0;
    this.http = new HttpClient(2 * 60 * 1000);
  }

  private async request(method: string, p: string, body: unknown, signal?: AbortSignal): Promise<HttpResponse> {
    const b = Buffer.from(marshal(body));
    const u = this.endpoint.replace(/\/+$/, '') + p;
    if (!parseGoURL(u)) throw new Error('ACE-Step 请求地址无效');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.key !== '') headers.Authorization = 'Bearer ' + this.key;
    let r: HttpResponse;
    try {
      r = await this.http.do({ method, url: u, headers, body: b, signal });
    } catch {
      throw new Error('ACE-Step 请求未完成（状态可能不明）；未自动重发');
    }
    if (r.status !== 200) {
      r.close?.();
      throw new Error(`ACE-Step HTTP ${r.status}`);
    }
    return r;
  }

  private async call<T>(p: string, body: unknown, schema: Schema, signal?: AbortSignal): Promise<T> {
    const r = await this.request('POST', p, body, signal);
    let env: { code: number; data: RawMessage | null };
    try {
      const text = (await readLimited(r.body, 4 << 20)).toString('utf8');
      env = decodeFirst(text, {
        struct: [
          ['code', 'int'],
          ['data', 'raw'],
        ],
      });
    } catch {
      throw new Error('ACE-Step 返回无效 JSON');
    } finally {
      r.close?.();
    }
    if (env.code !== 200) throw new Error(`ACE-Step 服务拒绝请求（code=${env.code}）`);
    try {
      // json.Unmarshal(env.Data, out)：字段缺失时 Data 为空，解码失败。
      if (env.data === null) throw new Error('unexpected end of JSON input');
      return decodeValue(env.data.raw, schema, false) as T;
    } catch {
      throw new Error('ACE-Step data 格式无效');
    }
  }

  async submit(c: Config, lyrics: string, signal?: AbortSignal): Promise<string> {
    const req = {
      audio_duration: c.target_seconds,
      audio_format: 'mp3',
      batch_size: 1,
      bpm: c.bpm,
      lyrics,
      model: c.model,
      prompt: c.style,
      sample_mode: false,
      task_type: 'text2music',
      thinking: false,
      use_cot_caption: false,
      use_cot_language: false,
      use_format: false,
      vocal_language: c.language,
    };
    const res = await this.call<{ task_id: string }>('/release_task', req, { struct: [['task_id', 'string']] }, signal);
    if (res.task_id === '') throw new Error('ACE-Step 未返回任务 ID；请人工检查服务任务，勿自动重发');
    return res.task_id;
  }

  async resume(id: string, dest: string, signal?: AbortSignal): Promise<void> {
    const interval = this.pollInterval > 0 ? this.pollInterval : 3000;
    for (;;) {
      const rows = await this.call<Array<{ task_id: string; status: number; result: string }> | null>(
        '/query_result',
        { task_id_list: [id] },
        {
          slice: {
            struct: [
              ['task_id', 'string'],
              ['status', 'int'],
              ['result', 'string'],
            ],
          },
        },
        signal,
      );
      if (!rows || rows.length !== 1 || rows[0].task_id !== id) throw new Error('ACE-Step 查询结果与任务不一致');
      switch (rows[0].status) {
        case 1: {
          let results: Array<{ file: string }> | null;
          try {
            results = unmarshal(rows[0].result, { slice: { struct: [['file', 'string']] } });
          } catch {
            results = null;
          }
          if (!results || results.length !== 1 || results[0].file === '') throw new Error('ACE-Step 下载结果无效');
          return this.download(results[0].file, dest, signal);
        }
        case 2:
          throw new Error('ACE-Step 生成失败；未自动重发');
        case 0:
          break;
        default:
          throw new Error('ACE-Step 未知任务状态');
      }
      try {
        await sleep(interval, signal);
      } catch {
        throw abortError(signal!);
      }
    }
  }

  async download(ref: string, dest: string, signal?: AbortSignal): Promise<void> {
    const base = parseGoURL(this.endpoint);
    let baseURL: URL;
    try {
      if (!base) throw new Error('invalid');
      baseURL = new URL(this.endpoint);
    } catch {
      throw new Error('ACE-Step 地址无效');
    }
    const refParsed = parseGoURL(ref);
    let u: URL;
    try {
      if (!refParsed) throw new Error('invalid');
      u = new URL(ref, baseURL);
    } catch {
      throw new Error('ACE-Step 下载地址无效');
    }
    if (u.protocol !== baseURL.protocol || u.host !== baseURL.host || refParsed.hasUser || u.username !== '' || u.password !== '') {
      throw new Error('ACE-Step 下载必须与服务同源');
    }
    const headers: Record<string, string> = {};
    if (this.key !== '') headers.Authorization = 'Bearer ' + this.key;
    let res: HttpResponse;
    try {
      res = await this.http.do({ method: 'GET', url: u.toString(), headers, body: null, signal });
    } catch {
      throw new Error('ACE-Step 下载中断；可用原任务 ID 继续');
    }
    try {
      if (res.status !== 200) throw new Error(`ACE-Step 下载 HTTP ${res.status}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
      await saveStream(res.body, dest, '.download-', 'ACE-Step 下载不完整或超过 512 MiB');
    } finally {
      res.close?.();
    }
  }

  async health(signal?: AbortSignal): Promise<void> {
    const r = await this.request('GET', '/health', null, signal);
    r.close?.();
  }
}
