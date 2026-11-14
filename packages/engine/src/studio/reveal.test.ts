import './testsupport';
import fs from 'node:fs';
import { directoryLink } from '../testsupport/windowsfixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startStudio, tempDir, writeTree } from './testsupport';

// 「在 Finder 中显示」只认项目里的路径。
describe('revealPath', () => {
  function fixture() {
    const root = tempDir();
    writeTree(root, {
      'scenes/scene-001/scene.json': '{"id":"scene-001","duration_seconds":1,"output":"scene-001.mp4"}',
      'scenes/scene-001/scene-001.mp4': 'mp4',
      '.env': 'SECRET=1',
    });
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    directoryLink(outside, path.join(root, 'link-out'));
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    return { s, root: s.currentProject().path, outside };
  }

  it('opens the project folder and selects files inside it', () => {
    const { s, root } = fixture();
    expect(s.revealPath('', '')).toEqual({ path: root, folder: true });
    expect(s.revealPath('', 'scenes/scene-001/scene-001.mp4')).toEqual({ path: path.join(root, 'scenes/scene-001/scene-001.mp4'), folder: false });
    // 绝对路径（镜头目录就是绝对路径）也行，只要在项目里。
    expect(s.revealPath('', path.join(root, 'scenes/scene-001'))).toEqual({ path: path.join(root, 'scenes/scene-001'), folder: false });
    // 还没渲染出来的文件退到最近一层存在的目录。
    expect(s.revealPath('', 'scenes/scene-002/scene-002.mp4')).toEqual({ path: path.join(root, 'scenes'), folder: false });
    // 项目 id 也能用（首页的最近项目）。
    expect(s.revealPath(s.currentProject().id, '')).toEqual({ path: root, folder: true });
  });

  it('refuses paths outside the project and does not select .env', () => {
    const { s, root, outside } = fixture();
    expect(() => s.revealPath('', '../')).toThrow('路径不在项目里');
    expect(() => s.revealPath('', outside)).toThrow('路径不在项目里');
    expect(() => s.revealPath('', 'link-out/secret.txt')).toThrow('路径不在项目里');
    expect(() => s.revealPath('project-unknown', '')).toThrow('项目没有登记');
    expect(s.revealPath('', '.env')).toEqual({ path: root, folder: true });
  });
});
