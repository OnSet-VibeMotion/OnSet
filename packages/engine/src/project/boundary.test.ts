// 移植自 internal/project/boundary_test.go。
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { assetsBase } from '../assets';
import { everyBuiltinPrompt, skillTreeRoot } from './testsupport';

/** 仓库根：Go 版是 internal/project 的 ../..；TS 版按资产目录定位，与测试文件所在层级无关。 */
const repoRoot = assetsBase();

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('boundary', () => {
  it.skipIf(!hasGit)('public tree contains no private or legacy content', () => {
    const ran = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, maxBuffer: 1 << 30 });
    if (ran.status !== 0) throw new Error(ran.stderr.toString('utf8') || 'git ls-files 失败');
    const forbidden = [
      /^transcription\.srt$/,
      /^transcription-production\.srt$/,
      /^final\.mp4$/,
      /^publish\.md$/,
      /^scenes\//,
      /^production\//,
      /^exampleFolder\//,
      /^auto-hyper-\//,
      /^readme-assets\//,
      /^docs\/superpowers\//,
      /^article_to_motion\//,
      /^auto-test\//,
      /^pyproject\.toml$/,
      /^am$/,
    ];
    const hits: string[] = [];
    // strings.Fields：按 ASCII 空白切分（git 会把非 ASCII 路径加引号转义，与 Go 版看到的一样）。
    for (const file of ran.stdout.toString('utf8').split(/[\t\n\v\f\r ]+/).filter(Boolean)) {
      for (const pattern of forbidden) {
        if (pattern.test(file)) hits.push(`public tree contains forbidden path ${file}`);
      }
    }
    expect(hits).toEqual([]);
  });

  // 制作提示词不再是签入的文件，而是按流程组合的：对每个内置流程、每个画幅、发布开与关的组合结果都查一遍。
  it('prompts use installed CLI and do not expose executor identity', () => {
    const problems: string[] = [];
    for (const { name, text } of everyBuiltinPrompt()) {
      if (text.includes('./am')) problems.push(`${name} 引用了 ./am：用户项目里没有这个二进制`);
      // 内置技能树的路径字面含 "agent"，但它是文件系统路径，不是执行者身份声明，
      // 而提示词必须能点名它——锁定文件要靠这条路径写读取例外。先摘掉这个字面量
      // 再查身份词，其余任何 "agent" 出现仍然失败。
      const identity = text.toLowerCase().split(skillTreeRoot).join('');
      if (identity.includes('agent')) problems.push(`${name} 暴露了执行者身份（出现 agent 一词）`);
    }
    expect(problems).toEqual([]);
  });
});
