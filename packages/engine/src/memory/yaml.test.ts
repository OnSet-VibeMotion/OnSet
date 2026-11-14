// 不在 Go 版里：记忆文件的 frontmatter 与 Lint 文案逐字节对照 Go 版。
//
// testdata/go-golden.json 是双跑对照时由 Go 版（gopkg.in/yaml.v3 编码 Meta、memory.Lint）
// 产出的真实结果：引号风格、块标量、BOM 与换行类字符的写法都按 yaml.v3 的实际行为，
// 包括它把值开头的换行吞进头部那一行、值以 BOM 开头时后面每个字符都转义这两处怪癖。
// 用户已有的记忆库是 Go 写的，写出的字节一旦不同，快照摘要就对不上，Drift 会全报漂移。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lint } from './lint';
import { format, newApplies, newMemory, parse, ruleDigest, type Memory } from './memory';

type J = Record<string, any>;

function memoryFromJSON(o: J): Memory {
  const a = o.applies_when ?? {};
  return newMemory({
    name: o.name ?? '',
    description: o.description ?? '',
    status: o.status ?? '',
    applies_when: newApplies({ features: a.features ?? [], keywords: a.keywords ?? [], renderers: a.renderers ?? [], models: a.models ?? [] }),
    checked_by: o.checked_by ?? null,
    scope: o.scope ?? '',
    from_episodes: o.from_episodes ?? [],
    verified_by: o.verified_by ?? [],
    revises: o.revises ?? '',
    rejected_reason: o.rejected_reason ?? '',
    kind: o.kind ?? '',
    body: o.body ?? '',
  });
}

const golden = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'testdata', 'go-golden.json'), 'utf8')) as J[];

describe('yaml.v3 compatibility', () => {
  it('format writes the same bytes as Go and keeps the rule digest', () => {
    const cases = golden.filter((c) => c.memory);
    expect(cases.length).toBeGreaterThan(90);
    for (const c of cases) {
      const m = memoryFromJSON(c.memory);
      expect(format(m), JSON.stringify(c.memory.description)).toBe(c.format);
      expect(ruleDigest(m)).toBe(c.digest);
    }
  });

  it('lint reports the same problems as Go', () => {
    for (const c of golden.filter((x) => x.lint)) {
      const problems = lint(memoryFromJSON(c.lint), { existing: (c.existing ?? []).map(memoryFromJSON), sceneTexts: c.scene_texts ?? [] });
      expect(problems.length > 0 ? problems : null).toEqual(c.problems);
    }
  });

  it('parse mirrors yaml.v3 decoding quirks', () => {
    // 字符串序列里的 null 元素不进切片；任何标量都按原文进 string。
    const m = parse('lesson', '---\nname: 12\nchecked_by: [1, true, ~]\n---\nbody\n');
    expect(m.name).toBe('12');
    expect(m.checked_by).toEqual(['1', 'true']);
    // 未知字段报 yaml.v3 的原文。
    expect(() => parse('lesson', '---\nname: x\napplies_when:\n  feature: [a]\n---\nb')).toThrow(
      'frontmatter 不合法：yaml: unmarshal errors:\n  line 3: field feature not found in type memory.Applies',
    );
    // 最后一个键是多行值时，frontmatter 在 "\n---" 前截断，块标量末尾不补换行。
    const multi = newMemory({ kind: 'lesson', name: 'eof-x', status: 'trial', checked_by: ['output.frames'], body: 'b', rejected_reason: 'a\nb\n' });
    expect(parse('lesson', format(multi)).rejected_reason).toBe('a\nb');
  });
});
