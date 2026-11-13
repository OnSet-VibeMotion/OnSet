// 移植自 internal/memory/labels_test.go。
import { describe, expect, it } from 'vitest';
import { CheckerHuman, knownCheckers } from './features';
import { CheckerLabels } from './labels';

describe('labels', () => {
  it('TestEveryCheckerHasLabel', () => {
    for (const id of [...knownCheckers(), CheckerHuman]) {
      // 校验器没有说法时记忆面板会直接显示原始 ID。
      expect(CheckerLabels[id], id).toBeTruthy();
    }
    const known = new Set([CheckerHuman, ...knownCheckers()]);
    // 说法表里的每一项都是已知校验器。
    for (const id of Object.keys(CheckerLabels)) expect(known.has(id), id).toBe(true);
  });
});
