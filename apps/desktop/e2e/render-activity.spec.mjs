import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject } from './fixtures.mjs';

// 渲染器在另一个进程里跑，对话只能等：有镜头在渲染时，输入框上方显示它此刻在做什么，镜头页里能看完整过程。

const lines = [
  { type: 'system', subtype: 'init', session_id: 'r', model: 'claude-test' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'SCENE_DIR/scene.json' } }] }, session_id: 'r' },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] }, session_id: 'r' },
  { type: 'assistant', message: { content: [{ type: 'text', text: '[[USER_MESSAGE]]画面排好了，开始渲染' }] }, session_id: 'r' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__onset__hyperframes', input: { subcommand: 'render', args: ['--output', 'out.mp4'] } }] }, session_id: 'r' },
];

test('shows what the renderer is doing while a scene renders', async ({ page, project }) => {
  const sceneDir = path.join(project.path, 'scenes', 'scene-001');
  const stream = lines.map((line) => JSON.stringify(line).replaceAll('SCENE_DIR', sceneDir)).join('\n') + '\n';
  fs.writeFileSync(path.join(sceneDir, 'render-scene-001.stream.jsonl'), stream);
  // 进行中标记指向一个活着的进程：测试进程自己。
  fs.writeFileSync(
    path.join(sceneDir, 'render-scene-001.live.json'),
    JSON.stringify({ pid: process.pid, renderer: 'claude', started_at: new Date(Date.now() - 95_000).toISOString() }),
  );
  await openProject(page, project);

  const card = page.locator('.render-card[data-render-scene="scene-001"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.ra-current')).toHaveText('正在渲染视频：--output out.mp4');
  await expect(card.locator('.ra-elapsed')).toContainText('1m');
  await card.locator('.ra-head').click();
  await expect(card.locator('.ra-step')).toHaveCount(3);
  await expect(card.locator('.ra-step').first()).toContainText('读取');
  await expect(card.locator('.ra-step').first()).toContainText('scene.json');
  await expect(card.locator('.ra-step.to-user')).toContainText('画面排好了，开始渲染');
  await page.screenshot({ path: test.info().outputPath('render-card.png'), animations: 'disabled' });

  // 镜头页：同一份过程。
  await card.getByRole('button', { name: '打开镜头' }).click();
  const panel = page.locator('#panel .scene-activity');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.ra-step')).toHaveCount(3);

  // 渲染中面板不跳：一条很长的命令不把面板撑宽，新步骤进来时面板与镜头标题的位置、大小都不变。
  const box = async () => {
    const [p, t] = await Promise.all([panel.boundingBox(), page.locator('#panel .scene-title').boundingBox()]);
    return { x: p.x, y: p.y, width: p.width, height: p.height, titleY: t.y };
  };
  // 面板刚打开还在滑入：先等它的滑入动画跑完（转圈这类循环动画除外；隐藏窗口里动画时快时慢，只比两次位置会在半路停顿时误判稳定），再等位置稳定下来量。
  await page.locator('#panel').evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
  // 动画跑完后再隔开取样、连续几次都一样才算停住。
  let before = await box();
  let steady = 0;
  await expect
    .poll(
      async () => {
        const now = await box();
        steady = JSON.stringify(now) === JSON.stringify(before) ? steady + 1 : 0;
        before = now;
        return steady;
      },
      { intervals: [150] },
    )
    .toBeGreaterThanOrEqual(4);
  const info = await page.locator('#panel .scene-info').boundingBox();
  expect(before.width).toBeLessThanOrEqual(info.width + 1);
  const long = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: `cd ${sceneDir} && shasum -a 256 ` + 'scenes/scene-001/very-long-file-name-'.repeat(12) } }] }, session_id: 'r' };
  const say = { type: 'assistant', message: { content: [{ type: 'text', text: '第一行\n第二行\n第三行' }] }, session_id: 'r' };
  fs.appendFileSync(path.join(sceneDir, 'render-scene-001.stream.jsonl'), JSON.stringify(long) + '\n' + JSON.stringify(say) + '\n');
  await expect(panel.locator('.ra-step')).toHaveCount(5);
  // 渲染器每条命令前的 cd 不占那一行：看得见真正跑的命令。
  await expect(panel.locator('.ra-step').nth(3).locator('.ra-target')).toHaveText(/^shasum -a 256 /);
  expect(await box()).toEqual(before);

  // 渲染结束（标记删掉、写下尝试记录）：卡片消失，镜头页改成「上次渲染的过程」。
  fs.rmSync(path.join(sceneDir, 'render-scene-001.live.json'));
  fs.writeFileSync(
    path.join(sceneDir, 'render-scene-001.attempt.json'),
    JSON.stringify({ schema: 1, scene_id: 'scene-001', renderer: 'claude', outcome: 'succeeded', started_at: '2026-11-09T00:00:00Z', ended_at: '2026-11-09T00:02:00Z' }),
  );
  await expect(panel.locator('.ra-title')).toHaveText('上次渲染的过程', { timeout: 6000 });
  await expect(panel.locator('.ra-outcome')).toHaveText('成功');
});
