import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { marshal } from '../gojson';
import { fetchQoderModels, qoderModelOptions, qoderStateDir, readQoderDescriptions } from './qodermodels';

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-qoder-models-'));
  temps.push(dir);
  return dir;
}

// 1.1.89 的守护进程实际报回的几项（字段原样，删掉了没用到的）。
const reported = [
  { value: 'auto', displayName: 'Auto', description: '', isDefault: true, isEnabled: true, priceFactor: 0.5, availableContextWindows: [200000, 400000, 1000000], defaultContextWindow: 200000 },
  {
    value: 'smodel', displayName: 'Sonus', description: '', isEnabled: true, isFree: false, priceFactor: 8,
    efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high', supportsDisabled: true,
    availableContextWindows: [400000, 200000, 1000000], defaultContextWindow: 200000,
  },
  { value: 'efficient', displayName: 'Efficient', description: '', isEnabled: true, isFree: true, priceFactor: 0, originalPriceFactor: 0.3, availableContextWindows: [200000] },
  {
    value: 'ultimate', displayName: 'Ultimate', description: '', isEnabled: true, priceFactor: 2, efforts: ['high'],
    promotion: { active: true, badge: { en: 'Off-Peak 80% off', zh: '错峰2折' }, before_promotion_price_factor: 2 },
  },
  { value: 'gone', displayName: 'Gone', isEnabled: false, priceFactor: 1 },
];

describe('qoder models', () => {
  it('turns the daemon model table into options', () => {
    const options = qoderModelOptions(reported, new Map([['smodel', '尝鲜体验全球顶级模型']]));
    expect(options.map((o) => o.id)).toEqual(['Auto', 'Sonus', 'Efficient', 'Ultimate']);
    expect(options[0]).toMatchObject({ key: 'auto', credit: 0.5, isDefault: true, contextWindows: [200000, 400000, 1000000], defaultContextWindow: 200000 });
    // 推理档位按从低到高排，支持不推理时加上 none；上下文长度从小到大。
    expect(options[1]).toMatchObject({ description: '尝鲜体验全球顶级模型', credit: 8, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', contextWindows: [200000, 400000, 1000000] });
    expect(options[2]).toMatchObject({ free: true, credit: 0, creditBefore: 0.3, efforts: [] });
    // 活动没让倍率变低时不划原价，但写出活动。
    expect(options[3]).toMatchObject({ credit: 2, promotion: '错峰2折' });
    expect(options[3]!.creditBefore).toBeUndefined();
  });

  it('reads model descriptions from the synced text file', () => {
    const state = tempDir();
    fs.mkdirSync(path.join(state, '.auth'));
    fs.writeFileSync(
      path.join(state, '.auth', 'dynamic-texts.json'),
      marshal({
        locales: {
          en: { 'modelSelector.item.smodel.markdownDescription': 'Built for the hardest work.', 'modelSelector.item.fast.markdownDescription': 'Fast responses.' },
          'zh-CN': {
            'modelSelector.item.smodel.markdownDescription': '专为最艰巨的任务而生。',
            'modelSelector.item.efficient.markdownDescription': '高性价比。限时免费畅用，[查看详情](https://docs.qoder.com/x)',
            'modelSelector.item.smodel.teams.markdownDescription': '团队版',
          },
        },
      }),
    );
    const descriptions = readQoderDescriptions(state);
    expect(descriptions.get('smodel')).toBe('专为最艰巨的任务而生。');
    expect(descriptions.get('fast')).toBe('Fast responses.');
    // 点不了的链接连文字一起去掉。
    expect(descriptions.get('efficient')).toBe('高性价比。限时免费畅用');
    expect(readQoderDescriptions(path.join(state, 'missing')).size).toBe(0);
    expect(qoderStateDir('qoder-intl', '/h')).toBe(path.join('/h', '.qoder'));
    expect(qoderStateDir('qoder', '/h')).toBe(path.join('/h', '.qoder-cn'));
  });

  // 假的 qodercli --sdk：按真实的三步握手回应，记下收到的请求。
  it.skipIf(process.platform === 'win32')('asks the sdk daemon for the model table without a prompt', async () => {
    const dir = tempDir();
    const log = path.join(dir, 'requests.jsonl');
    const script = path.join(dir, 'fake.mjs');
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';
import readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const f = JSON.parse(line);
  fs.appendFileSync(${marshal(log)}, line + '\\n');
  const r = f.request;
  if (r.subtype === 'daemon.initialize') out({ type: 'control_response', response: { subtype: 'success', request_id: f.request_id, response: {} } });
  else if (r.subtype === 'daemon.open_session') {
    if (!r.worker_args?.length) out({ type: 'control_response', response: { subtype: 'error', request_id: f.request_id, error: 'worker_args must not be empty', code: 'INVALID_WORKER_ARGS' } });
    else out({ type: 'control_response', session_id: 'S1', response: { subtype: 'success', request_id: f.request_id } });
  } else if (r.subtype === 'initialize' && f.session_id === 'S1') {
    out({ type: 'system', subtype: 'init' });
    out({ type: 'control_response', session_id: 'S1', response: { subtype: 'success', request_id: f.request_id, response: { models: ${marshal(reported)} } } });
  } else if (r.subtype === 'user') process.exit(9);
}
`,
    );
    const bin = path.join(dir, 'qodercli');
    fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
    const models = await fetchQoderModels('qoder-intl', bin, { PATH: process.env.PATH ?? '', HOME: dir }, undefined, 10_000);
    expect(models.map((m) => m.id)).toEqual(['Auto', 'Sonus', 'Efficient', 'Ultimate']);
    const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(requests.map((r) => r.request.subtype)).toEqual(['daemon.initialize', 'daemon.open_session', 'initialize']);
    // 沿用命令行已经登录的账号；不发任何提示词。
    expect(requests[0].request).toMatchObject({ daemon_protocol_version: 2, capabilities: ['multi_session_v2'], auth: { type: 'qodercli' } });
    expect(requests[2].session_id).toBe('S1');
  });

  it.skipIf(process.platform === 'win32')('reports a daemon that never answers', async () => {
    const dir = tempDir();
    const bin = path.join(dir, 'qodercli');
    fs.writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    await expect(fetchQoderModels('qoder-intl', bin, { PATH: process.env.PATH ?? '' }, undefined, 500)).rejects.toThrow('没有给出模型表');
  });

  it.skipIf(process.platform === 'win32')('rejects instead of crashing when the daemon exits before reading', async () => {
    const dir = tempDir();
    const bin = path.join(dir, 'qodercli');
    // 守护进程已经不读了（关掉 stdin）却还回了第一步：插件接着写第二步，写进已关闭的管道就是 EPIPE。
    fs.writeFileSync(bin, '#!/bin/sh\nexec 0<&-\nsleep 0.2\necho \'{"type":"control_response","response":{"request_id":"onset-daemon"}}\'\nsleep 0.5\nexit 2\n', { mode: 0o755 });
    await expect(fetchQoderModels('qoder-intl', bin, { PATH: process.env.PATH ?? '' }, undefined, 5000)).rejects.toThrow('提前退出');
  });
});
