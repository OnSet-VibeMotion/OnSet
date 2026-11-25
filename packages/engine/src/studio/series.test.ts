import './testsupport';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as series from '../series';
import { setSeriesAssistRunnerForTest } from './series_assist';
import { setEnv, startStudio, tempDir } from './testsupport';

afterEach(() => {
  setSeriesAssistRunnerForTest(null);
});

async function jsonReq(method: string, url: string, body?: unknown): Promise<Request> {
  return new Request(`http://localhost${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('studio /api/series & project creation with series defaults', () => {
  it('supports CRUD, binding existing projects without moving them, and unbinding', async () => {
    const seriesRoot = tempDir();
    setEnv(series.DirEnv, seriesRoot);
    const home = fs.realpathSync(os.homedir());
    const parent = fs.mkdtempSync(path.join(home, '.onset-series-studio-test-'));
    try {
      const legacyProject = path.join(parent, 'legacy-ep');
      fs.mkdirSync(legacyProject, { recursive: true });
      const registry = path.join(tempDir(), 'projects.json');
      const server = startStudio({ configPath: registry, projectPath: legacyProject });

      // 创建专栏
      const createRes = await server.handle(
        await jsonReq('POST', '/api/series', {
          name: '硬核拆解',
          description: '技术原理解析',
          parent_dir: parent,
          naming_pattern: 'EP{nn}-{title}',
          defaults: { canvas: 'landscape-16x9', delivery: 'speech', narration: 'solo', tts_voice: '主理人' },
          brief: '节奏干脆，少废话。',
        }),
      );
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string; name: string; next_episode: number; brief: string };
      expect(created.name).toBe('硬核拆解');
      expect(created.next_episode).toBe(1);
      expect(created.brief).toContain('节奏干脆');

      // 老项目原地归入专栏（不挪目录、期号可选）
      const listedProjects = (await (await server.handle(await jsonReq('GET', '/api/projects'))).json()) as {
        projects: { id: string; series_id?: string }[];
      };
      const legacyId = listedProjects.projects[0]!.id;
      const bindRes = await server.handle(
        await jsonReq('POST', `/api/series/${created.id}/bind`, { project_id: legacyId }),
      );
      expect(bindRes.status).toBe(200);
      const bound = (await bindRes.json()) as { project: { series_id?: string; episode?: number } };
      expect(bound.project.series_id).toBe(created.id);
      expect(bound.project.episode).toBeUndefined();
      expect(fs.existsSync(path.join(legacyProject, series.BindingFile))).toBe(true);

      // 新建下一期：自动回退专栏画幅/默认父目录、绑定第 1 期并推进 next_episode 到 2、预写默认音色
      const epRes = await server.handle(
        await jsonReq('POST', '/api/projects/create', {
          parent: '',
          name: 'EP01-第一期',
          canvas: '',
          delivery: '',
          narration: '',
          film_style: '',
          naming: '',
          series_id: created.id,
        }),
      );
      expect(epRes.status).toBe(201);
      const epBody = (await epRes.json()) as {
        project: { id: string; path: string; series_id?: string; episode?: number };
      };
      expect(epBody.project.series_id).toBe(created.id);
      expect(epBody.project.episode).toBe(1);
      const flowJson = JSON.parse(fs.readFileSync(path.join(epBody.project.path, 'onset.flow.json'), 'utf8')) as {
        production: { canvas: string };
      };
      expect(flowJson.production.canvas).toBe('landscape-16x9');
      const prodConf = JSON.parse(
        fs.readFileSync(path.join(epBody.project.path, 'production', 'production-config.json'), 'utf8'),
      ) as { ttsVoice: string };
      expect(prodConf.ttsVoice).toBe('主理人');

      // 查看专栏详情：next_episode 已推进为 2，且列出两期项目
      const detailRes = await server.handle(await jsonReq('GET', `/api/series/${created.id}`));
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as {
        series: { next_episode: number; project_count: number };
        projects: { id: string }[];
      };
      expect(detail.series.next_episode).toBe(2);
      expect(detail.series.project_count).toBe(2);
      expect(detail.projects).toHaveLength(2);

      // 移出老项目
      const unbindRes = await server.handle(await jsonReq('POST', '/api/series/unbind', { project_id: legacyId }));
      expect(unbindRes.status).toBe(200);
      expect(series.readBinding(legacyProject)).toBeNull();

      // 删除专栏：不删除任何项目目录，只解除绑定
      const delRes = await server.handle(await jsonReq('DELETE', `/api/series/${created.id}`));
      expect(delRes.status).toBe(200);
      expect(fs.existsSync(epBody.project.path)).toBe(true);
      expect(series.readBinding(epBody.project.path)).toBeNull();
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('persists optional publish_template on POST /api/series and supports /api/series/assist + cancel', async () => {
    const seriesRoot = tempDir();
    setEnv(series.DirEnv, seriesRoot);
    const registry = path.join(tempDir(), 'projects.json');
    const server = startStudio({ configPath: registry, projectPath: '' });

    // POST /api/series 带 publish_template 一并落盘
    const createRes = await server.handle(
      await jsonReq('POST', '/api/series', {
        name: '带发布模板专栏',
        brief: '语言利落，少废话。',
        publish_template: {
          title_pattern: '【EP{nn}】{title}',
          default_hashtags: ['#原理拆解', '#硬核科普'],
          description_footer: '关注专栏，每周更新。',
          cover_guidelines: '暗色网格底 + 亮橙角标',
        },
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      publish_template?: { title_pattern?: string; default_hashtags?: string[] };
    };
    expect(created.publish_template?.title_pattern).toBe('【EP{nn}】{title}');
    expect(series.readPublishTemplate(seriesRoot, created.id)?.default_hashtags).toEqual(['#原理拆解', '#硬核科普']);

    // POST /api/series/assist：校验缺失输入返回 400
    const badRes = await server.handle(await jsonReq('POST', '/api/series/assist', { mode: 'draft', idea: '   ' }));
    expect(badRes.status).toBe(400);

    // POST /api/series/assist：成功返回过滤后的草案
    setSeriesAssistRunnerForTest(async (prompt) => {
      expect(prompt).toContain('landscape-16x9');
      return JSON.stringify({
        name: '架构拆解局',
        description: '每周拆解一个系统设计原理',
        naming_pattern: 'EP{nn}-{title}',
        defaults: {
          canvas: 'landscape-16x9',
          delivery: 'speech',
          narration: 'solo',
          film_style: 'nonexistent/hallucinated-style',
        },
        brief: '## 口播\n- 直入主题',
        publish_template: { title_pattern: '【EP{nn}】{title}', default_hashtags: ['#架构'] },
        rationale: '横屏适合画架构图。',
        followups: ['改竖屏短视频', '更口语轻松'],
      });
    });

    const assistRes = await server.handle(
      await jsonReq('POST', '/api/series/assist', {
        mode: 'draft',
        idea: '做一个 B 站系统架构原理拆解专栏',
      }),
    );
    expect(assistRes.status).toBe(200);
    const draft = (await assistRes.json()) as {
      name: string;
      defaults: { canvas?: string; film_style?: string };
      warnings: string[];
      followups: string[];
    };
    expect(draft.name).toBe('架构拆解局');
    expect(draft.defaults.canvas).toBe('landscape-16x9');
    expect(draft.defaults.film_style).toBeUndefined();
    expect(draft.warnings.join('\n')).toContain('nonexistent/hallucinated-style');
    expect(draft.followups).toEqual(['改竖屏短视频', '更口语轻松']);

    // DELETE /api/series/assist：取消进行中的请求返回 409
    let started!: () => void;
    const waitStarted = new Promise<void>((r) => {
      started = r;
    });
    setSeriesAssistRunnerForTest(
      (_prompt, signal) =>
        new Promise<string>((_resolve, reject) => {
          started();
          signal?.addEventListener('abort', () => {
            const err = new Error('已取消');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const pending = server.handle(await jsonReq('POST', '/api/series/assist', { mode: 'draft', idea: '长时间运行' }));
    await waitStarted;
    const cancelRes = await server.handle(await jsonReq('DELETE', '/api/series/assist'));
    expect(cancelRes.status).toBe(200);
    const cancelled = await pending;
    expect(cancelled.status).toBe(409);
  });
});
