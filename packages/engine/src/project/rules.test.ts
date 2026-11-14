import fs from 'node:fs';
import { directoryLink } from '../testsupport/windowsfixtures';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialize } from './init';
import { RulesTemplate, writeRules } from './rules';
import { builtinSources } from './testsupport';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-project-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function seedRulesTemplate(root: string, body: string): void {
  fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(root, RulesTemplate), body);
}

describe('writeRules', () => {
  it('renders template under tool filename', () => {
    const root = tempDir();
    seedRulesTemplate(root, '# 项目规则\n');
    const file = writeRules(root, 'CLAUDE.md');
    expect(file).toBe(path.join(root, 'CLAUDE.md'));
    expect(fs.readFileSync(file, 'utf8')).toBe('# 项目规则\n');
  });

  it('is idempotent', () => {
    const root = tempDir();
    seedRulesTemplate(root, '# 项目规则\n');
    writeRules(root, 'AGENTS.md');
    expect(() => writeRules(root, 'AGENTS.md')).not.toThrow();
  });

  it('refuses to overwrite different content', () => {
    const root = tempDir();
    seedRulesTemplate(root, '# 项目规则\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '我自己写的规则\n');
    expect(() => writeRules(root, 'CLAUDE.md')).toThrow();
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('我自己写的规则\n');
  });

  it('fails when template missing', () => {
    expect(() => writeRules(tempDir(), 'AGENTS.md')).toThrow(RulesTemplate);
  });

  it('rejects symlinked target', () => {
    const root = tempDir();
    seedRulesTemplate(root, '# 项目规则\n');
    const outside = path.join(tempDir(), 'outside.md');
    fs.writeFileSync(outside, '别的文件\n');
    if (process.platform === 'win32') directoryLink(path.dirname(outside), path.join(root, 'AGENTS.md'));
    else fs.symlinkSync(outside, path.join(root, 'AGENTS.md'));
    expect(() => writeRules(root, 'AGENTS.md')).toThrow();
    expect(fs.readFileSync(outside, 'utf8')).toBe('别的文件\n');
  });

  // 模板必须随 onset init 下发，否则 onset run 永远只会打印「缺模板」。
  it('initialize ships rules template', () => {
    const target = path.join(tempDir(), 'video');
    initialize(target, ...builtinSources());
    expect(fs.existsSync(path.join(target, RulesTemplate))).toBe(true);
  });
});
