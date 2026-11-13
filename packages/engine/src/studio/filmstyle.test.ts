// 移植自 internal/studio/filmstyle_test.go。
import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as filmstyle from '../filmstyle';
import * as lemo from '../filmstyle/lemo';
import { jpegSize, posterThumbWidth } from './filmstyle';
import { hasFfmpeg, setEnv, startStudio, studioRequest, tempDir, writeStudioFile, writeStudioJPEG } from './testsupport';

describe('filmstyle', () => {
  // 风格目录随程序下发，不联网就能列出；海报从风格库读并缩成缩略图；
  // 本项目的整片风格可查、可装（经 am film-style 任务）、未知风格直接拒绝。
  it('film style endpoints', async () => {
    const library = tempDir();
    writeStudioFile(path.join(library, 'core', 'lib.js'), '//');
    const first = lemo.catalog()[0].slug;
    const lemoSource = (body: any) => {
      const source = (body.sources as any[]).find((item) => item.id === lemo.SourceID);
      expect(source, `风格来源里没有 ${lemo.SourceID}`).toBeDefined();
      return source;
    };
    // 来源数据是前置资源：先看没准备好时报 ready=false、提示 am setup。
    setEnv(lemo.LibraryEnv, path.join(tempDir(), 'absent'));
    const empty = startStudio({ projectPath: tempDir(), configPath: path.join(tempDir(), 'projects.json') });
    let { status, body } = await studioRequest(empty, 'GET', '/api/film-styles');
    expect(status).toBe(200);
    let source = lemoSource(body);
    expect(source.ready, '来源没准备好时应当报 ready=false').toBe(false);
    expect(source.problem).toContain('am setup');

    for (const slug of [first, 'impasto']) {
      writeStudioFile(path.join(library, 'styles', slug, 'STYLE.md'), '# ' + slug);
      writeStudioFile(path.join(library, 'styles', slug, 'demo', 'index.html'), '<html>');
      if (hasFfmpeg) writeStudioJPEG(path.join(library, 'styles', slug, 'poster.jpg'), 960, 540);
      else writeStudioFile(path.join(library, 'styles', slug, 'poster.jpg'), 'not a jpeg');
    }
    setEnv(lemo.LibraryEnv, library);
    // 缩略图缓存在风格根目录下，别写进开发者真实的目录。
    setEnv(filmstyle.RootEnv, tempDir());

    const root = tempDir();
    writeStudioFile(path.join(root, 'article-to-motion.conf'), '');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });

    ({ status, body } = await studioRequest(s, 'GET', '/api/film-styles'));
    expect(status).toBe(200);
    expect(body.styles, `应当列出全部 ${filmstyle.catalog().length} 种风格`).toHaveLength(filmstyle.catalog().length);
    source = lemoSource(body);
    expect(source.ready, '来源应当已就绪').toBe(true);
    expect(source.gallery).not.toBe('');
    expect(source.categories.length).toBeGreaterThanOrEqual(2);

    const res = await s.handle(new Request('http://studio.test/api/film-styles/lemo-opuscar/impasto/poster.jpg'));
    const raw = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    if (hasFfmpeg) {
      const thumbPath = path.join(tempDir(), 'thumb.jpg');
      fs.writeFileSync(thumbPath, raw);
      expect(jpegSize(thumbPath).width, `菜单里应当给缩略图（宽 ${posterThumbWidth}）`).toBe(posterThumbWidth);
      const full = await s.handle(new Request('http://studio.test/api/film-styles/lemo-opuscar/impasto/poster.jpg?size=full'));
      fs.writeFileSync(thumbPath, Buffer.from(await full.arrayBuffer()));
      expect(jpegSize(thumbPath).width).toBe(960);
    } else {
      // 缩不了就退回原图。
      expect(raw.toString()).toBe('not a jpeg');
    }
    for (const p of [
      '/api/film-styles/lemo-opuscar/no-such/poster.jpg',
      '/api/film-styles/lemo-opuscar/watercolor/poster.jpg',
      '/api/film-styles/lemo-opuscar/impasto/STYLE.md',
      '/api/film-styles/impasto/poster.jpg',
      '/api/film-styles/other/impasto/poster.jpg',
    ]) {
      expect((await s.handle(new Request('http://studio.test' + p))).status, `${p} 应当 404`).toBe(404);
    }

    ({ status, body } = await studioRequest(s, 'GET', '/api/film-style'));
    expect(status).toBe(200);
    expect(body.installed, '新项目不该有整片风格').toBe(false);
    ({ status } = await studioRequest(s, 'POST', '/api/film-style', '{"style":"no-such"}'));
    expect(status, '未知风格应当 400').toBe(400);
    // 合法风格会起一个 am film-style 任务；测试里没有可运行的 am，只验到拒绝未知风格为止（同 Go 版）。
  });

  // 一个项目装几种风格：GET 列出默认风格、额外风格与各自有哪些镜头在用，点名了却没装的镜头单列出来。
  it('lists extra styles and which scenes use them', async () => {
    const root = tempDir();
    writeStudioFile(path.join(root, 'article-to-motion.conf'), '');
    const [a, b] = lemo.catalog();
    const writeStyle = (dir: string, slug: string) => {
      writeStudioFile(path.join(dir, filmstyle.StyleFile), '# ' + slug);
      writeStudioFile(path.join(dir, filmstyle.GuideFile), 'guide');
      writeStudioFile(path.join(dir, filmstyle.ManifestFile), JSON.stringify({ source: lemo.SourceID, slug, cn: slug, en: slug, version: 'v', digest: 'd', installed_at: '' }));
    };
    writeStyle(filmstyle.skillDir(root), a.slug);
    const bKey = lemo.SourceID + '/' + b.slug;
    writeStyle(filmstyle.extraDir(root, bKey), b.slug);
    const scene = (id: string, style: string) =>
      writeStudioFile(path.join(root, 'scenes', id, 'scene.json'), JSON.stringify({ id, film_style: style || undefined }));
    scene('scene-001', '');
    scene('scene-002', bKey);
    scene('scene-003', 'none');
    scene('scene-004', 'other/missing');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    const { status, body } = await studioRequest(s, 'GET', '/api/film-style');
    expect(status).toBe(200);
    expect(body.installed).toBe(true);
    expect(body.manifest.slug).toBe(a.slug);
    expect(body.default_scenes).toEqual(['scene-001']);
    expect(body.extras).toHaveLength(1);
    expect(body.extras[0].manifest.slug).toBe(b.slug);
    expect(body.extras[0].scenes).toEqual(['scene-002']);
    expect(body.extras[0].style_file).toBe(`.agents/am-film-styles/${bKey}/STYLE.md`);
    expect(body.scenes).toContainEqual({ id: 'scene-003', film_style: 'none' });
    expect(body.missing).toEqual([{ scene: 'scene-004', style: 'other/missing' }]);
  });

  // 前置资源引导：只读状态，缺技能时 ready 为 false，并给出 am setup。
  it('setup status endpoint', async () => {
    setEnv('XDG_DATA_HOME', tempDir()); // 技能缓存在这里找，必然没有
    const s = startStudio({ projectPath: tempDir(), configPath: path.join(tempDir(), 'projects.json') });
    const { status, body } = await studioRequest(s, 'GET', '/api/setup');
    expect(status).toBe(200);
    expect(body.ready, '缺技能时应当 ready=false').toBe(false);
    expect(body.command).toBe('am setup');
    const byID: Record<string, any> = {};
    for (const item of body.items) byID[item.id] = item;
    expect(byID.skills.ready, '技能应当是缺的必需项').toBe(false);
    expect(byID.skills.required).toBe(true);
    expect(byID.cli.ready, 'setup 放了假的 CLI，应当就绪').toBe(true);
    expect(byID['styles:lemo-opuscar']?.required, '整片风格来源应当是可选项').toBe(false);
  });
});
