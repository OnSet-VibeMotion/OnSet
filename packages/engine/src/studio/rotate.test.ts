import { describe, expect, it } from 'vitest';
import type { Entry } from '../ledger';
import { RotateCalls, handoffNote, rotationReason } from './rotate';

const entry = (session: string, input: number, turns: number, source = 'claude result'): Entry => ({
  time: '2026-11-17T00:00:00Z', source: 'studio', tool: 'claude', session, status: 'succeeded',
  usage: { input_tokens: input, turns, source, basis: 'total-input' },
});

describe('rotationReason', () => {
  // 2026-11 片场宣传视频的编排会话：第 3 轮平均 15 万一次，后来 38 万一次。按最近一轮的平均上下文判断。
  it('rotates once the last call averages past the threshold', () => {
    expect(rotationReason([entry('a', 23 * 86_000, 23)], 'a')).toBe('');
    expect(rotationReason([entry('a', 82 * 382_000, 82)], 'a')).toBe('上一轮平均每次调用要读约 38 万 token 的上下文');
    // 只看现在续接的会话；早的长、最近一轮短（刚压缩过）就不换。
    expect(rotationReason([entry('a', 82 * 382_000, 82), entry('a', 5 * 60_000, 5)], 'a')).toBe('');
    expect(rotationReason([entry('b', 82 * 382_000, 82)], 'a')).toBe('');
    expect(rotationReason(null, 'a')).toBe('');
    expect(rotationReason([entry('a', 82 * 382_000, 82)], '')).toBe('');
  });

  // qoder 只报额度、token 是 0：按这个会话累计的调用次数。
  it('falls back to the call count when the tool reports no tokens', () => {
    const qoder = (turns: number) => entry('q', 0, turns, 'qoder result');
    expect(rotationReason([qoder(100), qoder(100)], 'q')).toBe('');
    expect(rotationReason([qoder(100), qoder(100), qoder(RotateCalls - 200)], 'q')).toBe(`这个会话已经调用了 ${RotateCalls} 次`);
    // 没读到用量的一轮不算。
    const blank: Entry = { ...qoder(0), usage: null };
    expect(rotationReason([blank], 'q')).toBe('');
  });
});

describe('handoffNote', () => {
  it('points at the project files and carries the last plan', () => {
    const note = handoffNote('原因', [
      { text: '拆分镜头', status: 'completed' },
      { text: '正在渲染镜头', status: 'in_progress' },
      { text: '拼接', status: 'pending' },
      { text: ' ', status: 'pending' },
    ]);
    expect(note).toContain('（原因，');
    expect(note).toContain('以文件为准');
    expect(note).toContain('- [x] 拆分镜头\n- [ ] 正在渲染镜头（进行中）\n- [ ] 拼接');
    expect(handoffNote('原因', undefined)).not.toContain('待办清单');
  });
});
