import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { requireReviewTarget, requireSilentMaster } from './deliverables';

function dir(flowRecord: boolean): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-deliverables-')));
  if (flowRecord) fs.writeFileSync(path.join(root, 'onset.flow.json'), '{"version": 1, "production": {"id": "speech", "canvas": "landscape-16x9"}}\n');
  return root;
}

// 客户端按固定位置找母版与成片：2026-11 qoder 编排写成 master-silent.mp4 / master-mixed.mp4，客户端显示「没有成片」。
describe('deliverable paths', () => {
  it('a project only takes the silent master and the films where the client looks for them', () => {
    const root = dir(true);
    expect(() => requireSilentMaster(root, path.join(root, 'production/silent-master.mp4'))).not.toThrow();
    expect(() => requireSilentMaster(root, path.join(root, 'production/master-silent.mp4'))).toThrow('production/silent-master.mp4');
    for (const ok of ['production/audio/candidate.mp4', 'final.mp4', 'production/final.mp4']) {
      expect(() => requireReviewTarget(root, path.join(root, ok), false), ok).not.toThrow();
    }
    expect(() => requireReviewTarget(root, path.join(root, 'production/master-mixed.mp4'), false)).toThrow('production/audio/candidate.mp4');
    expect(() => requireReviewTarget(root, path.join(root, 'production/silent-master.mp4'), true)).not.toThrow();
    expect(() => requireReviewTarget(root, path.join(root, 'production/audio/candidate.mp4'), true)).toThrow('静音复查');
  });

  it('relative paths are read from the current directory, the way the tools get them', () => {
    const root = dir(true);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(() => requireSilentMaster('.', 'production/silent-master.mp4')).not.toThrow();
      expect(() => requireReviewTarget('.', 'production/master-mixed.mp4', false)).toThrow();
    } finally {
      process.chdir(cwd);
    }
  });

  it('outside a project nothing is restricted', () => {
    const root = dir(false);
    expect(() => requireSilentMaster(root, path.join(root, 'master.mp4'))).not.toThrow();
    expect(() => requireReviewTarget(root, path.join(root, 'anything.mp4'), false)).not.toThrow();
  });
});
