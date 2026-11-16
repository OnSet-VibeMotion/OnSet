import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test, expect, openProject, api, desktopDir, installPlugin, installedPlugins, openPage } from './fixtures.mjs';

// 测试用的假发布站：只写回执，不联网（packages/engine/src/flow/testdata/fake-publisher）。
const fake = path.resolve(desktopDir, '..', '..', 'packages', 'engine', 'src', 'flow', 'testdata', 'fake-publisher');

test('a local plugin folder can be selected, previewed and loaded without a git repository', async ({ page, electronApp, sandbox }) => {
  const folder = path.join(sandbox.root, '本地插件 #1');
  fs.cpSync(fake, folder, { recursive: true });
  const selectFolder = async (directory) => {
    await electronApp.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: selected === null, filePaths: selected === null ? [] : [selected] });
    }, directory);
    await stations.getByRole('button', { name: '选择本地文件夹' }).click();
    await expect(stations.getByRole('button', { name: '选择本地文件夹' })).toBeEnabled();
  };
  await page.locator('#settings-trigger').click();
  const stations = page.locator('#settings-dialog section.stations[aria-label="我的插件"]');
  const source = stations.getByLabel('插件来源');
  await source.fill('github:someone/plugin');
  await selectFolder(null);
  await expect(source).toHaveValue('github:someone/plugin');
  expect(installedPlugins(sandbox)).toEqual([]);

  // 选错目录时沿用清单校验，失败不安装，也不影响下一次选择。
  await selectFolder(sandbox.root);
  await stations.getByRole('button', { name: '添加', exact: true }).click();
  await expect(stations).toContainText('里没有 onset-station.json');
  expect(installedPlugins(sandbox)).toEqual([]);

  await selectFolder(folder);
  await expect(source).toHaveValue(`link:${folder}`);
  await stations.getByRole('button', { name: '添加', exact: true }).click();
  const confirm = stations.getByRole('alertdialog', { name: '确认添加插件' });
  await expect(confirm).toContainText(folder);
  await expect(confirm).toContainText('改动立即生效');
  expect(installedPlugins(sandbox)).toEqual([]);
  await confirm.getByRole('button', { name: '装上', exact: true }).click();
  const card = stations.locator('li[data-station="fake-publisher"]');
  await expect(card).toContainText('假发布');
  await expect(card.getByRole('button', { name: '更新', exact: true })).toHaveCount(0);
  expect(fs.existsSync(path.join(folder, '.git'))).toBe(false);
  const manifestPath = path.join(folder, 'onset-station.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.description = '本地修改已经生效';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  expect((await api(page, '/api/stations')).body.stations.find((s) => s.id === 'fake-publisher')?.description).toBe(manifest.description);
  await card.getByRole('button', { name: '去掉', exact: true }).click();
  await expect.poll(() => installedPlugins(sandbox)).toEqual([]);
  expect(fs.existsSync(manifestPath)).toBe(true);
});

test('a git plugin can be previewed, cancelled, installed and updated using the client runtime', async ({ page, sandbox }) => {
  test.skip(spawnSync('git', ['--version']).status !== 0, 'requires git');
  const repo = path.join(sandbox.root, 'plugin-repo');
  fs.cpSync(fake, repo, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'v1');

  await page.locator('#settings-trigger').click();
  const stations = page.locator('#settings-dialog section.stations[aria-label="我的插件"]');
  const confirm = stations.getByRole('alertdialog', { name: '确认添加插件' });
  const add = async () => {
    await stations.getByLabel('插件来源').fill(pathToFileURL(repo).href);
    await stations.getByRole('button', { name: '添加', exact: true }).click();
    await expect(confirm).toContainText('假发布');
    const staged = fs.readdirSync(path.join(sandbox.stations, '.staging'));
    expect(staged).toHaveLength(1);
    expect(fs.existsSync(path.join(sandbox.stations, '.staging', staged[0], 'src', '.git'))).toBe(false);
  };

  await add();
  expect(installedPlugins(sandbox)).toEqual([]);
  await confirm.getByRole('button', { name: '取消' }).click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(() => fs.readdirSync(path.join(sandbox.stations, '.staging'))).toEqual([]);

  await add();
  await confirm.getByRole('button', { name: '装上', exact: true }).click();
  await expect.poll(() => installedPlugins(sandbox)).toEqual(['fake-publisher']);
  const card = stations.locator('li[data-station="fake-publisher"]');
  await expect(card).toContainText('假发布');

  const file = path.join(repo, 'onset-station.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.version = '0.2.0';
  fs.writeFileSync(file, JSON.stringify(manifest));
  git('commit', '-qam', 'v2');
  await card.getByRole('button', { name: '更新', exact: true }).click();
  await expect(confirm).toContainText('0.2.0');
  await confirm.getByRole('button', { name: '换上', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(async () => (await api(page, '/api/stations')).body.stations.find((s) => s.id === 'fake-publisher')?.version).toBe('0.2.0');
  expect(fs.readdirSync(path.join(sandbox.stations, '.staging'))).toEqual([]);

  // 清单校验失败时 .git 还在：仍要清掉只读对象，并显示校验错误而不是清理错误。
  manifest.unknown_field = true;
  fs.writeFileSync(file, JSON.stringify(manifest));
  git('commit', '-qam', 'invalid manifest');
  await card.getByRole('button', { name: '更新', exact: true }).click();
  await expect(stations).toContainText('不认识的字段');
  expect(fs.readdirSync(path.join(sandbox.stations, '.staging'))).toEqual([]);
  expect(installedPlugins(sandbox)).toEqual(['fake-publisher']);
});

/**
 * 点插件页面里的按钮，直到宿主有反应。Chromium 按合成器的命中数据把点击转进进程外的 iframe，后台运行的测试窗口里
 * 这份数据会落后于布局：iframe 刚挂上、刚挪过位置（面板滑入）时，Playwright 在 iframe 里算好的坐标点下去，事件落在
 * 宿主的 iframe 元素上，页面根本没收到（实测偶发，日志里宿主收到 mousedown、页面一个事件都没有）。没送到的点击什么都
 * 不会发生，所以按「宿主有没有反应」重点即可；reacted 用短超时断言那个反应。
 */
async function clickInPage(target, reacted) {
  await expect(async () => {
    await target.click();
    await reacted();
  }).toPass({ timeout: 20_000 });
}

test('a plugin is added in settings without a project, every project gets it, and its action in settings runs only when the user clicks', async ({ page, project, sandbox }) => {
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: draft\ncopy:\n  primary_title: 测试标题\n---\n');
  // 还没打开任何项目：首页。
  await expect(page.locator('.home-hero h1')).toContainText('今天想做一条');

  // 设置页「我的插件」：装在这台电脑上，对所有项目生效（写用户级的 installed.json，不碰项目文件）。
  await page.locator('#settings-trigger').click();
  const stations = page.locator('#settings-dialog section.stations[aria-label="我的插件"]');
  await stations.getByLabel('插件来源').fill(`link:${fake}`);
  await stations.getByRole('button', { name: '添加' }).click();
  // 第一步：取回、给你看这个插件自己的实情，还没装上——任何项目都看不到它。
  const confirmAdd = stations.getByRole('alertdialog', { name: '确认添加插件' });
  await expect(confirmAdd).toContainText('假发布');
  await expect(confirmAdd).toContainText('把成片发到平台');
  await expect(confirmAdd).toContainText('能读写你的文件、能联网');
  await expect(confirmAdd.locator('.staged-page-perms')).toContainText('镜头、制作进度、发布信息的概况');
  await expect(confirmAdd.locator('.staged-page-perms')).toContainText('整片复查');
  await expect(confirmAdd).toContainText('你确认一个审核关卡后');
  await expect(confirmAdd).toContainText('快剪（新建项目时在「做法」里选）');
  await expect(confirmAdd).toContainText('假风格库');
  await expect(confirmAdd).toContainText('接在「发布」后面');
  await expect(confirmAdd).toContainText('用到了实验性能力：hooks');
  await expect(confirmAdd).toContainText('对这台电脑上的所有项目生效');
  expect(installedPlugins(sandbox)).toEqual([]);
  expect((await api(page, '/api/stations')).body.stations.some((x) => x.id === 'fake-publisher')).toBe(false);
  await stations.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('stations-staged.png') });
  // 第二步：点「装上」才写进已装插件清单。
  await confirmAdd.getByRole('button', { name: '装上' }).click();
  await expect.poll(() => installedPlugins(sandbox)).toEqual(['fake-publisher']);
  await expect(confirmAdd).toHaveCount(0);
  const lock = path.join(project.path, 'onset.flow.json');
  expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual({ version: 1, production: { id: 'speech', canvas: 'vertical-3x4' } });
  const card = stations.locator('li[data-station="fake-publisher"]');
  await expect(card).toContainText('假发布');
  await expect(card).toContainText('第三方');
  // 「详情与设置」是盖在设置上的弹窗。
  await card.getByRole('button', { name: '详情与设置' }).click();
  const detail = page.getByRole('dialog', { name: '假发布 详情与设置' });
  await expect(detail).toBeVisible();
  await expect(detail.locator('.station-prompt')).toContainText('请用户在发布页点');
  // 没打开项目：登录这类插件自己的配置照样能点；针对项目的操作要先打开项目。
  await expect(detail).toContainText('「把成片发到平台」「顺手记一笔」针对项目执行，打开一个项目后在这里点');
  await expect(detail.locator('.station-op')).toHaveCount(1);
  const login = detail.locator('.station-op[data-op="login"]');
  await login.getByLabel('账号备注名').fill('小号');
  await login.getByRole('button', { name: '登录平台账号' }).click();
  await expect(login.locator('.station-last')).toHaveText('上次执行成功');
  await expect(login.locator('.station-output')).toContainText('已登录：小号');
  expect(JSON.parse(fs.readFileSync(path.join(sandbox.stations, 'fake-publisher', 'data', 'login.json'), 'utf8'))).toEqual({ name: '小号' });
  // 插件收到的是「没有项目」，片场也没把插件目录当成项目去扫。
  const loginRun = (await api(page, '/api/stations')).body.stations.find((x) => x.id === 'fake-publisher').ops.find((o) => o.name === 'login').last_run;
  expect(loginRun.data).toMatchObject({ in_project: false });
  expect(loginRun.out_of_scope).toBeUndefined();
  expect(fs.existsSync(path.join(sandbox.stations, 'production'))).toBe(false);
  // 登录完，账号列表（清单 list: true）自动刷新成卡片：头像、名字与卡片上的按钮。
  await expect(detail.locator('.stations-result')).toHaveText('已登录：小号');
  const account = detail.locator('.plugin-list[data-op="accounts"] .plugin-item');
  await expect(account).toHaveCount(1);
  await expect(account).toContainText('小号');
  await expect(account.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  // 只在卡片上的按钮（form: false）不出表单；点了先问一句。
  await expect(detail.locator('.station-op[data-op="logout"]')).toHaveCount(0);
  await account.getByRole('button', { name: '退出' }).click();
  await expect(account).toContainText('退出后要重新登录，确定吗？');
  await account.getByRole('button', { name: '退出' }).click();
  await expect(detail.locator('.plugin-list[data-op="accounts"] .plugin-item')).toHaveCount(0);
  await expect(detail.locator('.plugin-list[data-op="accounts"]')).toContainText('还没有。');
  await login.getByLabel('账号备注名').fill('小号');
  await login.getByRole('button', { name: '登录平台账号' }).click();
  await expect(account).toContainText('小号');
  await expect(detail).toContainText('要你点的');
  await expect(detail.locator('.station-trust')).toContainText('它的操作是在你电脑上运行的程序');
  await expect(detail.locator('.station-experimental')).toContainText('用到了实验性能力：hooks');
  await expect(detail.locator('.station-perms:not(.station-page-perms)')).toContainText('新建项目时在「做法」里选');
  await page.screenshot({ path: test.info().outputPath('stations-settings.png') });
  // Esc 只关这一层弹窗，设置还开着。
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(page.locator('#settings-dialog')).toBeVisible();
  // 本机目录的站改动立即生效，没有「更新」。
  await expect(card.getByRole('button', { name: '更新' })).toHaveCount(0);
  await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();

  // 首页新建时能选到它带来的做法，标明来自哪个插件。
  await page.locator('#home-mode').click();
  const mode = page.locator('.menu-item', { hasText: '快剪' });
  await expect(mode).toContainText('来自插件「假发布」');
  await page.keyboard.press('Escape');

  // 已有的项目不用再加，打开就有。
  await openProject(page, project);
  // 制作路线上多了一站，排在发布后面。
  const progress = await api(page, '/api/progress');
  expect(progress.body.stations.map((s) => s.id).slice(-2)).toEqual(['publish', 'auto-publish']);

  // 插件的配置不在发布页，在设置的「详情与设置」里：只有用户点了才发。
  await page.locator('[data-tab="publish"]').click();
  await expect(page.locator('.publish-tab')).toBeVisible();
  await expect(page.locator('.publish-tab .station-op')).toHaveCount(0);
  await page.locator('#settings-trigger').click();
  await page.locator('#settings-dialog li[data-station="fake-publisher"]').getByRole('button', { name: '详情与设置' }).click();
  const pluginCard = page.getByRole('dialog', { name: '假发布 详情与设置' });
  await expect(pluginCard.locator('[data-setting="token"]')).toContainText('未填写');
  const action = pluginCard.locator('.station-op[data-op="send"]');
  await expect(action).toBeVisible();
  const send = action.getByRole('button', { name: '把成片发到平台' });
  await expect(send).toBeDisabled();
  await action.getByLabel('平台，例如 douyin').fill('douyin');
  await send.click();
  const receipt = path.join(project.path, 'production', 'publish', 'receipts.json');
  await expect.poll(() => fs.existsSync(receipt)).toBe(true);
  expect(JSON.parse(fs.readFileSync(receipt, 'utf8')).platform).toBe('douyin');
  await expect.poll(async () => (await api(page, '/api/stations')).body.stations.find((x) => x.id === 'fake-publisher').ops[0].last_run?.ok).toBe(true);
  await expect.poll(async () => (await api(page, '/api/progress')).body.stations.find((s) => s.id === 'auto-publish').status).toBe('done');
  await page.screenshot({ path: test.info().outputPath('stations-publish.png') });
  // 它的页面从这里打开：关掉弹窗与设置，在画面面板里打开。
  await pluginCard.getByRole('button', { name: '打开「发布看板」' }).click();
  await expect(page.locator('#settings-dialog')).toHaveCount(0);
  await expect(pluginCard).toHaveCount(0);
  await expect(page.locator('.station-page:not(.station-slot) .station-page-bar')).toContainText('发布看板');

  // 去掉：所有项目都不再有它；项目的锁文件始终只有新建时记下的流程。
  await page.locator('#settings-trigger').click();
  await page.locator('#settings-dialog li[data-station="fake-publisher"]').getByRole('button', { name: '去掉' }).click();
  await expect.poll(() => installedPlugins(sandbox)).toEqual([]);
  await expect.poll(async () => (await api(page, '/api/progress')).body.stations.some((s) => s.id === 'auto-publish')).toBe(false);
  expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual({ version: 1, production: { id: 'speech', canvas: 'vertical-3x4' } });
});

test('a plugin page runs sandboxed and gets everything through the host', async ({ page, project, sandbox }) => {
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: draft\n---\n');
  fs.writeFileSync(path.join(project.path, '.env'), 'MINIMAX_VOICE_ID=do-not-leak\n');
  installPlugin(sandbox, fake);
  await openProject(page, project);

  // 插件页面收在顶栏「页面」菜单里自己的一组（只用来嵌小窗的页面不列）。
  await page.locator('#page-menu-trigger').click();
  await expect(page.locator('.page-menu-list .station-icon')).toHaveCount(1);
  await page.locator('.page-menu-list [data-tab="x:fake-publisher:dashboard"]').click();
  await expect(page.locator('#page-menu-trigger')).toHaveText('发布看板');
  const host = page.locator('.station-page');
  await expect(host).toContainText('第三方插件 · 假发布');
  const frame = page.frameLocator('.station-frame');
  await expect(frame.locator('#title')).toHaveText(`假发布 · ${project.name}`);
  // 沙箱：直接调接口被拦下，.env 读不到，只能读清单里声明过的文件。
  await expect(frame.locator('#probe')).toHaveText('直接调接口被拦下');
  await expect(frame.locator('#secret')).toHaveText('.env 被拒绝');
  await expect(frame.locator('#publish')).toContainText('发布信息');
  await expect(frame.locator('#receipt')).toHaveText('还没有回执');

  // 页面里的按钮不算用户同意：宿主先弹确认。
  // 只比纵向：面板滑入的动画可能还在走，横向会差一两个像素。
  const vertical = async () => {
    const box = await host.locator('.station-frame').boundingBox();
    return { y: box?.y, height: box?.height };
  };
  const before = await vertical();
  const confirm = host.locator('.station-confirm');
  await clickInPage(frame.locator('#send'), () => expect(confirm).toBeVisible({ timeout: 2000 }));
  await expect(confirm).toContainText('「假发布」请求执行：把成片发到平台');
  // 确认条盖在页面上，不把页面往下推：页面一挪，紧跟着的点击会按旧位置命中、落不进页面。
  expect(await vertical()).toEqual(before);
  await expect(confirm).toContainText('platform=douyin');
  await page.screenshot({ path: test.info().outputPath('station-page-confirm.png') });
  const receipt = path.join(project.path, 'production', 'publish', 'receipts.json');
  expect(fs.existsSync(receipt)).toBe(false);
  await confirm.getByRole('button', { name: '执行', exact: true }).click();
  await expect.poll(() => fs.existsSync(receipt)).toBe(true);
  // 任务跑完，宿主让页面重读。
  await expect(frame.locator('#receipt')).toHaveText('回执：https://example.invalid/douyin/1');

  // 拒绝：页面拿到「没有同意」。
  await clickInPage(frame.locator('#send'), () => expect(confirm).toBeVisible({ timeout: 2000 }));
  await confirm.getByRole('button', { name: '不执行' }).click();
  await expect(frame.locator('#result')).toHaveText('没执行：用户没有同意');

  // 交给 AI：只填进对话框，不发送。
  await clickInPage(frame.locator('#ask'), () => expect(page.locator('#prompt')).toHaveValue(/帮我写一句抖音的发布语/, { timeout: 2000 }));
  await expect(page.locator('#prompt')).toHaveValue(/来自插件「假发布」的页面/);
  await page.screenshot({ path: test.info().outputPath('station-page.png') });
  expect(await page.content()).not.toContain('do-not-leak');

  // 切走再切回来（iframe 重新挂载）：页面一加载就发的请求照样有回应，执行请求照样弹确认。
  await page.locator('#prompt').fill('');
  await page.locator('.steps [data-tab="script"]').click();
  await expect(page.locator('.station-frame')).toHaveCount(0);
  await openPage(page, 'x:fake-publisher:dashboard');
  await expect(frame.locator('#title')).toHaveText(`假发布 · ${project.name}`);
  await expect(frame.locator('#receipt')).toHaveText('回执：https://example.invalid/douyin/1');
  await clickInPage(frame.locator('#send'), () => expect(confirm).toBeVisible({ timeout: 2000 }));
  await confirm.getByRole('button', { name: '不执行' }).click();
  await expect(frame.locator('#result')).toHaveText('没执行：用户没有同意');
});

test('plugins get settings, a slot in the publish page, a slash command, hooks and calls into onset', async ({ page, project, sandbox }) => {
  fs.mkdirSync(path.join(project.path, 'production'), { recursive: true });
  fs.writeFileSync(path.join(project.path, 'production', 'script-final.md'), '# 稿\n正文\n');
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: draft\n---\n');
  installPlugin(sandbox, fake);
  await openProject(page, project);

  // 设置页：权限一目了然；密钥只写不读。
  await page.locator('#settings-trigger').click();
  const card = page.locator('#settings-dialog li[data-station="fake-publisher"]');
  await expect(card).toContainText('还有设置没填');
  await card.getByRole('button', { name: '详情与设置' }).click();
  const detail = page.getByRole('dialog', { name: '假发布 详情与设置' });
  // 页面的权限与插件接进来的地方分开列：页面在沙箱里，操作不在。
  await expect(detail.locator('.station-page-perms')).toContainText('镜头、制作进度、发布信息的概况');
  await expect(detail.locator('.station-page-perms')).toContainText('整片复查');
  await expect(detail.locator('.station-perms:not(.station-page-perms)')).toContainText('你确认一个审核关卡后');
  await detail.getByLabel('平台令牌').fill('tok-e2e-secret');
  await detail.locator('[data-setting="token"]').getByRole('button', { name: '保存' }).click();
  await expect(detail.locator('[data-setting="token"]')).toContainText('已填写');
  await detail.getByLabel('默认平台').selectOption('bilibili');
  await page.screenshot({ path: test.info().outputPath('station-settings.png') });
  expect(await page.content()).not.toContain('tok-e2e-secret');
  await detail.getByRole('button', { name: '关闭' }).click();
  await expect(card).toContainText('第三方');
  await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();
  // 插件不把顶栏撑出窗口（原来就有的 2px 是右上角的连接状态点）。
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);

  // 没打开项目时在设置里登录过的账号（只在插件自己的数据目录里，项目里没有它的文件）。
  fs.mkdirSync(path.join(sandbox.stations, 'fake-publisher', 'data'), { recursive: true });
  fs.writeFileSync(path.join(sandbox.stations, 'fake-publisher', 'data', 'login.json'), JSON.stringify({ name: '小号' }));
  // 嵌进发布页的小窗：拿到嵌入位与设置（不含密钥）。
  await page.locator('[data-tab="publish"]').click();
  const slot = page.frameLocator('.station-slots[data-slot="publish"] .station-frame');
  await expect(slot.locator('#where')).toHaveText('嵌在 publish · 默认平台 bilibili');
  // 小窗经 onset.list 现读插件的账号列表，不用用户确认，也不靠项目里的文件。
  await expect(slot.locator('#accounts')).toHaveText('账号：小号');
  await expect(page.locator('.station-confirm')).toHaveCount(0);
  // 小窗排在发布页下面，不盖住发布页的内容（发布页曾被压扁、内容溢出到小窗上）。
  const overlap = await page.evaluate(() => {
    const tab = document.querySelector('.publish-tab');
    const slots = document.querySelector('.station-slots[data-slot="publish"]');
    if (!tab || !slots) return null;
    const contentBottom = Math.max(...[...tab.querySelectorAll('*')].map((el) => el.getBoundingClientRect().bottom));
    return contentBottom - slots.getBoundingClientRect().top;
  });
  expect(overlap).not.toBeNull();
  expect(overlap).toBeLessThanOrEqual(0);
  // 小窗里打开插件的整页。
  await clickInPage(slot.locator('#open'), () => expect(page.locator('.station-page:not(.station-slot) .station-frame')).toBeVisible({ timeout: 2000 }));
  const frame = page.frameLocator('.station-page:not(.station-slot) .station-frame');
  await expect(frame.locator('#project')).toHaveText(/项目有 1 个镜头/);
  // 页面跟随宿主的配色。
  await expect(frame.locator('#theme')).toHaveText('强调色 #d9a35f');

  // 调 onset 自带的操作：先请用户确认，拒绝就不跑。
  const confirm = page.locator('.station-confirm');
  await clickInPage(frame.locator('#review'), () => expect(confirm).toBeVisible({ timeout: 2000 }));
  await expect(confirm).toContainText('「假发布」请求调用片场的：整片复查');
  await confirm.getByRole('button', { name: '不执行' }).click();
  await expect(frame.locator('#result')).toHaveText('没执行：用户没有同意');

  // 事件钩子：确认稿件审核关卡后自动跑插件的操作，令牌经 stdin 交给它。
  await api(page, '/api/progress/gates/gate-script', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  const log = path.join(project.path, 'production', 'publish', 'hooks.log');
  await expect.poll(() => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')).toBe('gate.confirmed token=set\n');

  // 斜杠命令：/fabu 打开插件页面。
  await page.locator('[data-tab="script"]').click();
  await page.locator('#prompt').fill('/fabu');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('.station-page:not(.station-slot) .station-page-bar')).toContainText('发布看板');
});

test('a plugin brings a new kind of project, a voice and a style library, and sends a message for the user', async ({ page, project, sandbox }) => {
  installPlugin(sandbox, fake);
  // 先打开一个项目，让「保存到」默认落在测试用的临时 HOME 里。
  await openProject(page, project);

  // 设置页：它带来的东西都列出来。
  await page.locator('#settings-trigger').click();
  const dialog = page.locator('#settings-dialog');
  const card = dialog.locator('li[data-station="fake-publisher"]');
  await card.getByRole('button', { name: '详情与设置' }).click();
  const detail = page.getByRole('dialog', { name: '假发布 详情与设置' });
  const perms = detail.locator('.station-perms:not(.station-page-perms)');
  await expect(perms).toContainText('假配音');
  await expect(perms).toContainText('caption-kit');
  await expect(perms).toContainText('假风格库');
  await expect(perms).toContainText('往这几个阶段里加了说明：render');
  await expect(perms).toContainText('客户端开着时每 30 分钟');
  await expect(perms).toContainText('快剪');
  // 流程只在新建时定：已有项目没有「改用」的入口。
  await expect(detail.getByRole('button', { name: '这个项目改用它' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('station-flow.png') });
  await detail.getByRole('button', { name: '关闭' }).click();
  // 插件的配音出现在「配音」的可选项里。
  await expect(dialog.locator('.settings-row[data-key="TTS_PROVIDER"]').getByLabel('全局配音').locator('option[value="x:fake-publisher"]')).toHaveCount(1);
  await dialog.getByRole('button', { name: '关闭' }).click();

  // 首页：选它带来的做法新建一个项目。
  await page.locator('.brand').click();
  await page.locator('#home-mode').click();
  await page.locator('.menu-item', { hasText: '快剪' }).click();
  await expect(page.locator('#home-mode')).toContainText('快剪');
  // 它的风格库在首页的整片风格里就能选到（还没有项目）。
  await page.locator('#home-style').click();
  await page.locator('.film-styles .fs-search').fill('水墨');
  await expect(page.locator('.film-styles .fs-item[data-style="x-fake-publisher/ink"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#home-prompt').fill('插件做法的端到端测试');
  await page.locator('#home-send').click();
  await expect(page.locator('.creation')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('#title')).toContainText('插件做法的端到端测试');
  const created = (await api(page, '/api/projects')).body.projects.find((p) => p.name.startsWith('插件做法的端到端测试'));
  expect(JSON.parse(fs.readFileSync(path.join(created.path, 'onset.flow.json'), 'utf8')).production.id).toBe('x:fake-publisher');

  // 顶栏第一步是它的页面，路线是它的。
  await expect(page.locator('.steps [data-tab="x:fake-publisher:dashboard"]')).toBeVisible();
  await expect(page.locator('.steps [data-tab="script"]')).toHaveCount(0);
  const progress = await api(page, '/api/progress');
  expect(progress.body.mode).toBe('x:fake-publisher');
  expect(progress.body.stations.map((s) => s.id)).toEqual(['intake', 'render', 'assemble', 'review', 'gate-final', 'auto-publish']);

  // 页面替用户发消息：先确认，确认后才进对话。
  await page.locator('.steps [data-tab="x:fake-publisher:dashboard"]').click();
  const frame = page.frameLocator('.station-page:not(.station-slot) .station-frame');
  await expect(frame.locator('#title')).toHaveText(/^假发布 · /);
  const confirm = page.locator('.station-confirm');
  await clickInPage(frame.locator('#send-msg'), () => expect(confirm).toBeVisible({ timeout: 2000 }));
  await expect(confirm).toContainText('「假发布」想替你发一条消息给 AI');
  await expect(confirm).toContainText('帮我把发布标题改短一点');
  await confirm.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.locator('#messages')).toContainText('帮我把发布标题改短一点');
});

test('builtin features are plugins too: always on, listed with what they bring, no switch', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#settings-trigger').click();
  const builtin = page.locator('#settings-dialog section[aria-label="内置功能"]');
  const song = builtin.locator('li[data-builtin="song"]');
  await expect(song).toContainText('歌曲讲解');
  // 内置功能常开：没有开关，也不提醒重新渲染。
  await expect(builtin.getByRole('switch')).toHaveCount(0);
  await expect(builtin).not.toContainText('重新渲染');
  // 内置的不算第三方，也不能去掉。
  await expect(song).not.toContainText('第三方');
  await expect(song.getByRole('button', { name: '去掉' })).toHaveCount(0);
  await builtin.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('builtin-features.png') });

  await expect(builtin.locator('li[data-builtin]')).toHaveCount(10);
  await expect(builtin.locator('li[data-builtin="lemo-styles"]')).toContainText('LemoLab 风格库');
  await expect(builtin.locator('li[data-builtin="anidoodle-styles"]')).toContainText('anidoodle 代码绘画');
  await expect(builtin.locator('li[data-builtin="huashu-styles"]')).toContainText('花叔艺术动画');
  await expect(builtin.locator('li[data-builtin="cast"]')).toContainText('多角色对话');
  // 「详情」照实列出这个功能在片场里登记了什么。
  const cast = builtin.locator('li[data-builtin="cast"]');
  await cast.getByRole('button', { name: '详情' }).click();
  await expect(cast.locator('.builtin-detail')).toContainText('character-rig');
  await expect(cast.locator('.builtin-detail')).toContainText('校验多角色项目');
  await cast.getByRole('button', { name: '收起' }).click();
  // 带风格库的功能，详情里写明它带了哪个库。
  const lemo = builtin.locator('li[data-builtin="lemo-styles"]');
  await lemo.getByRole('button', { name: '详情' }).click();
  await expect(lemo.locator('.builtin-detail')).toContainText('整片风格库');
  await lemo.getByRole('button', { name: '收起' }).click();
  // 口播项目的顶栏有发布这一步。
  await expect(page.locator('.steps [data-tab="publish"]')).toBeAttached();
});

test('files a plugin op writes outside what it declared are shown as a warning', async ({ page, project, sandbox }) => {
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: draft\n---\n');
  installPlugin(sandbox, fake);
  await openProject(page, project);

  // 设置里的按钮：假发布顺手写了 notes/scribble.txt（清单只声明了 production/publish/）。
  await page.locator('#settings-trigger').click();
  const card = page.locator('#settings-dialog li[data-station="fake-publisher"]');
  await card.getByRole('button', { name: '详情与设置' }).click();
  const detail = page.getByRole('dialog', { name: '假发布 详情与设置' });
  const action = detail.locator('.station-op[data-op="scribble"]');
  await action.getByRole('button', { name: '顺手记一笔' }).click();
  const warning = action.locator('.station-scope');
  await expect(warning).toContainText('它改了 1 个没声明会写的文件');
  await expect(warning).toContainText('notes/scribble.txt');
  await expect(warning).not.toContainText('production/publish/scribble.json');
  await expect(action.locator('.station-last')).toHaveText('上次执行成功');
  await page.screenshot({ path: test.info().outputPath('station-scope-settings.png') });
  await detail.getByRole('button', { name: '关闭' }).click();
  await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();
  // 任务列表里同样标出来。
  await page.locator('#tasks-toggle').click();
  await expect(page.locator('#tasks .task-warning').first()).toContainText('插件「假发布」改了它没有声明会写的项目文件：notes/scribble.txt');
  await page.locator('#tasks-toggle').click();
  await page.screenshot({ path: test.info().outputPath('station-scope-publish.png') });

  // 插件页面的 onset.run()：用户点「执行」后，回执处（宿主那一侧）标出越界的文件。
  fs.rmSync(path.join(project.path, 'notes'), { recursive: true, force: true });
  await openPage(page, 'x:fake-publisher:dashboard');
  const host = page.locator('.station-page');
  const frame = page.frameLocator('.station-frame');
  await expect(frame.locator('#title')).toHaveText(`假发布 · ${project.name}`);
  await expect(host.locator('.station-scope')).toHaveCount(0);
  await clickInPage(frame.locator('#scribble'), () => expect(host.locator('.station-confirm')).toBeVisible({ timeout: 2000 }));
  await host.locator('.station-confirm').getByRole('button', { name: '执行', exact: true }).click();
  await expect(host.locator('.station-scope')).toContainText('「假发布」执行「顺手记一笔」');
  await expect(host.locator('.station-scope')).toContainText('notes/scribble.txt');
  await page.screenshot({ path: test.info().outputPath('station-scope-page.png') });
});

test('a third-party station that declares its state says when it waits for you, and its next-step buttons work', async ({ page, project, sandbox }) => {
  // 假发布只用清单顶替内置「发布」：并进 declared-state.json（站点读 publish.md 的 publish_status）。
  const dir = test.info().outputPath('declared-publisher');
  fs.cpSync(fake, dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'onset-station.json'), 'utf8'));
  const patch = JSON.parse(fs.readFileSync(path.join(dir, 'declared-state.json'), 'utf8'));
  manifest.replaces = patch.replaces;
  delete manifest.after;
  delete manifest.flow;
  Object.assign(manifest.nodes[0], patch.node);
  fs.writeFileSync(path.join(dir, 'onset-station.json'), JSON.stringify(manifest, null, 2));

  // 试听确认过（前面的站都算过了），发布信息只差人工检查。
  fs.mkdirSync(path.join(project.path, 'production'), { recursive: true });
  fs.writeFileSync(path.join(project.path, 'production', 'approval.json'), '{"approved_at":"2026-11-01T00:00:00Z"}');
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: pending_manual_checks\n---\n');
  installPlugin(sandbox, dir);
  await openProject(page, project);

  const progress = await api(page, '/api/progress');
  expect(progress.body.current).toBe('auto-publish');
  expect(progress.body.waiting_on).toBe('user');
  const strip = page.locator('#progress-strip');
  await expect(strip).toContainText('现在 · 自动发布');
  await expect(strip).toContainText('还剩人工检查，等你处理');
  await expect(strip).toHaveClass(/waiting/);

  const card = page.locator('#next-step');
  await expect(card).toContainText('发布前还剩几项人工检查');
  await page.screenshot({ path: test.info().outputPath('declared-next-step.png') });
  // 填进输入框。
  await card.getByRole('button', { name: '核对完了' }).click();
  await expect(page.locator('#prompt')).toHaveValue('发布前的人工检查我核对完了：');
  // 插件的操作：先在卡片上问一次，点「执行」才跑。
  await card.getByRole('button', { name: '先记一笔' }).click();
  const confirm = card.getByRole('alertdialog', { name: '确认执行' });
  await expect(confirm).toContainText('执行插件操作「顺手记一笔（测试用：会写一个没声明的文件）」？');
  await confirm.getByRole('button', { name: '取消' }).click();
  await expect(confirm).toHaveCount(0);
  const note = path.join(project.path, 'notes', 'scribble.txt');
  expect(fs.existsSync(note)).toBe(false);
  await card.getByRole('button', { name: '先记一笔' }).click();
  await confirm.getByRole('button', { name: '执行' }).click();
  await expect.poll(() => fs.existsSync(note)).toBe(true);

  // 发布信息改成 ready：这一站做完，路线走完。
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: ready\n---\n');
  await expect.poll(async () => (await api(page, '/api/progress')).body.stations.find((s) => s.id === 'auto-publish').status).toBe('done');
});

test('opening a plugin page from settings leaves the home page', async ({ page, project, sandbox }) => {
  installPlugin(sandbox, fake);
  await openProject(page, project);
  // 回到首页，再从设置里打开插件的页面：页面要真的出来，不能还停在首页。
  await page.locator('.brand').click();
  await expect(page.locator('.home-hero h1')).toBeVisible();
  await page.locator('#settings-trigger').click();
  await page.locator('#settings-dialog li[data-station="fake-publisher"]').getByRole('button', { name: '详情与设置' }).click();
  await page.getByRole('dialog', { name: '假发布 详情与设置' }).getByRole('button', { name: '打开「发布看板」' }).click();
  await expect(page.locator('.home-hero h1')).toHaveCount(0);
  await expect(page.locator('.station-page:not(.station-slot) .station-page-bar')).toContainText('发布看板');
});

test('a plugin action clicked twice in a row runs once', async ({ page, sandbox }) => {
  installPlugin(sandbox, fake);
  await expect(page.locator('.home-hero h1')).toBeVisible();
  await page.locator('#settings-trigger').click();
  await page.locator('#settings-dialog li[data-station="fake-publisher"]').getByRole('button', { name: '详情与设置' }).click();
  const detail = page.getByRole('dialog', { name: '假发布 详情与设置' });
  await expect(detail.locator('.plugin-list[data-op="accounts"]')).toContainText('还没有。');
  const idle = async () => expect.poll(async () => (await api(page, '/api/tasks')).body.tasks.some((t) => t.status === 'running' || t.status === 'queued'), { timeout: 15000 }).toBe(false);
  await idle();
  const before = (await api(page, '/api/tasks')).body.tasks.length;
  // 连点两下：按钮在重画成「不可点」之前还能收到第二下，第二次提交要被挡住。
  await detail.locator('.station-op[data-op="login"]').getByRole('button', { name: '登录平台账号' }).evaluate((button) => { button.click(); button.click(); });
  await expect(detail.locator('.plugin-list[data-op="accounts"] .plugin-item')).toHaveCount(1);
  await idle();
  // 一次登录，加上登录完刷新一次账号列表。
  expect((await api(page, '/api/tasks')).body.tasks.length - before).toBe(2);
});
