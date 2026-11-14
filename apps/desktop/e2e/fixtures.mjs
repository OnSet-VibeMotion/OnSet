import { test as base, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeShellFixture } from '../../../packages/engine/src/testsupport/windowsfixtures/index.ts';

/*
 * 客户端端到端测试的公共部分。
 *
 * 每个用例一套临时目录：HOME、userData（ONSET_DESKTOP_USER_DATA）、项目登记（ONSET_STUDIO_CONFIG）、记忆库（ONSET_MEMORY_DIR）、音色库（ONSET_VOICES_DIR），
 * 测试不碰 ~/.local/share/onset、~/Library/Application Support/片场与真实的项目登记。
 * PATH 最前面是 e2e/fake-bin（假 claude 与只用来显示「已安装」的 codex），ONSET_DESKTOP_KEEP_PATH=1 让主进程不再把登录 shell 的
 * PATH 并到前面——否则真实的 claude 会被先找到。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const desktopDir = path.resolve(here, '..');
const fakeBin = path.join(here, 'fake-bin');

export const test = base.extend({
  /**
   * 个别用例要换掉的启动环境（test.use({ appEnv: {...} })）：值为 null 的删掉。
   * 例如测「渲染工具没装」时去掉固定的 RENDERER，并把 PATH 收窄到假工具与系统目录——开发机上真装着的 qoder、codebuddy 不能算进来。
   */
  appEnv: [{}, { option: true }],

  sandbox: async ({}, use) => {
    // realpath：macOS 的临时目录在 /var 下，而 /var 是 /private/var 的链接，Studio 按解析后的路径认项目。
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-desktop-e2e-')));
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
  project: async ({ sandbox, electronApp }, use) => {
    const project = fs.mkdtempSync(path.join(sandbox.home, 'onset-studio-e2e-'));
    const scene = path.join(project, 'scenes', 'scene-001');
    fs.mkdirSync(scene, { recursive: true });
    fs.writeFileSync(path.join(project, 'onset.conf'), 'ORCHESTRATOR=claude\nRENDERER=claude\n');
    // 新建时记下的流程：顶栏、制作路线与「开始制作」的提示词都按它。
    fs.writeFileSync(
      path.join(project, 'onset.flow.json'),
      JSON.stringify({ version: 1, production: { id: 'speech', canvas: 'vertical-3x4' } }, null, 2) + '\n',
    );
    fs.writeFileSync(path.join(project, 'notes.md'), '项目笔记\n');
    fs.mkdirSync(path.join(project, 'templates'));
    fs.writeFileSync(path.join(project, 'templates', 'project-rules.md'), '# 项目规则\n');
    fs.writeFileSync(path.join(scene, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
    fs.writeFileSync(path.join(scene, 'prompt.md'), 'before\n');
    fs.writeFileSync(
      path.join(scene, 'scene.json'),
      JSON.stringify({ id: 'scene-001', duration_seconds: 1, output: 'out.mp4', transcript: 'voice.srt', text: 'hello' }),
    );
    if (process.platform === 'win32') {
      // Windows 的项目入口使用真正的 IPC，只替换系统对话框的返回值。
      await electronApp.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      }, project);
    }
    await use({ path: project, name: path.basename(project), promptFile: path.join(scene, 'prompt.md') });
  },

  electronApp: async ({ sandbox, appEnv }, use) => {
    // Unix fake executables need explicit Node/Git-sh launchers on Windows.
    // Keep all generated adapters inside this test's private sandbox.
    let clientFakeBin = fakeBin;
    if (process.platform === 'win32') {
      clientFakeBin = path.join(sandbox.root, 'fake-bin');
      for (const name of ['claude', 'codex', 'opencode']) {
        writeShellFixture(path.join(clientFakeBin, name), fs.readFileSync(path.join(fakeBin, name), 'utf8'));
      }
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ONSET_STUDIO_E2E_CONFIG;
    Object.assign(env, {
      HOME: sandbox.home,
      ONSET_DESKTOP_USER_DATA: sandbox.userData,
      ONSET_DESKTOP_KEEP_PATH: '1',
      // 后台运行：不弹窗口、不进 Dock，不打断开发者手上的事（main.ts）。
      ONSET_DESKTOP_BACKGROUND: '1',
      ONSET_STUDIO_CONFIG: sandbox.registry,
      ONSET_MEMORY_DIR: sandbox.memory,
      ONSET_VOICES_DIR: sandbox.voices,
      // 制作人的模型服务密钥：不碰开发者自己填的。
      ONSET_AGENT_DIR: sandbox.agent,
      // 不用 safeStorage：测试不能碰开发者的钥匙串（第一次用会弹授权框），key 照旧写成 0600 的明文文件。
      ONSET_AGENT_KEYS_PLAINTEXT: '1',
      // 第三方插件（已装插件清单与插件的数据目录）：不碰开发者自己装的。
      ONSET_STATIONS_DIR: sandbox.stations,
      ONSET_SETTINGS_FILE: sandbox.settings,
      ONSET_STUDIO_SKIP_SKILL_INSTALL: '1',
      ORCHESTRATOR: 'claude',
      RENDERER: 'claude',
      PATH: `${clientFakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    });
    for (const [key, value] of Object.entries(appEnv)) {
      if (value === null) delete env[key];
      else env[key] = value.replaceAll('{fakeBin}', clientFakeBin);
    }
    // 假麦克风：音色页「录我的声音」的用例不碰真麦克风，也不弹系统的麦克风授权。
    const app = await electron.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '.'], cwd: desktopDir, env });
    await use(app);
    await app.close();
  },

  page: async ({ electronApp }, use) => {
    // 主窗口与桌宠异步载入；macOS 负载较高时也可能先收到桌宠的 window 事件。
    const mainPage = () => electronApp.windows().find((window) => window.url() === 'onset://app/');
    await expect.poll(() => !!mainPage()).toBe(true);
    const page = mainPage();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export { expect };

/**
 * 桌宠窗口（main/pet.ts）：后台运行时不显示，但照样建、照样收状态。
 * 主进程里要找主窗口时用 `BrowserWindow.getAllWindows().find((w) => w.isResizable())`：桌宠窗口不能调大小，
 * 而它刚建好、还没载入时 URL 是空的，按 URL 认不出来。
 */
export async function petPage(electronApp) {
  const find = () => electronApp.windows().find((win) => win.url().endsWith('/pet'));
  await expect.poll(() => !!find()).toBe(true);
  return find();
}

/** 经「切换项目」对话框打开 fixture 里的项目。 */
export async function openProject(page, project) {
  await page.locator('#open-project-trigger').click();
  await page.locator('#mode-open').click();
  if (process.platform === 'win32') {
    await page.locator('#native-open-directory').click();
    await expect(page.locator('#project-dialog .native-directory-browser .path')).toHaveText(project.path);
  } else {
    await page.locator('.directory-row.project-row', { hasText: project.name }).click();
  }
  await page.locator('#open-project').click();
  await expect(page.locator('#title')).toHaveText(project.name);
  // 对话是主栏，画面面板默认收起：收起栏里有了镜头就说明项目加载好了（窄窗口里收起栏不显示，只看在不在）。
  await expect(page.locator('.rail-scene[title="scene-001"]')).toBeAttached();
}

/**
 * 在测试的插件目录里装上一个本机目录的插件（写用户级的 installed.json，与 station_add 写的同一种格式）。
 * 插件对所有项目生效；客户端每次请求现读，开着也能装。
 */
export function installPlugin(sandbox, dir, id = 'fake-publisher') {
  fs.mkdirSync(sandbox.stations, { recursive: true });
  const role = { flow: false, replaces: '', after: '', nodes: true };
  fs.writeFileSync(
    path.join(sandbox.stations, 'installed.json'),
    JSON.stringify({ version: 1, plugins: [{ id, version: '0.1.0', source: `link:${dir}`, commit: '', digest: '', role }] }, null, 2) + '\n',
  );
}

/** 已装插件的 id（用户级的 installed.json）。 */
export function installedPlugins(sandbox) {
  const file = path.join(sandbox.stations, 'installed.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).plugins.map((p) => p.id) : [];
}

/** 打开画面面板（默认收起）。 */
export async function openPanel(page) {
  await page.locator('#panel-toggle').click();
  await expect(page.locator('#panel')).toBeVisible();
}

/** 在窗口里请求后台接口：界面从 onset://app/ 加载，/api 与它同源。 */
/** 打开顶栏「页面」菜单里的一页（合成、风格、音色、复查、记忆与插件页面）。 */
export async function openPage(page, tab) {
  await page.locator('#page-menu-trigger').click();
  await page.locator(`.page-menu-list [data-tab="${tab}"]`).click();
}

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
