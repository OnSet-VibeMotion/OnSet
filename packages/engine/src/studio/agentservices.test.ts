import './testsupport';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import * as director from '../director';
import { newSessionFixture, setEnv, studioRequest } from './testsupport';

// 表单里「读取模型列表」：key 留空、给了 id 时，后端用那套服务存下的 key 去问。
// 界面那一侧只在组件测试里用假后端，这条回退要在这里经过真实的路由核对。
it('lists models with the stored key when the form leaves the key empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-agent-services-test-'));
  setEnv('ONSET_AGENT_DIR', dir);
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ''));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  try {
    const id = director.saveService(dir, { name: '本机', protocol: 'openai', base_url: base, model: 'model-a', vision: false, key: 'sk-stored' });
    const f = newSessionFixture();
    const { status, body } = await studioRequest(f.s, 'POST', '/api/agent-services/models', JSON.stringify({ protocol: 'openai', base_url: base, key: '', id }));
    expect(status).toBe(200);
    expect(body.models).toEqual(['model-a', 'model-b']);
    expect(seen).toEqual(['Bearer sk-stored']);
    // 回传里没有 key。
    expect(JSON.stringify(body)).not.toContain('sk-stored');
  } finally {
    server.close();
  }
});
