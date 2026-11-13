// 移植自 internal/validate/copy_titles_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorOf, read, replaceOnce, sharedSource, tempDir } from '../../validate/testsupport';
import { publish } from './publish';

/** 在模板基础上写入平台与 copy 块里的标题行。 */
function publishWithCopy(platform: string, copyLines: string): string {
  const root = tempDir();
  let text = replaceOnce(read(sharedSource('templates', 'publish.md')), 'platform: unspecified', 'platform: ' + platform);
  text = replaceOnce(text, '  primary_title: ""\n', copyLines);
  const file = path.join(root, 'publish.md');
  fs.writeFileSync(file, text);
  return file;
}

describe('copy titles', () => {
  it('accepts titles within platform limits', () => {
    // 抖音 30 字整：上限本身要放行
    const douyin30 = '考'.repeat(25) + 'Vibe!';
    const file = publishWithCopy(
      'douyin',
      `  primary_title: "${douyin30}"\n  platform_titles:\n    xiaohongshu: "考什么，就造什么：考核为什么总被造假"\n    bilibili: "${'长'.repeat(60)}"\n`,
    );
    publish(file, path.dirname(file));
  });

  it('rejects overlong titles', () => {
    const file = publishWithCopy(
      'douyin',
      '  primary_title: "Vibe知识大赏｜考什么，就造什么：为什么考核什么，就会有人造假什么"\n  platform_titles:\n    xiaohongshu: "Vibe知识大赏｜考什么，就造什么：考核为什么"\n',
    );
    const err = errorOf(() => publish(file, path.dirname(file)));
    // 两条都要报，且报出实际字数
    for (const want of ['抖音标题最多 30 个字，当前 34 个字', '小红书标题最多 20 个字，当前 23 个字']) expect(err.message).toContain(want);
  });

  it('rejects an unknown title platform', () => {
    const file = publishWithCopy('douyin', '  primary_title: "短标题"\n  platform_titles:\n    tiktok: "short"\n');
    expect(errorOf(() => publish(file, path.dirname(file))).message).toContain('未知平台');
  });
});
