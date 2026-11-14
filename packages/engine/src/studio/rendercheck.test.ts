import './testsupport';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envMap } from '../envutil';
import { runRenderCheck } from './rendercheck';

describe('render check', () => {
  it('says why when HyperFrames is not installed', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-nocli-'));
    try {
      const result = await runRenderCheck({ ...envMap(), ONSET_HYPERFRAMES_CLI_DIR: empty });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/HyperFrames/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  // 真的渲染一次：要已装好的 HyperFrames CLI 与一个能借的浏览器。在本机这样跑（借客户端的 Electron、走引导脚本接管的路）：
  //   ONSET_TEST_RENDER_CHECK=1 ONSET_TEST_RENDER_ENV='{"ONSET_BROWSER":"…/Electron","ONSET_BROWSER_HOOK":"1","ONSET_BROWSER_APP_ARG":"…/apps/desktop"}' \
  //     npx vitest run --root packages/engine src/studio/rendercheck
  it.runIf(process.env.ONSET_TEST_RENDER_CHECK === '1')(
    'renders a small shot for real',
    async () => {
      const extra = JSON.parse(process.env.ONSET_TEST_RENDER_ENV ?? '{}') as Record<string, string>;
      const home = process.env.ONSET_TEST_REAL_HOME ?? os.homedir();
      // 测试的 setup 把 CLI 目录指到假 CLI：这里要用真的，去掉它、回到 HOME 下的默认目录。
      const env: Record<string, string> = { ...envMap(), HOME: home, ...extra };
      delete env.ONSET_HYPERFRAMES_CLI_DIR;
      const result = await runRenderCheck(env);
      expect(result.error ?? '', (result.log_tail ?? []).join('\n')).toBe('');
      expect(result.ok).toBe(true);
      expect(result.frame).toMatch(/^data:image\/png;base64,/);
      fs.writeFileSync(process.env.ONSET_TEST_RENDER_FRAME ?? path.join(os.tmpdir(), 'onset-render-check.png'), Buffer.from(result.frame!.split(',')[1], 'base64'));
      expect(result.browser).toBe(extra.ONSET_BROWSER ? 'lent' : 'downloaded');
      expect(result.hooked).toBe(extra.ONSET_BROWSER_HOOK === '1');
    },
    200_000,
  );
});
