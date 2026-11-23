import { describe, expect, it } from 'vitest';
import type { Entry } from '../ledger';
import { GateHandoffCalls, GateHandoffContextTokens, GateHandoffIdleMs, RotateCalls, handoffNote, rotationReason, shouldGateHandoff } from './rotate';

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
    expect(rotationReason([qoder(80), qoder(80)], 'q')).toBe('');
    expect(rotationReason([qoder(80), qoder(80), qoder(RotateCalls - 160)], 'q')).toBe(`这个会话已经调用了 ${RotateCalls} 次`);
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
    const withState = handoffNote('手动分段接力', undefined, '- 镜头进度：共 10 镜；已就绪 6；未渲染 4');
    expect(withState).toContain('当前项目文件快照');
    expect(withState).toContain('共 10 镜；已就绪 6；未渲染 4');
  });
});

it('rotates Codex app-server on request size rather than the whole Studio turn', () => {
  const entry: Entry = {
    time: '', source: 'studio', tool: 'codex', session: 's', status: 'succeeded',
    usage: { source: 'codex app-server', turns: 1, input_tokens: 1_000_000 },
  };
  expect(rotationReason([entry], 's')).toBe('');
  entry.usage!.last_request_input_tokens = 48_000;
  expect(rotationReason([entry], 's')).toBe('');
  entry.usage!.last_request_input_tokens = 250_000;
  expect(rotationReason([entry], 's')).toContain('25 万');
});

it('does not false-rotate ACP turns=1 cumulative usage, and rotates when multi-step average crosses threshold', () => {
  const legacyAcp: Entry = {
    time: '', source: 'studio', tool: 'agy', session: 's1', status: 'succeeded',
    usage: { source: 'acp usage', turns: 1, input_tokens: 434_000 },
  };
  expect(rotationReason([legacyAcp], 's1')).toBe('');
  const normalMultiStep: Entry = {
    time: '', source: 'studio', tool: 'agy', session: 's2', status: 'succeeded',
    usage: { source: 'acp usage', turns: 10, input_tokens: 800_000 },
  };
  expect(rotationReason([normalMultiStep], 's2')).toBe('');
  const heavyMultiStep: Entry = {
    time: '', source: 'studio', tool: 'agy', session: 's3', status: 'succeeded',
    usage: { source: 'acp usage', turns: 10, input_tokens: 2_000_000 },
  };
  expect(rotationReason([heavyMultiStep], 's3')).toContain('20 万');

  // 单轮 80 步均读 8.7 万 token 时，末尾真实上下文往往已突破 20 万，应触发轮换。
  const growingMultiStep: Entry = {
    time: '', source: 'studio', tool: 'agy', session: 's4', status: 'succeeded',
    usage: { source: 'acp usage', turns: 80, input_tokens: 6_950_000 },
  };
  expect(rotationReason([growingMultiStep], 's4')).toContain('连续调用了 80 次');

  // 即使报 token 且单轮均值未越界，累计调用达到 RotateCalls 也应换会话（不能被均值分支提前 return 屏蔽）。
  expect(rotationReason([
    entry('s5', 90 * 60_000, 90, 'acp usage'),
    entry('s5', 90 * 60_000, 90, 'acp usage'),
  ], 's5')).toBe(`这个会话已经调用了 ${RotateCalls} 次`);
});

describe('shouldGateHandoff', () => {
  const now = Date.parse('2026-11-23T12:10:00Z');
  const warmTime = '2026-11-23T12:08:00Z'; // 2 分钟前，缓存还热
  const coldTime = '2026-11-23T12:04:00Z'; // 6 分钟前，短期缓存已冷

  it('preserves warm cache when the session is still light and recently active', () => {
    const light: Entry = {
      time: warmTime, source: 'studio', tool: 'claude', session: 's1', status: 'succeeded',
      usage: { input_tokens: 5 * 55_000, turns: 5, source: 'claude result', basis: 'total-input' },
    };
    expect(shouldGateHandoff([light], 's1', warmTime, now)).toBe(false);

    const lightCodex: Entry = {
      time: warmTime, source: 'studio', tool: 'codex', session: 's2', status: 'succeeded',
      usage: { input_tokens: 500_000, turns: 1, last_request_input_tokens: 60_000, source: 'codex app-server', basis: 'total-input' },
    };
    expect(shouldGateHandoff([lightCodex], 's2', warmTime, now)).toBe(false);
  });

  it('hands off when context is heavy, call count is high, or idle time exceeds cache TTL', () => {
    const heavyAvg: Entry = {
      time: warmTime, source: 'studio', tool: 'agy', session: 's3', status: 'succeeded',
      usage: { input_tokens: 10 * GateHandoffContextTokens, turns: 10, source: 'acp usage', basis: 'total-input' },
    };
    expect(shouldGateHandoff([heavyAvg], 's3', warmTime, now)).toBe(true);

    const manyCalls: Entry = {
      time: warmTime, source: 'studio', tool: 'qoder', session: 's4', status: 'succeeded',
      usage: { input_tokens: 0, turns: GateHandoffCalls, source: 'qoder result', basis: 'total-input' },
    };
    expect(shouldGateHandoff([manyCalls], 's4', warmTime, now)).toBe(true);

    const lightButCold: Entry = {
      time: coldTime, source: 'studio', tool: 'claude', session: 's5', status: 'succeeded',
      usage: { input_tokens: 4 * 45_000, turns: 4, source: 'claude result', basis: 'total-input' },
    };
    expect(now - Date.parse(coldTime)).toBeGreaterThanOrEqual(GateHandoffIdleMs);
    expect(shouldGateHandoff([lightButCold], 's5', coldTime, now)).toBe(true);

    // 无账本记录时沿用阶段边界接力，空 session ID 不接力。
    expect(shouldGateHandoff(null, 's6', warmTime, now)).toBe(true);
    expect(shouldGateHandoff([], '', coldTime, now)).toBe(false);
  });
});
