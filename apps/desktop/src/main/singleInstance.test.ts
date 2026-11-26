import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureExplicitRelaunchEnv,
  currentInstanceIdentity,
  decideSecondInstance,
  decorateStaleStartError,
  type InstanceIdentity,
  isBundleStaleOnDisk,
  isSameInstanceBuild,
  parseIncomingIdentity,
  readBundleSignature,
  sanitizeRelaunchEnv,
} from './singleInstance';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-single-'));
  temps.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function makeIdentity(overrides: Partial<InstanceIdentity> = {}): InstanceIdentity {
  return {
    execPath: '/Applications/片场.app/Contents/MacOS/片场',
    appPath: '/Applications/片场.app/Contents/Resources/app.asar',
    bundlePath: '/Applications/片场.app/Contents/Resources/app.asar',
    version: '2.1.0',
    packaged: true,
    bundleSignature: '100:4609503:1795669036000',
    relaunchArgs: [],
    ...overrides,
  };
}

describe('singleInstance', () => {
  it('focuses the current window when the same build is activated again', () => {
    const self = makeIdentity();
    const decision = decideSecondInstance({
      self,
      incoming: makeIdentity(),
      onDiskSignature: self.bundleSignature,
      activeWork: [],
      background: false,
    });
    expect(decision).toEqual({ kind: 'focus' });
    expect(isSameInstanceBuild(self, makeIdentity())).toBe(true);
  });

  it('switches automatically when a different app path is launched and backend is idle', () => {
    const self = makeIdentity({
      execPath: '/Users/dev/repo/apps/desktop/release/mac-arm64/片场.app/Contents/MacOS/片场',
      appPath: '/Users/dev/repo/apps/desktop/release/mac-arm64/片场.app/Contents/Resources/app.asar',
      bundlePath: '/Users/dev/repo/apps/desktop/release/mac-arm64/片场.app/Contents/Resources/app.asar',
      bundleSignature: '185506940:4402611:1795560121000',
    });
    const incoming = makeIdentity();
    const decision = decideSecondInstance({
      self,
      incoming,
      onDiskSignature: '186005114:4600000:1795583373000',
      activeWork: [],
      background: false,
    });
    expect(decision).toEqual({
      kind: 'switch',
      target: { execPath: incoming.execPath, args: [] },
      reason: '你刚打开了另一路径的片场客户端',
    });
  });

  it('prompts before switching when active work is running', () => {
    const self = makeIdentity({ bundleSignature: '100:4402611:1795560121000' });
    const incoming = makeIdentity({ bundleSignature: '200:4609503:1795669036000' });
    const decision = decideSecondInstance({
      self,
      incoming,
      onDiskSignature: incoming.bundleSignature,
      activeWork: [{ project: '/tmp/演示项目', holder: '整片制作' }],
      background: false,
    });
    expect(decision).toEqual({
      kind: 'confirm_switch',
      target: { execPath: incoming.execPath, args: [] },
      reason: '磁盘上的片场客户端已更新或重新构建',
      busy: ['演示项目：整片制作'],
    });
  });

  it('restarts stale instance even when an older launcher sends no additionalData', () => {
    const self = makeIdentity({ bundleSignature: '185506940:4402611:1795560121000' });
    const decision = decideSecondInstance({
      self,
      incoming: null,
      onDiskSignature: '186005114:4609503:1795583373000',
      activeWork: [],
      background: false,
    });
    expect(decision).toEqual({
      kind: 'switch',
      target: { execPath: self.execPath, args: [] },
      reason: '磁盘上的片场客户端文件已被替换，当前窗口仍停留在更新前的旧进程',
    });
  });

  it('never switches or blocks in background e2e mode', () => {
    const self = makeIdentity({ bundleSignature: 'old' });
    const incoming = makeIdentity({ bundleSignature: 'new' });
    expect(
      decideSecondInstance({
        self,
        incoming,
        onDiskSignature: 'new',
        activeWork: [],
        background: true,
      }),
    ).toEqual({ kind: 'focus' });
  });

  it('detects on-disk bundle replacement when the file is atomically replaced', () => {
    const file = tempFile('app.asar', 'old-bundle');
    const identity = currentInstanceIdentity({
      execPath: process.execPath,
      appPath: file,
      version: '2.1.0',
      packaged: true,
      mainFile: file,
    });
    expect(identity.bundleSignature).not.toBe('');
    expect(isBundleStaleOnDisk(identity)).toBe(false);

    const replacement = `${file}.new`;
    fs.writeFileSync(replacement, 'new-bundle-content-with-motion-menu', 'utf8');
    fs.renameSync(replacement, file);
    expect(readBundleSignature(file)).not.toBe(identity.bundleSignature);
    expect(isBundleStaleOnDisk(identity)).toBe(true);
  });

  it('validates additionalData shape strictly and preserves dev relaunch args', () => {
    expect(parseIncomingIdentity(null)).toBeNull();
    expect(parseIncomingIdentity({ execPath: '/a' })).toBeNull();
    const dev = currentInstanceIdentity({
      execPath: process.execPath,
      appPath: path.dirname(tempFile('main.js', 'console.log(1)')),
      version: '2.1.0',
      packaged: false,
      mainFile: tempFile('entry.js', 'console.log(2)'),
    });
    expect(dev.relaunchArgs).toEqual([dev.appPath]);
    expect(parseIncomingIdentity(dev)).toEqual(dev);
  });

  it('annotates /api/production/start errors when the running bundle is stale on disk', () => {
    const raw = JSON.stringify({
      code: 'prompt_missing',
      message: '预设 landscape-16x9 遇到未知占位符：{{MOTION_MENU}}',
    });
    expect(decorateStaleStartError(raw, false)).toBe(raw);
    const decorated = JSON.parse(decorateStaleStartError(raw, true)) as { code: string; message: string };
    expect(decorated.code).toBe('prompt_missing');
    expect(decorated.message).toContain('旧进程');
    expect(decorated.message).toContain('{{MOTION_MENU}}');
  });

  it('clears auto-set build env vars on A->B relaunch while preserving explicit overrides', () => {
    const envA: Record<string, string | undefined> = { PATH: '/usr/bin' };
    const explicitA = captureExplicitRelaunchEnv(envA);
    // 模拟 A.app 在 whenReady() 中自动写入的构建相关变量。
    envA.ONSET_ASSETS_DIR = '/Users/dev/release/A.app/Contents/Resources/assets';
    envA.ONSET_SELF = '/Users/dev/Library/Application Support/片场/bin/onset';
    envA.ONSET_NPM_CLI = '/Users/dev/release/A.app/Contents/Resources/npm/bin/npm-cli.js';
    envA.ONSET_BROWSER = '/Users/dev/Library/Application Support/片场/bin/onset-browser';
    envA.ONSET_BROWSER_APP_ARG = '/Users/dev/release/A.app/Contents/Resources/app.asar';

    sanitizeRelaunchEnv(envA, explicitA);
    expect(envA.ONSET_ASSETS_DIR).toBeUndefined();
    expect(envA.ONSET_SELF).toBeUndefined();
    expect(envA.ONSET_NPM_CLI).toBeUndefined();
    expect(envA.ONSET_BROWSER).toBeUndefined();
    expect(envA.ONSET_BROWSER_APP_ARG).toBeUndefined();
    expect(envA.PATH).toBe('/usr/bin');

    // 模拟 B.app 继承清理后的环境并按自身资源目录回落。
    envA.ONSET_ASSETS_DIR ??= '/Applications/B.app/Contents/Resources/assets';
    expect(envA.ONSET_ASSETS_DIR).toBe('/Applications/B.app/Contents/Resources/assets');

    // 外部显式覆盖 ONSET_ASSETS_DIR 时必须保留。
    const envExplicit: Record<string, string | undefined> = { ONSET_ASSETS_DIR: '/custom/assets' };
    const explicitOverride = captureExplicitRelaunchEnv(envExplicit);
    envExplicit.ONSET_SELF = '/tmp/auto-self';
    sanitizeRelaunchEnv(envExplicit, explicitOverride);
    expect(envExplicit.ONSET_ASSETS_DIR).toBe('/custom/assets');
    expect(envExplicit.ONSET_SELF).toBeUndefined();
  });

  it('supports macOS activate stale check with incoming=null for idle, busy, and background modes', () => {
    const self = makeIdentity({ bundleSignature: 'old-sig' });
    expect(
      decideSecondInstance({
        self,
        incoming: null,
        onDiskSignature: 'old-sig',
        activeWork: [],
        background: false,
      }),
    ).toEqual({ kind: 'focus' });
    expect(
      decideSecondInstance({
        self,
        incoming: null,
        onDiskSignature: 'new-sig',
        activeWork: [{ project: '/tmp/p', holder: '渲染中' }],
        background: false,
      }),
    ).toEqual({
      kind: 'confirm_switch',
      target: { execPath: self.execPath, args: [] },
      reason: '磁盘上的片场客户端文件已被替换，当前窗口仍停留在更新前的旧进程',
      busy: ['p：渲染中'],
    });
    expect(
      decideSecondInstance({
        self,
        incoming: null,
        onDiskSignature: 'new-sig',
        activeWork: [],
        background: true,
      }),
    ).toEqual({ kind: 'focus' });
  });
});
