import './testsupport';
import fs from 'node:fs';
import { expect, it } from 'vitest';
import * as ledger from '../ledger';
import { newSessionFixture, studioRequest } from './testsupport';

// 润色花的钱记进项目的编排账本（来源 polish），不论模型给的稿子能不能用：钱已经花了。
// 原来只有 e2e 核对这本账，e2e 只留核心流程后挪到这里。
it('records the polish call in the project ledger', async () => {
  const f = newSessionFixture();
  await studioRequest(f.s, 'POST', '/api/polish', JSON.stringify({ message: '把第二段写短一点' }));
  const rows = fs.readFileSync(ledger.projectFile(f.root), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(rows.some((row) => row.source === ledger.SourcePolish)).toBe(true);
});
