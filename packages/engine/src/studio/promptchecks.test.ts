import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import * as promptopt from '../promptopt';
import { startStudio, studioRequest, tempDir, writeTree } from './testsupport';

// 检查之后 prompt.md 被人改过：改写稿是对着旧稿写的，接口照实回 409，不起写任务、不动 prompt.md。
it('refuses to apply a rewrite once prompt.md changed after the check', async () => {
  const dir = tempDir();
  writeTree(dir, {
    'onset.conf': 'ORCHESTRATOR=claude\nRENDERER=claude\n',
    'onset.flow.json': '{"version": 1, "production": {"id": "speech", "canvas": "vertical-3x4"}}\n',
    'scenes/scene-001/scene.json': '{"id":"scene-001","duration_seconds":1,"output":"out.mp4"}',
    'scenes/scene-001/prompt.md': 'before\n',
  });
  const s = startStudio({ projectPath: dir, configPath: path.join(tempDir(), 'projects.json') });
  const root = s.currentProject().path;
  const scores = Object.fromEntries(promptopt.Dimensions.map((d) => [d, 3])) as promptopt.PromptCheck['scores'];
  promptopt.writeCheck(root, {
    scene: 'scene-001', dir: 'scenes/scene-001', base_sha256: promptopt.sha256('before\n'), checked_at: '', tool: 'claude', model: '',
    scores, issues: [], decision: 'minor', prompt: 'before\n门在画面中央，缓缓推开。\n',
  });
  const promptFile = path.join(root, 'scenes', 'scene-001', 'prompt.md');
  fs.writeFileSync(promptFile, '手改过\n');

  const { status, body } = await studioRequest(s, 'POST', '/api/prompt-checks/scene-001/apply');
  expect(status).toBe(409);
  expect(body.code).toBe('outdated');
  expect(fs.readFileSync(promptFile, 'utf8')).toBe('手改过\n');
  // 草稿留着，界面据此说「检查之后改过了」。
  expect(promptopt.readCheck(root, 'scene-001')).not.toBeNull();
});
