import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GenerationLadderGuide,
  generateMedia,
  importAssetFile,
  importAssetToProject,
  listAssets,
  resumeMediaJob,
  retrySaveMediaJob,
  saveMediaProviderConfig,
  updateAsset,
} from './index';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-mediagen-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('mediagen asset library and gateway', () => {
  it('maintains immutable versions, soft trash and safe project copy', () => {
    const assetsRoot = tempDir();
    const src1 = path.join(tempDir(), 'hero.png');
    const src2 = path.join(tempDir(), 'hero-v2.png');
    fs.writeFileSync(src1, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
    fs.writeFileSync(src2, Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]));

    const v1 = importAssetFile(assetsRoot, { source_path: src1, name: '主视觉', request_id: 'imp-1' });
    const replay = importAssetFile(assetsRoot, { source_path: src1, name: '主视觉', request_id: 'imp-1' });
    expect(replay.replayed).toBe(true);
    expect(replay.asset.id).toBe(v1.asset.id);

    // 追加 v2 保留 v1
    const v2 = importAssetFile(assetsRoot, {
      source_path: src2,
      asset_id: v1.asset.id,
      parent_version_id: v1.version.version_id,
    });
    expect(v2.asset.versions).toHaveLength(2);
    expect(v2.asset.current_version_id).toBe(v2.version.version_id);

    // 切回 v1 不删 v2
    const switched = updateAsset(assetsRoot, v1.asset.id, { current_version_id: v1.version.version_id });
    expect(switched.versions).toHaveLength(2);

    // 按精确版本导入项目，重复导入同字节复用，不同内容拒绝覆盖
    const proj = tempDir();
    const c1 = importAssetToProject(
      assetsRoot,
      { asset_id: v1.asset.id, version_id: v1.version.version_id },
      proj,
      'hero.png',
    );
    expect(c1.reused).toBe(false);
    const c2 = importAssetToProject(
      assetsRoot,
      { asset_id: v1.asset.id, version_id: v1.version.version_id },
      proj,
      'hero.png',
    );
    expect(c2.reused).toBe(true);
    expect(() =>
      importAssetToProject(assetsRoot, { asset_id: v1.asset.id, version_id: v2.version.version_id }, proj, 'hero.png'),
    ).toThrow(/拒绝覆盖/);

    // 软删除隐藏但不销毁
    updateAsset(assetsRoot, v1.asset.id, { trashed: true });
    expect(listAssets(assetsRoot)).toHaveLength(0);
    expect(listAssets(assetsRoot, { includeTrashed: true })).toHaveLength(1);
    expect(GenerationLadderGuide).not.toMatch(/\bagent\b/i);
  });

  it('prevents duplicate billing, supports zero-cost retry_save and remote resume', async () => {
    const assetsRoot = tempDir();
    const configPath = path.join(tempDir(), 'media-providers.json');
    const env = { ONSET_MEDIA_CONFIG: configPath };
    saveMediaProviderConfig(
      { id: 'openai-compatible', enabled: true, api_key: 'sk-test', default_models: { image: 'gpt-image-1' } },
      env,
    );

    let calls = 0;
    const runner = async () => {
      calls++;
      return {
        outputs: [{ filename: 'bg.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]), mime_type: 'image/png' }],
      };
    };

    // 第一次生成 + 幂等重放不触发第二次调用
    const first = await generateMedia({
      request_id: 'gen-1',
      provider: 'openai-compatible',
      modality: 'image',
      prompt: '干净的科技底图',
      assets_root: assetsRoot,
      env,
      runner,
    });
    expect(first.job.status).toBe('completed');
    expect(first.job.saved_assets).toHaveLength(1);
    expect(calls).toBe(1);

    const dup = await generateMedia({
      request_id: 'gen-1',
      provider: 'openai-compatible',
      modality: 'image',
      prompt: '干净的科技底图',
      assets_root: assetsRoot,
      env,
      runner,
    });
    expect(dup.replayed).toBe(true);
    expect(calls).toBe(1);

    // 模拟第二阶段落库失败（目标项目已存在不同字节的冲突文件），然后清理冲突后用 retry_save 零付费抢救
    const proj = tempDir();
    // 让 project_root 指向一个普通文件制造落库目录异常
    const blocker = path.join(proj, 'not-a-dir');
    fs.writeFileSync(blocker, 'block');
    const saveFailed = await generateMedia({
      request_id: 'gen-2',
      provider: 'openai-compatible',
      modality: 'image',
      prompt: '海报底图',
      project_root: blocker,
      assets_root: assetsRoot,
      env,
      runner,
    });
    expect(saveFailed.job.status).toBe('save_failed');
    expect(saveFailed.job.save_pending).toBe(true);
    expect(calls).toBe(2);

    fs.rmSync(blocker);
    fs.mkdirSync(blocker, { recursive: true });
    const rescued = retrySaveMediaJob(assetsRoot, saveFailed.job.id);
    expect(rescued.status).toBe('completed');
    expect(rescued.save_pending).toBe(false);
    expect(calls).toBe(2); // 零额外模型请求

    // 模拟远端超时中断后携带 remote_id，用 resume 续查完成
    const failedRemote = await generateMedia({
      request_id: 'gen-3',
      provider: 'openai-compatible',
      modality: 'image',
      prompt: '远端异步任务',
      assets_root: assetsRoot,
      env,
      runner: async () => {
        const err = Object.assign(new Error('轮询超时'), { remoteId: 'rem-999' });
        throw err;
      },
    });
    expect(failedRemote.job.status).toBe('failed');
    expect(failedRemote.job.remote_id).toBe('rem-999');

    const resumed = await resumeMediaJob(assetsRoot, failedRemote.job.id, async () => ({
      outputs: [{ filename: 'done.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]), mime_type: 'image/png' }],
    }));
    expect(resumed.status).toBe('completed');
    expect(resumed.saved_assets).toHaveLength(1);
  });
});
