import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ruleIDs } from './index';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('rule ids', () => {
  // TestRuleIDsCoverEveryEmittedRule 防止新增规则后忘了登记：扫描器里每个
  // 写死的规则 ID 都必须出现在 RuleIDs 里，否则引用它的记忆过不了格式校验。
  it('cover every emitted rule', () => {
    const known = new Set(ruleIDs());
    const emitted: string[] = [];
    for (const file of ['scan.ts', 'rules.ts']) {
      const body = fs.readFileSync(path.join(here, file), 'utf8');
      for (const m of body.matchAll(/(?:this\.add\(src,\s*[^,]+,\s*|return \[)'([a-z-]+)'/g)) {
        emitted.push(m[1]);
        expect(known.has(m[1]), `规则 ${m[1]} 没有登记进 RuleIDs`).toBe(true);
      }
    }
    // 移植时加的自检：正则确实抓到了写死的规则，不是因为一条都没匹配才通过。
    expect(emitted).toContain('font-missing');
    expect(emitted).toContain('remote-font');
  });
});
