import fs from 'node:fs';
import path from 'node:path';
import {test, expect, openProject} from './fixtures.mjs';

test('shows phases, independent waiting states and elapsed times in one render board', async ({page, project, electronApp}) => {
  await electronApp.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => w.isResizable()).setSize(1440, 1000));
  const call = (id, tool, args, done = false) => ({type: done ? 'item.completed' : 'item.started', item: {
    id, type: 'mcp_tool_call', server: 'onset', tool, arguments: args,
    ...(done ? {status: 'completed', result: {content: [{type: 'text', text: 'done'}]}, error: null} : {}),
  }});
  const edit = {type: 'item.completed', item: {id: 'edit', type: 'file_change', status: 'completed', changes: [{path: 'scene.js', kind: 'update'}]}};
  const variants = [
    [edit],
    [call('check', 'hyperframes', {subcommand: 'check', args: ['--json']}, true)],
    [call('render', 'hyperframes', {subcommand: 'render'})],
    [call('check', 'hyperframes', {subcommand: 'check'})],
    [edit, {type: 'error', message: 'Reconnecting: tls handshake eof'}],
    [call('read', 'config_get', {key: 'FILM_STYLE'}, true)],
  ];
  for (let i = 0; i < variants.length; i++) {
    const id = `scene-${String(i + 1).padStart(3, '0')}`, dir = path.join(project.path, 'scenes', id);
    fs.mkdirSync(dir, {recursive: true});
    if (i > 0) {
      const base = JSON.parse(fs.readFileSync(path.join(project.path, 'scenes/scene-001/scene.json'), 'utf8'));
      fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify({...base, id}));
      fs.writeFileSync(path.join(dir, 'voice.srt'), '');
    }
    fs.writeFileSync(path.join(dir, `render-${id}.stream.jsonl`), [{type: 'thread.started', thread_id: id}, ...variants[i]].map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, `render-${id}.live.json`), JSON.stringify({pid: process.pid, renderer: 'codex', started_at: new Date(Date.now() - (180 + i * 24) * 1000).toISOString()}));
  }
  await openProject(page, project);
  const watch = page.locator('.render-watch');
  await expect(watch.locator('.render-card')).toHaveCount(6);
  await expect(watch.locator('.render-watch-count')).toHaveText('6 个进行中');
  const first = watch.locator('[data-render-scene="scene-001"]');
  await expect(first.locator('.ra-phase')).toHaveText('制作画面');
  await expect(first.locator('.ra-status')).toHaveText('等模型回复');
  await expect(first.locator('.ra-elapsed')).toContainText('累计');
  await expect(watch.locator('[data-render-scene="scene-002"] .ra-phase')).toHaveText('检查画面');
  await expect(watch.locator('[data-render-scene="scene-003"] .ra-phase')).toHaveText('生成视频');
  await expect(watch.locator('[data-render-scene="scene-005"] .ra-status')).toHaveText('正在重连');
  for (const id of ['scene-005', 'scene-006']) fs.unlinkSync(path.join(project.path, 'scenes', id, `render-${id}.live.json`));
  await expect(watch.locator('.render-watch-count')).toHaveText('4 个进行中');
  await expect(watch.locator('.render-card')).toHaveCount(4);
  await page.mouse.move(5, 5);
  await watch.screenshot({path: test.info().outputPath('render-board.png'), animations: 'disabled'});
  await page.screenshot({path: test.info().outputPath('render-board-wide.png'), animations: 'disabled'});
  await watch.getByRole('button', {name: '收起列表'}).click();
  await expect(first).not.toBeVisible();
  await watch.getByRole('button', {name: '展开列表'}).click();
  await expect(first).toBeVisible();
  await first.locator('.ra-head').click();
  await expect(first.locator('.ra-step')).toHaveCount(1);
  await first.locator('.ra-head').press('Space');
  await expect(first.locator('.ra-step')).toHaveCount(0);
  await electronApp.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => w.isResizable()).setSize(1024, 720));
  await expect(page.locator('#prompt')).toBeInViewport();
  const overflow = await watch.evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
  await page.screenshot({path: test.info().outputPath('render-board-compact.png'), animations: 'disabled'});
});
