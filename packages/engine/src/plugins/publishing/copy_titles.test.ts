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

describe('platform hashtags', () => {
  it('accepts per-platform topics and an empty list', () => {
    const file = publishWithCopy(
      'xiaohongshu',
      '  primary_title: "短标题"\n  platform_hashtags:\n    xiaohongshu: ["片场", "小红书创作活动"]\n    bilibili: []\n',
    );
    publish(file, path.dirname(file));
  });

  it('reports every malformed entry at once', () => {
    const file = publishWithCopy(
      'xiaohongshu',
      '  primary_title: "短标题"\n  platform_hashtags:\n    tiktok: ["x"]\n    douyin: "片场"\n    xiaohongshu: ["片场", ""]\n',
    );
    const err = errorOf(() => publish(file, path.dirname(file))).message;
    for (const want of ['未知平台 "tiktok"', 'copy.platform_hashtags.douyin 必须是话题列表', 'copy.platform_hashtags.xiaohongshu[1] 必须是非空的话题文字']) expect(err).toContain(want);
  });

  it('rejects a list instead of a platform map', () => {
    const file = publishWithCopy('douyin', '  primary_title: "短标题"\n  platform_hashtags: ["片场"]\n');
    expect(errorOf(() => publish(file, path.dirname(file))).message).toContain('copy.platform_hashtags 必须是');
  });
});
