import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openProject, openPage } from './fixtures.mjs';

test('shows live activity for every blind audition contestant and updates without reopening', async ({ page, project }) => {
  const id = 'audition-20261117-085722';
  const root = path.join(project.path, 'production/studio/auditions', id);
  const entries = [
    ['A', 'mcp__onset__hyperframes', { subcommand: 'render' }],
    ['B', 'Read', { file_path: 'secret-model/scene.json' }],
    ['C', 'Write', { file_path: 'index.html', content: 'secret-model' }],
    ['D', 'Read', { file_path: 'prompt.md' }],
    ['E', 'Read', { file_path: 'scene.json' }],
    ['F', 'Read', { file_path: 'scene.json' }],
  ];
  const contestants = entries.map(([slot, name, input]) => {
    const dir = path.join(root, slot);
    fs.mkdirSync(dir, { recursive: true });
    const events = [{ type: 'system', subtype: 'init', model: 'secret-model' }, { type: 'assistant', message: { content: [{ type: 'tool_use', id: slot, name, input }] } }];
    if (slot === 'D') events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: slot, content: 'ok' }] } });
    if (slot === 'E') events.push({ type: 'result', is_error: true, errors: ['Empty stream: upstream ended the turn with finish_reason=error secret-model'] });
    fs.writeFileSync(path.join(dir, 'render-scene-001.stream.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'render-scene-001.live.json'), JSON.stringify({ pid: process.pid, renderer: 'claude', started_at: new Date().toISOString() }));
    return { slot, renderer: 'claude', model: 'secret-model', workdir: path.relative(project.path, dir), status: slot === 'E' ? 'done' : slot === 'F' ? 'pending' : 'running', outcome: slot === 'E' ? 'failed' : '', error: slot === 'E' ? '渲染结束但产物不存在：output.mp4' : '', output: '' };
  });
  fs.writeFileSync(path.join(root, 'audition.json'), JSON.stringify({ id, scene_id: 'scene-001', scene_dir: 'scenes/scene-001', created_at: new Date().toISOString(), contestants, verdict: null }));
  await openProject(page, project);
  await openPage(page, 'audition');
  const progress = slot => page.getByRole('status', { name: `选手 ${slot} 的制作进度` });
  for (const [slot, text] of [['A', '取帧与编码'], ['B', '读取素材与制作说明'], ['C', '编写画面与动画'], ['D', '等待模型响应'], ['E', '模型服务异常结束'], ['F', '等待上场']]) {
    await expect(progress(slot)).toContainText(text);
  }
  await expect(page.locator('.audition')).not.toContainText('secret-model');
  await expect(page.locator('.audition-card[data-slot="E"]')).toContainText('本次模型响应未完成，可以重试');
  const card = page.locator('.audition-card[data-slot="A"]');
  await card.locator('.audition-process summary').click();
  await expect(card.locator('.audition-process li')).toHaveCount(1);
  fs.appendFileSync(path.join(root, 'A/render-scene-001.stream.jsonl'), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'A', content: 'rendered' }] } }) + '\n');
  await expect(progress('A')).toContainText('等待模型响应');
  await expect(card.locator('.audition-process')).toHaveAttribute('open', '');
  await page.screenshot({ path: test.info().outputPath('audition-activity.png'), animations: 'disabled' });

  const retry = page.getByRole('button', { name: '重试 E', exact: true });
  await expect(retry).toBeDisabled();
  // 模拟整场任务结束，只 E 失败；真实点击重试，经写任务启动 CLI。
  for (const c of contestants) {
    fs.rmSync(path.join(root, c.slot, 'render-scene-001.live.json'));
    c.status = 'done';
    c.outcome = c.slot === 'E' ? 'failed' : 'succeeded';
  }
  fs.writeFileSync(path.join(root, 'audition.json'), JSON.stringify({ id, scene_id: 'scene-001', scene_dir: 'scenes/scene-001', created_at: new Date().toISOString(), contestants, verdict: null }));
  await expect(retry).toBeEnabled();
  await retry.click();
  // 本用例没有制作输入，重试会在调用模型前失败；失败后要能再次重试。
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/tasks')).json()).tasks.some(t => t.type === 'scene.audition_retry' && t.status === 'failed'))).toBe(true);
  await expect(retry).toBeEnabled();
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'audition.json'), 'utf8'));
  expect(saved.contestants.find(c => c.slot === 'E').error).not.toBe('');
  expect(saved.contestants.filter(c => c.slot !== 'E').every(c => c.outcome === 'succeeded')).toBe(true);
  await expect(page.locator('.audition')).not.toContainText('secret-model');
  await page.screenshot({ path: test.info().outputPath('audition-retry.png'), animations: 'disabled' });
});
