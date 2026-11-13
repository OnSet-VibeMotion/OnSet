import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, api, desktopDir } from './fixtures.mjs';

// 测试用的假发布站：只写回执，不联网（packages/engine/src/flow/testdata/fake-publisher）。
const fake = path.resolve(desktopDir, '..', '..', 'packages', 'engine', 'src', 'flow', 'testdata', 'fake-publisher');

test('a third-party station is added in settings and its publish action runs only when the user clicks', async ({ page, project }) => {
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: draft\ncopy:\n  primary_title: 测试标题\n---\n');
  await openProject(page, project);

  // 设置页：加进这个项目（写任务，写项目的 article-to-motion.flow.json）。
  await page.locator('#settings-trigger').click();
  const stations = page.locator('#settings-dialog section.stations[aria-label="流程插件"]');
  await stations.getByLabel('插件来源').fill(`link:${fake}`);
  await stations.getByRole('button', { name: '添加' }).click();
  const lock = path.join(project.path, 'article-to-motion.flow.json');
  await expect.poll(() => fs.existsSync(lock)).toBe(true);
  const card = stations.locator('li[data-station="fake-publisher"]');
  await expect(card).toContainText('假发布');
  await expect(card).toContainText('第三方');
  await card.getByRole('button', { name: '详情与设置' }).click();
  await expect(card.locator('.station-prompt')).toContainText('请用户在发布页点');
  await expect(card).toContainText('要你点的');
  await expect(card.locator('.station-experimental')).toContainText('用到了实验性能力：hooks');
  // 本机目录的站改动立即生效，没有「更新」。
  await expect(card.getByRole('button', { name: '更新' })).toHaveCount(0);
  await stations.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('stations-settings.png') });
  await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();

  // 制作路线上多了一站，排在发布后面。
  const progress = await api(page, '/api/progress');
  expect(progress.body.stations.map((s) => s.id).slice(-2)).toEqual(['publish', 'auto-publish']);

  // 发布页：只有用户点了才发。
  await page.locator('[data-tab="publish"]').click();
  const action = page.locator('.stations-actions .station-op[data-op="send"]');
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

  // 去掉：锁文件随之删掉。
  await page.locator('#settings-trigger').click();
  await page.locator('#settings-dialog li[data-station="fake-publisher"]').getByRole('button', { name: '去掉' }).click();
  await expect.poll(() => fs.existsSync(lock)).toBe(false);
});

test('a plugin page runs sandboxed and gets everything through the host', async ({ page, project }) => {
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: draft\n---\n');
  fs.writeFileSync(path.join(project.path, '.env'), 'MINIMAX_VOICE_ID=do-not-leak\n');
  fs.writeFileSync(
    path.join(project.path, 'article-to-motion.flow.json'),
    JSON.stringify({ version: 1, stations: [{ id: 'fake-publisher', version: '0.1.0', source: `link:${fake}`, commit: '', digest: '' }] }),
  );
  await openProject(page, project);

  // 插件页面收在顶栏的「插件」菜单里（只用来嵌小窗的页面不列）。
  await page.locator('#plugin-menu-trigger').click();
  await expect(page.locator('.plugin-menu-list [data-tab]')).toHaveCount(1);
  await page.locator('.plugin-menu-list [data-tab="x:fake-publisher:dashboard"]').click();
  await expect(page.locator('#plugin-menu-trigger')).toHaveText('发布看板 ▾');
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
  await frame.locator('#send').click();
  const confirm = host.locator('.station-confirm');
  await expect(confirm).toContainText('「假发布」请求执行：把成片发到平台');
  await expect(confirm).toContainText('platform=douyin');
  await page.screenshot({ path: test.info().outputPath('station-page-confirm.png') });
  const receipt = path.join(project.path, 'production', 'publish', 'receipts.json');
  expect(fs.existsSync(receipt)).toBe(false);
  await confirm.getByRole('button', { name: '执行', exact: true }).click();
  await expect.poll(() => fs.existsSync(receipt)).toBe(true);
  // 任务跑完，宿主让页面重读。
  await expect(frame.locator('#receipt')).toHaveText('回执：https://example.invalid/douyin/1');

  // 拒绝：页面拿到「没有同意」。
  await frame.locator('#send').click();
  await host.locator('.station-confirm').getByRole('button', { name: '不执行' }).click();
  await expect(frame.locator('#result')).toHaveText('没执行：用户没有同意');

  // 交给 AI：只填进对话框，不发送。
  await frame.locator('#ask').click();
  await expect(page.locator('#prompt')).toHaveValue(/帮我写一句抖音的发布语/);
  await expect(page.locator('#prompt')).toHaveValue(/来自插件「假发布」的页面/);
  await page.screenshot({ path: test.info().outputPath('station-page.png') });
  expect(await page.content()).not.toContain('do-not-leak');
});

test('plugins get settings, a slot in the publish page, a slash command, hooks and calls into am', async ({ page, project }) => {
  fs.mkdirSync(path.join(project.path, 'production'), { recursive: true });
  fs.writeFileSync(path.join(project.path, 'production', 'script-final.md'), '# 稿\n正文\n');
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: draft\n---\n');
  fs.writeFileSync(
    path.join(project.path, 'article-to-motion.flow.json'),
    JSON.stringify({ version: 1, stations: [{ id: 'fake-publisher', version: '0.1.0', source: `link:${fake}`, commit: '', digest: '' }] }),
  );
  await openProject(page, project);

  // 设置页：权限一目了然；密钥只写不读。
  await page.locator('#settings-trigger').click();
  const card = page.locator('#settings-dialog li[data-station="fake-publisher"]');
  await expect(card).toContainText('还有设置没填');
  await card.getByRole('button', { name: '详情与设置' }).click();
  await expect(card.locator('.station-perms')).toContainText('镜头、制作进度、发布信息的概况');
  await expect(card.locator('.station-perms')).toContainText('整片复查');
  await expect(card.locator('.station-perms')).toContainText('你确认一个审核关卡后');
  await card.getByLabel('平台令牌').fill('tok-e2e-secret');
  await card.locator('[data-setting="token"]').getByRole('button', { name: '保存' }).click();
  await expect(card.locator('[data-setting="token"]')).toContainText('已填写');
  await card.getByLabel('默认平台').selectOption('bilibili');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('station-settings.png') });
  expect(await page.content()).not.toContain('tok-e2e-secret');
  await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();
  // 插件不把顶栏撑出窗口（原来就有的 2px 是右上角的连接状态点）。
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);

  // 嵌进发布页的小窗：拿到嵌入位与设置（不含密钥）。
  await page.locator('[data-tab="publish"]').click();
  const slot = page.frameLocator('.station-slots[data-slot="publish"] .station-frame');
  await expect(slot.locator('#where')).toHaveText('嵌在 publish · 默认平台 bilibili');
  // 小窗里打开插件的整页。
  await slot.locator('#open').click();
  const frame = page.frameLocator('.station-page:not(.station-slot) .station-frame');
  await expect(frame.locator('#project')).toHaveText(/项目有 1 个镜头/);
  // 页面跟随宿主的配色。
  await expect(frame.locator('#theme')).toHaveText('强调色 #d9a35f');

  // 调 am 自带的操作：先请用户确认，拒绝就不跑。
  await frame.locator('#review').click();
  const confirm = page.locator('.station-confirm');
  await expect(confirm).toContainText('「假发布」请求调用 ArticleToMotion 的：整片复查');
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

test('a plugin can bring a whole flow, a voice, a style library, and send a message for the user', async ({ page, project }) => {
  fs.writeFileSync(
    path.join(project.path, 'article-to-motion.flow.json'),
    JSON.stringify({ version: 1, stations: [{ id: 'fake-publisher', version: '0.1.0', source: `link:${fake}`, commit: '', digest: '' }] }),
  );
  await openProject(page, project);
  await expect(page.locator('.steps [data-tab="script"]')).toBeVisible();

  // 设置页：它带来的东西都列出来。
  await page.locator('#settings-trigger').click();
  const dialog = page.locator('#settings-dialog');
  const card = dialog.locator('li[data-station="fake-publisher"]');
  await card.getByRole('button', { name: '详情与设置' }).click();
  const perms = card.locator('.station-perms');
  await expect(perms).toContainText('假配音');
  await expect(perms).toContainText('caption-kit');
  await expect(perms).toContainText('假风格库');
  await expect(perms).toContainText('往这几个阶段里加了说明：render');
  await expect(perms).toContainText('客户端开着时每 30 分钟');
  // 插件的配音出现在「配音」的可选项里。
  await expect(dialog.locator('.settings-row[data-key="TTS_PROVIDER"]').getByLabel('全局配音').locator('option[value="x:fake-publisher"]')).toHaveCount(1);

  // 改用它带来的流程：顶栏第一步换成它的页面。
  await card.getByRole('button', { name: '这个项目改用它' }).click();
  const lock = path.join(project.path, 'article-to-motion.flow.json');
  await expect.poll(() => JSON.parse(fs.readFileSync(lock, 'utf8')).flow).toBe('fake-publisher');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('station-flow.png') });
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(page.locator('.steps [data-tab="x:fake-publisher:dashboard"]')).toBeVisible();
  await expect(page.locator('.steps [data-tab="script"]')).toHaveCount(0);
  const progress = await api(page, '/api/progress');
  expect(progress.body.mode).toBe('x:fake-publisher');
  expect(progress.body.stations.map((s) => s.id)).toEqual(['intake', 'render', 'assemble', 'review', 'gate-final', 'auto-publish']);

  // 它的风格库出现在整片风格里。
  const styles = await api(page, '/api/film-styles');
  expect(JSON.stringify(styles.body)).toContain('x-fake-publisher');

  // 页面替用户发消息：先确认，确认后才进对话。
  await page.locator('.steps [data-tab="x:fake-publisher:dashboard"]').click();
  const frame = page.frameLocator('.station-page:not(.station-slot) .station-frame');
  await frame.locator('#send-msg').click();
  const confirm = page.locator('.station-confirm');
  await expect(confirm).toContainText('「假发布」想替你发一条消息给 AI');
  await expect(confirm).toContainText('帮我把发布标题改短一点');
  await confirm.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.locator('#messages')).toContainText('帮我把发布标题改短一点');

  // 回到自带的流程。
  await page.locator('#settings-trigger').click();
  await card.getByRole('button', { name: '详情与设置' }).click();
  await card.getByRole('button', { name: '回到自带的流程' }).click();
  await expect.poll(() => JSON.parse(fs.readFileSync(lock, 'utf8')).flow).toBeUndefined();
});

test('builtin features are plugins too: on by default, off per project, locked while in use', async ({ page, project }) => {
  await openProject(page, project);
  await page.locator('#settings-trigger').click();
  const builtin = page.locator('#settings-dialog section[aria-label="内置功能"]');
  const song = builtin.locator('li[data-builtin="song"]');
  await expect(song).toContainText('歌曲讲解');
  const toggle = song.getByRole('switch');
  await expect(toggle).toBeChecked();
  // 内置的不算第三方，也不能去掉。
  await expect(song).not.toContainText('第三方');
  await expect(song.getByRole('button', { name: '去掉' })).toHaveCount(0);
  await builtin.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('builtin-features.png') });

  const lock = path.join(project.path, 'article-to-motion.flow.json');
  // 开关是写任务：点了之后等它写完、界面刷新再看。
  await toggle.click();
  await expect.poll(() => (fs.existsSync(lock) ? JSON.parse(fs.readFileSync(lock, 'utf8')).disabled : null)).toEqual(['song']);
  await expect(song).toHaveClass(/off/);
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect.poll(() => fs.existsSync(lock)).toBe(false);
  await expect(toggle).toBeChecked();

  // 认领了渲染技能的内置功能提醒开关会让镜头重渲染；歌曲讲解不认领，不提醒。
  await expect(builtin.locator('li[data-builtin]')).toHaveCount(5);
  await expect(builtin.locator('li[data-builtin="algorithmic-art"]')).toContainText('已经渲染的镜头要重新渲染');
  await expect(builtin.locator('li[data-builtin="cast"]')).toContainText('多角色对话');
  await expect(song).not.toContainText('重新渲染');

  // 关掉「发布」：顶栏没有发布这一步；打开又回来。
  await expect(page.locator('.steps [data-tab="publish"]')).toBeAttached();
  const publishing = builtin.locator('li[data-builtin="publishing"]');
  await publishing.getByRole('switch').click();
  await expect.poll(() => (fs.existsSync(lock) ? JSON.parse(fs.readFileSync(lock, 'utf8')).disabled : null)).toEqual(['publishing']);
  await expect(page.locator('.steps [data-tab="publish"]')).toHaveCount(0);
  await expect(page.locator('.more-pages [data-tab="publish"]')).toHaveCount(0);
  await publishing.getByRole('switch').click();
  await expect.poll(() => fs.existsSync(lock)).toBe(false);
  await expect(page.locator('.steps [data-tab="publish"]')).toBeAttached();

  // 项目正在用歌曲讲解：开关锁住。
  fs.writeFileSync(path.join(project.path, 'song.yaml'), 'provider: none\n');
  await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();
  await page.locator('#settings-trigger').click();
  await expect(page.locator('#settings-dialog li[data-builtin="song"]').getByRole('switch')).toBeDisabled();
  await expect(page.locator('#settings-dialog li[data-builtin="song"]')).toContainText('这个项目正在用（有 song.yaml）');
});
