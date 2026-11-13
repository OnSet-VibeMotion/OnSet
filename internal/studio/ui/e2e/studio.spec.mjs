import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let project;
let promptFile;

test.beforeEach(async () => {
  project = await fs.mkdtemp(path.join(process.env.HOME || os.homedir(), 'am-studio-e2e-'));
  const scene = path.join(project, 'scenes', 'scene-001');
  await fs.mkdir(scene, { recursive: true });
  await fs.writeFile(path.join(project, 'article-to-motion.conf'), 'ORCHESTRATOR=claude\nRENDERER=claude\n');
  await fs.writeFile(path.join(project, 'PROMPT.md'), '整片制作提示词\n');
  await fs.writeFile(path.join(scene, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  await fs.writeFile(path.join(scene, 'prompt.md'), 'before\n');
  await fs.writeFile(path.join(scene, 'scene.json'), JSON.stringify({
    id: 'scene-001', duration_seconds: 1, output: 'out.mp4', transcript: 'voice.srt', text: 'hello'
  }));
  promptFile = path.join(scene, 'prompt.md');
});

test.afterEach(async () => { await fs.rm(project, { recursive: true, force: true }); });

async function openProject(page) {
  await page.goto('/');
  await page.locator('#open-project-trigger').click();
  await page.locator('#mode-open').click();
  await page.locator('.directory-row.project-row', { hasText: path.basename(project) }).click();
  await page.locator('#open-project').click();
  await expect(page.locator('#title')).toHaveText(path.basename(project));
  await expect(page.locator('.scene', { hasText: 'scene-001' })).toBeVisible();
}

test('asks for a change, reviews the diff, and reverts the turn', async ({ page }) => {
  await openProject(page);
  await page.locator('#prompt').fill('把镜头提示词改成 after');
  await page.locator('#send').click();
  await expect(page.locator('#messages')).toContainText('已把镜头提示词改好');
  // 一轮结束后过程折叠起来；展开能看到工具行。
  await expect(page.locator('.shell.done')).toBeVisible();
  await page.locator('.shell.done > summary').click();
  await expect(page.locator('.tool', { hasText: '创建' })).toBeVisible();
  const card = page.locator('.turn-card');
  await expect(card).toContainText('scenes/scene-001/prompt.md');
  await expect.poll(() => fs.readFile(promptFile, 'utf8')).toBe('after\n');

  await card.locator('button', { hasText: 'scenes/scene-001/prompt.md' }).click();
  await expect(page.locator('#diff .del')).toContainText('before');
  await expect(page.locator('#diff .add')).toContainText('after');
  await page.locator('[aria-label="关闭"]').last().click();

  await page.locator('#revert-turn').click();
  await expect(card).toContainText('已回退这一轮');
  await expect.poll(() => fs.readFile(promptFile, 'utf8')).toBe('before\n');

  // 刷新后会话从项目里的事件记录恢复。
  await page.reload();
  await expect(page.locator('#messages')).toContainText('已把镜头提示词改好');
  await expect(page.locator('.turn-card')).toContainText('已回退这一轮');
});

test('starts production and can stop a running turn', async ({ page }) => {
  await openProject(page);
  await page.locator('#start-production').click();
  await expect(page.locator('#messages')).toContainText('开始整片制作');
  await expect(page.locator('.done-line').last()).toContainText('已完成');
  await expect(page.locator('#session-title')).toContainText('整片制作');

  await page.locator('#prompt').fill('慢慢来，先别动');
  await page.locator('#send').click();
  await expect(page.locator('#cancel-turn')).toBeVisible();
  await page.locator('#cancel-turn').click();
  await expect(page.locator('.pause-line')).toContainText('已停止');
  await expect(page.locator('#send')).toBeVisible();
});

test('opens a project file from the tree', async ({ page }) => {
  await openProject(page);
  await page.locator('.tree-file', { hasText: 'PROMPT.md' }).click();
  await expect(page.locator('#file-content')).toContainText('整片制作提示词');
});

test('picks the orchestrator and renderer per session', async ({ page }) => {
  await openProject(page);
  await expect(page.locator('#agent-tool')).toHaveValue('claude');
  await expect(page.locator('#agent-tool option[value="claude"]')).toContainText('默认');

  // 新对话：选的渲染工具在建会话时带上。
  await page.locator('#agent-renderer').selectOption('codex');
  await page.locator('#prompt').fill('把镜头提示词改成 after');
  await page.locator('#send').click();
  await expect(page.locator('.done-line').last()).toContainText('已完成');
  const sessions = await (await page.request.get('/api/sessions')).json();
  expect(sessions.sessions[0]).toMatchObject({ tool: 'claude', renderer: 'codex' });

  // 已有会话：换编排工具从下一轮起生效，并在对话里留一条提示。
  await page.locator('#agent-tool').selectOption('codex');
  await expect(page.locator('#messages')).toContainText('编排工具改为 codex');
  await expect(page.locator('#agent-tool')).toHaveValue('codex');
});

test('uploads a file, answers with a choice button, and queues a message mid-turn', async ({ page }) => {
  await openProject(page);
  await page.locator('.composer input[type="file"]').setInputFiles({
    name: '文章.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 标题\n正文'),
  });
  await expect(page.locator('#attachments')).toContainText('文章.md');

  await page.locator('#prompt').fill('给我选项');
  await page.locator('#send').click();
  // 待办清单进了这一轮的过程：进行中的那一步插一行小标题。
  await expect(page.locator('.step-row')).toContainText('正在定风格');
  const choice = page.locator('.choice', { hasText: '白板手绘风' });
  await expect(choice).toBeVisible();
  await expect(page.locator('.message.assistant').last()).not.toContainText('```');

  // 点选项就是把这一行发出去；之后选项消失。
  await choice.click();
  await expect(page.locator('.message.user').last()).toContainText('白板手绘风');
  await expect(page.locator('.done-line').last()).toContainText('已完成');
  await expect(page.locator('.choice').first()).toBeDisabled();

  // 进行中再发一条：先显示排队中，这一轮结束后自动发出。
  await page.locator('#prompt').fill('稍等，先改提示词');
  await page.locator('#send').click();
  await expect(page.locator('#cancel-turn')).toBeVisible();
  await page.locator('#prompt').fill('这条不要了');
  await page.locator('#send').click();
  await page.locator('#prompt').fill('顺便检查一下');
  await page.locator('#send').click();
  await expect(page.locator('.queue-card')).toHaveCount(2);
  // 移除一条：只剩一条排队。
  await page.locator('.queue-stack').hover();
  await page.locator('.queue-card', { hasText: '这条不要了' }).getByRole('button', { name: '移除' }).click();
  await expect(page.locator('.queue-card')).toHaveCount(1);
  await expect(page.locator('.message.user', { hasText: '顺便检查一下' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.queue-card')).toHaveCount(0);
  await expect(page.locator('.message.user', { hasText: '这条不要了' })).toHaveCount(0);
});

test('sends a scene quick action to the orchestrator', async ({ page }) => {
  await openProject(page);
  await page.locator('.quick-actions button', { hasText: '重做这个镜头' }).click();
  await expect(page.locator('.message.user').last()).toContainText('重做镜头 scene-001');
  await expect(page.locator('.done-line').last()).toContainText('已完成');
});

test('starts a new video from the home page', async ({ page }) => {
  // 先打开一个项目，让「保存到」默认落在测试用的临时目录旁边，再回到首页。
  await openProject(page);
  await page.locator('.brand').click();
  await expect(page.locator('.home-hero h1')).toContainText('今天想做一条');
  await expect(page.locator('.rail-row', { hasText: path.basename(project) })).toBeVisible();

  await page.locator('.template-card', { hasText: '横屏讲解' }).click();
  await expect(page.locator('#home-canvas')).toContainText('16:9');
  await page.locator('#home-prompt').fill('首页端到端测试，讲讲复利');
  await page.locator('#home-send').click();

  // 建好项目、开始制作后直接进到新项目，对话里是整片制作这一轮。
  await expect(page.locator('#title')).toContainText('首页端到端测试');
  await expect(page.locator('#session-title')).toContainText('整片制作');
  await expect(page.locator('.message.user').first()).toContainText('首页端到端测试，讲讲复利');
  const projects = await (await page.request.get('/api/projects')).json();
  const created = projects.projects.find((p) => p.name.startsWith('首页端到端测试'));
  expect(created).toBeTruthy();
  await expect.poll(async () => (await fs.readFile(path.join(created.path, 'frame.md'), 'utf8')).includes('1920')).toBe(true);
  await fs.rm(created.path, { recursive: true, force: true });
});
