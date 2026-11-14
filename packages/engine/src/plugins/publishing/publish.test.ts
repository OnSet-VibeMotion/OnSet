// 原在 validate/validate.test.ts（移植自 internal/validate/validate_test.go），随「发布」搬进内置插件。
import fs from 'node:fs';
import { directoryLink } from '../../testsupport/windowsfixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { read, replaceOnce, sharedSource, tempDir } from '../../validate/testsupport';
import { publish } from './publish';

describe('publish', () => {
  it('passes the template', () => {
    publish(sharedSource('templates', 'publish.md'), '.');
  });

  it('rejects a missing required key', () => {
    const file = path.join(tempDir(), 'publish.md');
    fs.writeFileSync(file, '---\nschema_version: 1\n---\n');
    expect(() => publish(file, '.')).toThrow();
  });

  describe('rejects secrets and escaping paths', () => {
    const template = () => read(sharedSource('templates', 'publish.md'));
    it('secret', () => {
      const body = replaceOnce(template(), 'introduction: ""', 'introduction: sk-abcdefghijklmnop');
      const file = path.join(tempDir(), 'publish.md');
      fs.writeFileSync(file, body);
      expect(() => publish(file, path.dirname(file))).toThrow();
    });
    it('escape', () => {
      const body = replaceOnce(template(), 'path: final.mp4', 'path: ../final.mp4');
      const file = path.join(tempDir(), 'publish.md');
      fs.writeFileSync(file, body);
      expect(() => publish(file, path.dirname(file))).toThrow();
    });
  });

  describe('rejects an unsafe YAML tag, a bad status and a missing heading', () => {
    const template = () => read(sharedSource('templates', 'publish.md'));
    const cases: Record<string, () => string> = {
      'unsafe-tag': () => replaceOnce(template(), 'schema_version: 1', 'schema_version: !custom 1'),
      'bad-status': () => replaceOnce(template(), 'publish_status: draft', 'publish_status: published'),
      'missing-heading': () => replaceOnce(template(), '## 发布平台', '## removed'),
    };
    for (const [name, body] of Object.entries(cases)) {
      it(name, () => {
        const file = path.join(tempDir(), 'publish.md');
        fs.writeFileSync(file, body());
        expect(() => publish(file, path.dirname(file))).toThrow();
      });
    }
  });

  it('rejects an evidence symlink outside the project', () => {
    const root = tempDir();
    const outside = path.join(tempDir(), 'evidence.txt');
    fs.writeFileSync(outside, 'outside');
    if (process.platform === 'win32') directoryLink(path.dirname(outside), path.join(root, 'linked'));
    else fs.symlinkSync(outside, path.join(root, 'evidence.txt'));
    const body = replaceOnce(read(sharedSource('templates', 'publish.md')), 'approval: ""', 'approval: ' + (process.platform === 'win32' ? 'linked/evidence.txt' : 'evidence.txt'));
    const file = path.join(root, 'publish.md');
    fs.writeFileSync(file, body);
    expect(() => publish(file, root)).toThrow();
  });
});
