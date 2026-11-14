import { describe, expect, it } from 'vitest';
import { operationBroker, relayOperation } from './broker';

describe('local operation broker', () => {
  const request = { name: 'scene_run', params: { scene: 'scenes/镜头一' }, cwd: process.cwd(), renderer: 'director', rendererModel: '', orchestrator: 'codex' };

  it('relays operation parameters, Unicode output and exit status without model credentials', async () => {
    const seen: unknown[] = [];
    const broker = operationBroker(async (input, _signal, write) => {
      seen.push(input);
      write('制作人正在渲染镜头一\n');
      write('视频已生成\n');
      return 0;
    });
    let output = '';
    try {
      expect(await relayOperation(broker.address, request, text => output += text)).toBe(0);
      expect(seen).toEqual([request]);
      expect(output).toBe('制作人正在渲染镜头一\n视频已生成\n');
    } finally { broker.close(); }
  });

  it('propagates execution errors and cancels the server operation on disconnect', async () => {
    const failed = operationBroker(async () => { throw new Error('没有配置模型服务'); });
    try { await expect(relayOperation(failed.address, request, () => {})).rejects.toThrow('没有配置模型服务'); }
    finally { failed.close(); }
    let cancelled = false;
    const broker = operationBroker(async (_input, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
      return 130;
    });
    const controller = new AbortController();
    try {
      const running = relayOperation(broker.address, request, () => {}, controller.signal);
      setTimeout(() => controller.abort(), 50);
      await expect(running).rejects.toThrow('操作已取消');
      await expect.poll(() => cancelled).toBe(true);
    } finally { broker.close(); }
  });
});
