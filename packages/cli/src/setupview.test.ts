import { describe, expect, it } from 'vitest';
import { displayWidth, SetupView, ViewState } from './setupview';

describe('setup view', () => {
  // 不是终端时不重画：每次状态或阶段变化打一行，同样的一行不重复打；列按显示宽度对齐。
  it('prints plain lines outside a terminal', () => {
    let out = '';
    const view = new SetupView({ write: (t) => (out += t) }, ['HyperFrames 技能', '整片风格 lemo-opuscar'], ['0.8.225', '']);
    view.set(0, ViewState.Ready, '');
    view.set(1, ViewState.Running, '准备中');
    view.detail(1, '(1/3) 下载基础部分');
    view.detail(1, '(1/3) 下载基础部分');
    view.set(1, ViewState.Done, '');
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(out).not.toContain('\x1b[');
    expect(lines[0]).toContain('✓');
    expect(lines[0]).toContain('已就绪');
    expect(lines[3]).toContain('完成');
    // 两行的名字列宽度一样：版本列从同一列开始。
    expect(displayWidth(lines[1].slice(0, lines[1].indexOf('准备中')))).toBe(displayWidth(lines[2].slice(0, lines[2].indexOf('(1/3)'))));
  });

  it('counts CJK as two columns', () => {
    expect(displayWidth('整片风格 ab')).toBe(11);
  });
});
