import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultTTSProvider } from '../config';
import { newSessionFixture, setEnv, studioRequest, tempDir } from './testsupport';

describe('settings API', () => {
  it('shows each setting with its global value, the project value and where the effective one comes from', async () => {
    const file = path.join(tempDir(), 'settings.conf');
    setEnv('ONSET_SETTINGS_FILE', file);
    const f = newSessionFixture();
    fs.writeFileSync(path.join(f.root, 'onset.conf'), 'ORCHESTRATOR=claude\nRENDERER=claude\nSCENE_JOBS=5\n');
    let { status, body } = await studioRequest(f.s, 'GET', '/api/settings');
    expect(status).toBe(200);
    expect(body.has_project).toBe(true);
    const row = (key: string) => body.rows.find((r: { key: string }) => r.key === key);
    // 测试项目的 conf 写了 ORCHESTRATOR=claude，测试环境又设了 ORCHESTRATOR：环境变量压过项目，页面要说明是它在起作用。
    expect(row('ORCHESTRATOR')).toMatchObject({ label: '对话助手', project: 'claude', effective: 'claude', source: 'env' });
    expect(row('SCENE_JOBS')).toMatchObject({ project: '5', effective: '5', source: 'project' });
    expect(row('TTS_PROVIDER')).toMatchObject({ project: '', global: '', source: 'default', effective: defaultTTSProvider() });
    expect(row('TTS_PROVIDER').options.map((o: { value: string }) => o.value)).toContain('breeze');

    ({ status } = await studioRequest(f.s, 'POST', '/api/settings/global', JSON.stringify({ key: 'TTS_PROVIDER', value: 'breeze' })));
    expect(status).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toContain('TTS_PROVIDER=breeze');
    ({ body } = await studioRequest(f.s, 'GET', '/api/settings'));
    expect(row('TTS_PROVIDER')).toMatchObject({ global: 'breeze', effective: 'breeze', source: 'global' });

    // 不合法的值不写。
    ({ status } = await studioRequest(f.s, 'POST', '/api/settings/global', JSON.stringify({ key: 'RENDERER', value: 'gpt' })));
    expect(status).toBe(400);
    ({ status } = await studioRequest(f.s, 'POST', '/api/settings/project', JSON.stringify({ key: 'NOPE', value: 'x' })));
    expect(status).toBe(400);
  });
});
