import { test as base, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * 客户端端到端测试的公共部分。
 *
 * 每个用例一套临时目录：HOME、userData（AM_DESKTOP_USER_DATA）、项目登记（AM_STUDIO_CONFIG）、记忆库（AM_MEMORY_DIR）、音色库（AM_VOICES_DIR），
 * 测试不碰 ~/.local/share/am、~/Library/Application Support/ArticleToMotion 与真实的项目登记。
 * PATH 最前面是 e2e/fake-bin（假 claude 与只用来显示「已安装」的 codex），AM_DESKTOP_KEEP_PATH=1 让主进程不再把登录 shell 的
 * PATH 并到前面——否则真实的 claude 会被先找到。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const desktopDir = path.resolve(here, '..');
const fakeBin = path.join(here, 'fake-bin');

export const test = base.extend({
  sandbox: async ({}, use) => {
    // realpath：macOS 的临时目录在 /var 下，而 /var 是 /private/var 的链接，Studio 按解析后的路径认项目。
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-desktop-e2e-')));
    const dirs = {
      root,
      home: path.join(root, 'home'),
      userData: path.join(root, 'user-data'),
      memory: path.join(root, 'memory'),
      voices: path.join(root, 'voices'),
      agent: path.join(root, 'agent'),
      stations: path.join(root, 'stations'),
      settings: path.join(root, 'settings.conf'),
      registry: path.join(root, 'config', 'projects.json'),
    };
    for (const dir of [dirs.home, dirs.userData, dirs.memory, path.dirname(dirs.registry)]) fs.mkdirSync(dir, { recursive: true });
    await use(dirs);
    fs.rmSync(root, { recursive: true, force: true });
  },

  /** 一个只有 scene-001 的项目，放在临时 HOME 下（「打开项目」从 HOME 浏览）。 */
  project: async ({ sandbox }, use) => {
    const project = fs.mkdtempSync(path.join(sandbox.home, 'am-studio-e2e-'));
    const scene = path.join(project, 'scenes', 'scene-001');
    fs.mkdirSync(scene, { recursive: true });
    fs.writeFileSync(path.join(project, 'article-to-motion.conf'), 'ORCHESTRATOR=claude\nRENDERER=claude\n');
    fs.writeFileSync(path.join(project, 'PROMPT.md'), '整片制作提示词\n');
    fs.writeFileSync(path.join(scene, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
    fs.writeFileSync(path.join(scene, 'prompt.md'), 'before\n');
    fs.writeFileSync(
      path.join(scene, 'scene.json'),
      JSON.stringify({ id: 'scene-001', duration_seconds: 1, output: 'out.mp4', transcript: 'voice.srt', text: 'hello' }),
    );
    await use({ path: project, name: path.basename(project), promptFile: path.join(scene, 'prompt.md') });
  },

  electronApp: async ({ sandbox }, use) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.AM_STUDIO_E2E_CONFIG;
    Object.assign(env, {
      HOME: sandbox.home,
      AM_DESKTOP_USER_DATA: sandbox.userData,
      AM_DESKTOP_KEEP_PATH: '1',
      // 后台运行：不弹窗口、不进 Dock，不打断开发者手上的事（main.ts）。
      AM_DESKTOP_BACKGROUND: '1',
      AM_STUDIO_CONFIG: sandbox.registry,
      AM_MEMORY_DIR: sandbox.memory,
      AM_VOICES_DIR: sandbox.voices,
      // 导演的模型服务密钥：不碰开发者自己填的。
      AM_AGENT_DIR: sandbox.agent,
      // 第三方站（及其数据目录）：不碰开发者自己加的。
      AM_STATIONS_DIR: sandbox.stations,
      AM_SETTINGS_FILE: sandbox.settings,
      AM_STUDIO_SKIP_SKILL_INSTALL: '1',
      ORCHESTRATOR: 'claude',
      RENDERER: 'claude',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    });
    // 假麦克风：音色页「录我的声音」的用例不碰真麦克风，也不弹系统的麦克风授权。
    const app = await electron.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '.'], cwd: desktopDir, env });
    await use(app);
    await app.close();
  },

  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export { expect };

/** 经「切换项目」对话框打开 fixture 里的项目。 */
export async function openProject(page, project) {
  await page.locator('#open-project-trigger').click();
  await page.locator('#mode-open').click();
  await page.locator('.directory-row.project-row', { hasText: project.name }).click();
  await page.locator('#open-project').click();
  await expect(page.locator('#title')).toHaveText(project.name);
  // 对话是主栏，画面面板默认收起：收起栏里有了镜头就说明项目加载好了（窄窗口里收起栏不显示，只看在不在）。
  await expect(page.locator('.rail-scene[title="scene-001"]')).toBeAttached();
}

/** 打开画面面板（默认收起）。 */
export async function openPanel(page) {
  await page.locator('#panel-toggle').click();
  await expect(page.locator('#panel')).toBeVisible();
}

/** 在窗口里请求后台接口：界面从 am://app/ 加载，/api 与它同源。 */
export async function api(page, url, init) {
  return page.evaluate(
    async ({ url, init }) => {
      const res = await fetch(url, init);
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text };
      }
    },
    { url, init },
  );
}
