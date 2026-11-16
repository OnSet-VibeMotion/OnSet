// @vitest-environment jsdom
/*
 * 桌宠（Pet.tsx）：小人在哪、谁在拍、点人选中、环形菜单、取景与昼夜。
 * 桌宠窗口只经 window.onset 收状态（onCrew）、交动作（pet）；这里换成假的 preload，直接推 CrewSignal，
 * 断言交给主进程的动作。主窗口 → 主进程 → 桌宠窗口的转发、窗口大小与收起记在 pet.json，留在 e2e/pet.spec.mjs。
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pet } from './Pet';
import type { CrewSignal, PetCommand } from './chat/crew';

const idle: CrewSignal = {
  mood: 'idle',
  line: '待命',
  project: '',
  rendering: [],
  asks: [],
  choices: [],
  question: '',
  running: false,
  canSend: false,
  plan: [],
  turnStarted: '',
  renderSince: {},
  recent: [],
};

let push: (signal: Partial<CrewSignal> | null) => void = () => {};
let sent: PetCommand[] = [];

beforeEach(() => {
  sent = [];
  // 减少动态：人直接落到位置上、不按帧走路，断言不用等。
  vi.stubGlobal('matchMedia', ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia);
  // 取景按视口大小缩放；jsdom 没有布局，给桌宠缺省的取景框一个尺寸。
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(440);
  window.onset = {
    desktop: true,
    platform: 'darwin',
    onCrew: (callback) => {
      push = (signal) => callback(signal ? { ...idle, ...signal } : null);
      return () => {
        push = () => {};
      };
    },
    pet: (command) => {
      sent.push(command);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.onset;
});

const crew = () => document.getElementById('crew')!;
const who = (key: string) => document.querySelector(`[data-who="${key}"]`)!;
const spot = (key: string) => document.querySelector<HTMLButtonElement>(`.pet-spot[data-spot="${key}"]`)!;

function show(signal: Partial<CrewSignal>) {
  act(() => push(signal));
}

describe('摄影', () => {
  it('每个在渲染的镜头一位摄影走到机位，脚下挂镜头号；渲染结束回沙发', () => {
    render(<Pet />);
    // 没打开项目：工作室知道还没有项目（主进程据此不显示桌宠）。
    expect(crew().dataset.project).toBe('none');
    show({ project: '示例', rendering: ['scene-001'], renderSince: { 'scene-001': new Date().toISOString() } });
    // 没有对话在跑，制作人仍在待命。
    expect(crew().dataset.mood).toBe('idle');
    expect(crew().dataset.project).toBe('open');
    expect(who('op1').getAttribute('data-active')).toBe('true');
    expect(who('op2').getAttribute('data-active')).toBe('false');
    expect(document.querySelector('[data-tag="op1"]')).toHaveProperty('textContent', '001');
    expect(document.querySelector('.pet-legend')?.textContent).toBe('1 个镜头在拍');

    // 四个镜头：前两位各拍一个，第三位拍剩下的，标签写「003+1」。
    show({ project: '示例', rendering: ['scene-001', 'scene-002', 'scene-003', 'scene-004'] });
    expect(who('op3').getAttribute('data-active')).toBe('true');
    expect(document.querySelector('[data-tag="op3"]')?.textContent).toBe('003+1');
    expect(document.querySelector('.pet-legend')?.textContent).toBe('4 个镜头在拍');

    show({ project: '示例', rendering: [] });
    expect(who('op1').getAttribute('data-active')).toBe('false');
    expect(document.querySelector('[data-tag="op1"]')).toBeNull();
    expect(document.querySelector('.pet-legend')?.textContent).toBe('');
  });
});

describe('点人', () => {
  it('选中、面板写状态与动作队列，环形菜单里都是真能做的事', async () => {
    const user = userEvent.setup();
    render(<Pet />);
    // 没打开项目时没有热区。
    expect(document.querySelector('.pet-spot')).toBeNull();
    // 刚做完一轮，带待办清单：制作人的动作队列就是它。
    show({
      project: '示例',
      mood: 'idle',
      line: '待命',
      canSend: true,
      recent: ['done'],
      plan: [
        { text: '读稿子', status: 'completed' },
        { text: '正在定风格', status: 'in_progress' },
      ],
    });

    await user.click(spot('director'));
    expect(spot('director').dataset.selected).toBe('true');
    const panel = document.querySelector('.pet-panel[data-who="director"]')!;
    expect(panel.querySelector('strong')?.textContent).toBe('制作人');
    const queue = [...panel.querySelectorAll('.pet-queue li')];
    expect(queue.map((li) => li.textContent)).toEqual(['读稿子', '正在定风格']);
    expect(queue[0].getAttribute('data-state')).toBe('completed');
    expect(panel.querySelector('.pet-needs')?.textContent).toContain('进度');
    expect(panel.querySelector('.pet-needs')?.textContent).toContain('1 / 2');
    // 收工后回到待命、上一轮做成了：舒心。
    expect(panel.querySelector('.pet-mood')?.textContent).toMatch(/满意|舒心/);

    // 环形菜单：这一轮没在跑，不给「停下」。
    const pie = document.querySelector('.pet-pie[data-who="director"]')!;
    expect([...pie.querySelectorAll('.pet-pie-item')].map((b) => b.textContent)).toEqual(['看制作路线', '对他说一句', '回到对话']);
    await user.click(screen.getByRole('menuitem', { name: '看制作路线' }));
    expect(sent).toContainEqual({ kind: 'open', page: 'progress' });
    // 菜单收起，选中留着。
    expect(document.querySelector('.pet-pie')).toBeNull();
    expect(document.querySelector('.pet-panel[data-who="director"]')).not.toBeNull();

    // 「对他说一句」打开桌上的输入框，并请主进程把桌宠设成键盘窗口。
    await user.click(spot('director'));
    await user.click(screen.getByRole('menuitem', { name: '对他说一句' }));
    expect(document.querySelector('.pet-desk[data-desk="say"]')).not.toBeNull();
    expect(sent).toContainEqual({ kind: 'type' });

    // 一轮在跑：多一个「停下这一轮」。
    show({ project: '示例', mood: 'thinking', line: '在想', running: true, canSend: true, plan: [] });
    await user.click(spot('director'));
    expect([...document.querySelectorAll('.pet-pie[data-who="director"] .pet-pie-item')].map((b) => b.textContent)).toContain('停下这一轮');
    await user.click(screen.getByRole('menuitem', { name: '停下这一轮' }));
    expect(sent).toContainEqual({ kind: 'stop' });

    // 换选摄影：闲着的摄影只给「看镜头」，面板写他在做什么闲事。
    show({ project: '示例', mood: 'idle', running: false, canSend: true });
    await user.click(spot('op1'));
    expect(document.querySelector('.pet-panel[data-who="op1"] strong')?.textContent).toBe('摄影 1');
    expect(document.querySelector('.pet-panel[data-who="op1"] .pet-panel-doing')?.textContent).not.toBe('');
    expect([...document.querySelectorAll('.pet-pie[data-who="op1"] .pet-pie-item')].map((b) => b.textContent)).toEqual(['看镜头']);
    await user.click(screen.getByRole('menuitem', { name: '看镜头' }));
    expect(sent).toContainEqual({ kind: 'open', page: 'scene' });

    // 在拍的摄影：看他在拍的那个镜头。
    show({ project: '示例', rendering: ['scene-002'], renderSince: { 'scene-002': new Date(Date.now() - 90_000).toISOString() } });
    await user.click(spot('op1'));
    const opPanel = document.querySelector('.pet-panel[data-who="op1"]')!;
    expect(opPanel.querySelector('.pet-panel-doing')?.textContent).toBe('在拍 scene-002');
    expect(opPanel.querySelector('.pet-needs')?.textContent).toContain('已拍');
    expect([...document.querySelectorAll('.pet-pie[data-who="op1"] .pet-pie-item')].map((b) => b.textContent)).toEqual(['看 scene-002', '全部镜头']);
    await user.click(screen.getByRole('menuitem', { name: '看 scene-002' }));
    expect(sent).toContainEqual({ kind: 'open', page: 'scene', target: 'scene-002' });

    // 物件不弹菜单：分镜板直接打开分镜。
    await user.click(spot('storyboard'));
    expect(sent).toContainEqual({ kind: 'open', page: 'storyboard' });
    expect(document.querySelector('.pet-pie')).toBeNull();

    // 取消选中。
    await user.click(document.querySelector<HTMLButtonElement>('.pet-panel-close')!);
    expect(document.querySelector('.pet-panel')).toBeNull();

    // 离开项目：选中与菜单一起清掉。
    await user.click(spot('op1'));
    show({ project: '' });
    expect(document.querySelector('.pet-panel')).toBeNull();
    expect(document.querySelector('.pet-pie')).toBeNull();
  });
});

describe('取景、昼夜与窗口', () => {
  const scaleOf = () => Number(document.querySelector<HTMLElement>('.pet-stage')!.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? 'NaN');

  it('放大、回到全景；光跟着这台电脑的时间走', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 17, 22, 30));
    const user = userEvent.setup();
    render(<Pet />);
    show({ project: '示例' });
    const before = scaleOf();
    expect(before).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(scaleOf()).toBeGreaterThan(before * 1.2);
    await user.click(screen.getByRole('button', { name: '缩小' }));
    await user.click(screen.getByRole('button', { name: '缩小' }));
    expect(scaleOf()).toBeLessThan(before);
    await user.click(document.querySelector<HTMLButtonElement>('.pet-cam button[data-cam="reset"]')!);
    expect(scaleOf()).toBeCloseTo(before, 3);

    // 夜里：时段与钟。
    expect(crew().dataset.daypart).toBe('night');
    expect(document.querySelector('.pet-clock')?.textContent).toBe('夜 22:30');
  });

  it.each([
    [8, 0, 'day', '白天 08:00'],
    [6, 5, 'dawn', '清晨 06:05'],
    [17, 45, 'dusk', '傍晚 17:45'],
    [20, 0, 'evening', '晚上 20:00'],
  ])('%i:%i 是 %s', (h, m, part, label) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 17, h, m));
    render(<Pet />);
    expect(crew().dataset.daypart).toBe(part);
    expect(document.querySelector('.pet-clock')?.textContent).toBe(label);
  });

  it('右下角把手报改大小的开始与结束，× 请主进程收起', async () => {
    const user = userEvent.setup();
    render(<Pet />);
    show({ project: '示例' });
    const grip = document.querySelector<HTMLElement>('.pet-grip')!;
    // jsdom 没有指针捕获。
    grip.setPointerCapture = () => {};
    await user.pointer([{ keys: '[MouseLeft>]', target: grip }, { keys: '[/MouseLeft]', target: grip }]);
    expect(sent).toEqual(expect.arrayContaining([{ kind: 'resize', phase: 'start' }, { kind: 'resize', phase: 'end' }]));
    await user.click(document.querySelector<HTMLButtonElement>('.pet-close')!);
    expect(sent).toContainEqual({ kind: 'hide' });
  });
});
