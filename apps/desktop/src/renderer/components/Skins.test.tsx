// @vitest-environment jsdom
/*
 * 界面皮肤：设置页「外观」（Skins.tsx）与插件皮肤用页面换掉桌宠（Pet.tsx 的 PetPage）。
 * 页面在沙箱 iframe 里，这里不加载它，只看宿主一侧的桥：宿主把桌宠状态与皮肤颜色 postMessage 过去，
 * 页面发回的动作原样交给主进程（window.onset.pet）。真页面经 /station-ui 加载、宿主插进去的拖动脚本、
 * 主窗口与桌宠一起换色，留在 e2e/skins.spec.mjs。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockApi, type MockRequest } from '../testing';
import { applySkin } from '../skin';
import { SkinPicker } from './Skins';
import { Pet } from './Pet';
import type { SkinView, SkinsResponse } from '../types';
import type { CrewSignal, PetCommand } from './chat/crew';

function skinView(over: Partial<SkinView> & Pick<SkinView, 'id' | 'name'>): SkinView {
  return {
    description: '',
    scheme: 'dark',
    origin: 'builtin',
    plugin: '',
    tokens: {},
    fonts: {},
    radius: null,
    swatch: ['#0b0a09', '#151311', '#ede6da', '#d9a35f'],
    ...over,
    pet: { materials: {}, crew: {}, room: {}, filter: {}, page_url: '', ...over.pet },
  };
}

// 与 studio/skins.ts 的 skinJSON 同形：放映室、内置的白昼，加一个用页面换掉桌宠的插件皮肤。
const screening = skinView({ id: 'default', name: '放映室', origin: 'host' });
const daylight = skinView({ id: 'skins/daylight', name: '白昼', scheme: 'light', plugin: '界面皮肤', tokens: { bg: '#f4f1ea', accent: '#9a5b1c' } });
const cat = skinView({
  id: 'cat-skins/cat',
  name: '猫咪',
  origin: 'plugin',
  plugin: '猫咪皮肤',
  tokens: { accent: '#e07a5f' },
  pet: { materials: {}, crew: {}, room: {}, filter: {}, page_url: '/station-ui/cat-skins/ui/cat.html' },
});

let sent: PetCommand[] = [];
let push: (signal: Partial<CrewSignal>) => void = () => {};
const changed: string[] = [];

beforeEach(() => {
  sent = [];
  changed.length = 0;
  window.onset = {
    desktop: true,
    platform: 'darwin',
    pet: (command) => {
      sent.push(command);
    },
    skinChanged: (bg) => {
      changed.push(bg);
    },
    onCrew: (callback) => {
      push = (signal) =>
        callback({ mood: 'idle', line: '待命', project: '示例', rendering: [], asks: [], choices: [], question: '', running: false, canSend: true, plan: [], turnStarted: '', renderSince: {}, recent: [], ...signal });
      return () => {};
    },
  };
});

afterEach(() => {
  delete window.onset;
  act(() => applySkin(screening));
});

describe('外观', () => {
  it('列出插件带来的皮肤，点一下换上、写进登记并告诉别的窗口', async () => {
    const user = userEvent.setup();
    const list: SkinsResponse = { current: 'default', skins: [screening, daylight, cat], problems: [{ plugin: 'broken', file: 'skins/x.json', message: '不是 JSON' }] };
    const backend = mockApi({
      '/api/skins': list,
      'PUT /api/skins/current': (req: MockRequest) => ({ skin: [screening, daylight, cat].find((s) => s.id === (req.body as { id: string }).id) }),
    });
    render(<SkinPicker version={0} />);
    const card = (id: string) => document.querySelector<HTMLButtonElement>(`.skin-card[data-skin="${id}"]`)!;
    await waitFor(() => expect(document.querySelectorAll('.skin-card')).toHaveLength(3));
    expect(card('default').getAttribute('aria-checked')).toBe('true');
    expect(card('default').textContent).toContain('自带');
    expect(card('cat-skins/cat').textContent).toContain('猫咪皮肤 · 换了桌宠');
    expect(card('skins/daylight').textContent).not.toContain('换了桌宠');
    expect(screen.getByText(/插件「broken」的皮肤 skins\/x.json 读不出来：不是 JSON/)).toBeTruthy();

    await user.click(card('skins/daylight'));
    await waitFor(() => expect(card('skins/daylight').getAttribute('aria-checked')).toBe('true'));
    expect(backend.calls.find((c) => c.method === 'PUT')?.body).toEqual({ id: 'skins/daylight' });
    expect(document.documentElement.dataset.skin).toBe('skins/daylight');
    expect(document.documentElement.dataset.scheme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#f4f1ea');
    // 告诉主进程（换窗口底色、通知桌宠重取）。
    expect(changed).toEqual(['#f4f1ea']);

    // 已经选中的再点不发请求；换回放映室，内联变量清掉。
    await user.click(card('skins/daylight'));
    expect(backend.count('PUT /api/skins/current')).toBe(1);
    await user.click(card('default'));
    await waitFor(() => expect(document.documentElement.dataset.skin).toBe('default'));
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('');
    expect(backend.unmatched).toEqual([]);
  });
});

describe('插件页面换掉桌宠', () => {
  it('工作室换成沙箱页面，页面拿到状态与皮肤颜色，发回的动作原样交给主进程', async () => {
    render(<Pet />);
    expect(document.querySelector('.pet-room')).not.toBeNull();
    act(() => applySkin(cat));
    const frame = document.querySelector<HTMLIFrameElement>('.pet-frame')!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe('/station-ui/cat-skins/ui/cat.html');
    // 自己的工作室、取景按钮都不画。
    expect(document.querySelector('.pet-room')).toBeNull();
    expect(document.querySelector('.pet-cam')).toBeNull();

    // 宿主发给页面的：完整的桌宠状态（含等批准的调用、选项）与皮肤的颜色。
    const received: { onset: string; signal: CrewSignal; skin: { scheme: string; tokens: Record<string, string> } }[] = [];
    frame.contentWindow!.addEventListener('message', (e) => received.push(e.data));
    act(() =>
      push({ asks: [{ id: 'ask-1', text: 'npm install three', always: true }], choices: ['黑板粉笔风', '白板手绘风'], question: '选一个风格：' }),
    );
    await waitFor(() => expect(received.some((m) => m.signal.asks.length > 0)).toBe(true));
    const last = received[received.length - 1];
    expect(last.onset).toBe('pet');
    expect(last.skin.tokens.accent).toBe('#e07a5f');
    expect(last.signal.mood).toBe('idle');
    expect(last.signal.asks[0].text).toBe('npm install three');
    expect(last.signal.choices).toEqual(['黑板粉笔风', '白板手绘风']);

    // 页面能做桌宠能做的一切，不再要用户在宿主上确认：切页、答批准、替用户选。
    const fromPage = (data: unknown, source: Window | null = frame.contentWindow) =>
      act(() => window.dispatchEvent(new MessageEvent('message', { data, source })));
    fromPage({ onset: 'pet-command', command: { kind: 'open', page: 'progress' } });
    fromPage({ onset: 'pet-command', command: { kind: 'answer', id: 'ask-1', decision: 'allow' } });
    fromPage({ onset: 'pet-command', command: { kind: 'say', text: '白板手绘风' } });
    // 宿主插进页面的拖动脚本：按住挪动报开始与结束，交给主进程挪窗口。
    fromPage({ onset: 'pet-drag', phase: 'start' });
    fromPage({ onset: 'pet-drag', phase: 'end' });
    fromPage({ onset: 'pet-drag', phase: 'sideways' });
    // 不是这个 iframe 发的、形状不对的，一律不理。
    fromPage({ onset: 'pet-command', command: { kind: 'stop' } }, window);
    fromPage({ onset: 'pet-command', command: 'stop' });
    expect(sent).toEqual([
      { kind: 'open', page: 'progress' },
      { kind: 'answer', id: 'ask-1', decision: 'allow' },
      { kind: 'say', text: '白板手绘风' },
      { kind: 'drag', phase: 'start' },
      { kind: 'drag', phase: 'end' },
    ]);

    // 换回不带页面的皮肤：工作室回来。
    act(() => applySkin(screening));
    expect(document.querySelector('.pet-frame')).toBeNull();
    expect(document.querySelector('.pet-room')).not.toBeNull();
  });
});
