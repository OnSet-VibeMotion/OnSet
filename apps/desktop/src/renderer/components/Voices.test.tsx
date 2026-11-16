// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mockApi } from '../testing';
import type { VoiceEntry, VoiceLibrary } from '../types';
import { VoicesTab } from './Voices';

// 录我的声音：麦克风、录音机、电平与解码都换成假的（jsdom 里没有）。录音转成参考音频（ffmpeg）在
// 后端，由引擎的音色测试管；这里看页面怎么录、怎么回放跟读、交给 /api/voice-record 的是什么。

const sampleText = '大家好，欢迎来到今天的节目。这一期我们聊一个看起来简单、其实很多人都想错了的问题：为什么坚持，往往比开始更难？';
const takeURL = '/blob/take';

class FakeRecorder {
  static last: FakeRecorder | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly stream: MediaStream) {
    FakeRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['麦克风录音'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

/** 实时电平用的 AudioContext：分析器每次都报一个说话音量的峰值。 */
class FakeAudioContext {
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return { fftSize: 1024, getFloatTimeDomainData: (data: Float32Array) => data.fill(0.2) };
  }
  close() {
    return Promise.resolve();
  }
}

/** 解码录音画波形：5 秒、有声音的一段。 */
class FakeOfflineAudioContext {
  decodeAudioData() {
    const rate = 8000;
    const samples = Float32Array.from({ length: rate * 5 }, (_, i) => Math.sin(i / 3) * 0.5);
    return Promise.resolve({ numberOfChannels: 1, length: samples.length, sampleRate: rate, duration: 5, getChannelData: () => samples });
  }
}

let stopped = 0;
beforeEach(() => {
  stopped = 0;
  const track = { stop: () => stopped++ };
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream) },
  }));
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
  // 波形按容器宽度画柱子：jsdom 不排版，直接报一个宽度。
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback([{ contentRect: { width: 320 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  });
  URL.createObjectURL = () => takeURL;
  URL.revokeObjectURL = () => {};
});
afterEach(() => vi.useRealTimers());

test('records my own voice from the microphone into the shared library', async () => {
  const library: VoiceLibrary = {
    dir: '/home/u/.local/share/onset/voices',
    default: '',
    voices: [],
    sample_text: sampleText,
    design: { ready: false, supported: true, problem: '', install_id: 'voice:breeze' },
  };
  const backend = mockApi({
    '/api/voices': () => library,
    [takeURL]: { audio: 'webm' },
    // 存好后列表里的声音也画波形：读它的参考音频。
    [`/api/voices/${encodeURIComponent('我的声音')}/reference.wav`]: { audio: 'wav' },
    'POST /api/voice-record': () => {
      const saved: VoiceEntry = { name: '我的声音', text: sampleText, source: 'recorded', instruction: '', duration_seconds: 4.2, created: '2026-11-17T00:00:00Z', is_default: true };
      library.voices = [saved];
      library.default = saved.name;
      return saved;
    },
  });
  const user = userEvent.setup();
  render(<VoicesTab version={1} />);

  const tab = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.voices-tab');
    if (!el) throw new Error('音色页还没读出来');
    return el;
  });
  expect(tab.querySelector('.voices-empty')!.textContent).toContain('录一段自己的声音');
  // 默认就是「录我的声音」：页面给出要念的那段字。
  expect(within(tab).getByRole('tab', { name: /录我的声音/ }).getAttribute('aria-selected')).toBe('true');
  expect(tab.querySelector('.voices-sample')!.textContent).toContain('大家好');

  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  await user.click(within(tab).getByRole('button', { name: '开始录音' }));
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  // 录的时候有实时电平：电平按分析器的响度画柱子。
  act(() => vi.advanceTimersByTime(4200));
  const live = tab.querySelectorAll('.voices-live .voice-bars rect');
  expect(live.length).toBeGreaterThan(0);
  expect([...live].some((r) => Number(r.getAttribute('height')) > 2)).toBe(true);
  expect(tab.querySelector('.voices-rec')!.textContent).toContain('停止 · 4 秒');
  vi.useRealTimers();
  await user.click(tab.querySelector<HTMLElement>('.voices-rec')!);
  // 停下就还回麦克风。
  expect(stopped).toBe(1);

  // 录完是这一段的波形，回放时文字跟着亮。
  const take = tab.querySelector<HTMLElement>('.voices-take')!;
  await waitFor(() => expect(take.querySelector('.voice-clock')!.textContent).toMatch(/^0:0\d\.\d$/));
  const audio = tab.querySelector('audio')!;
  let position = 0;
  Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => position, set: (v: number) => (position = v) });
  await user.click(within(take).getByTitle('回放'));
  expect(audio.getAttribute('src')).toBe(takeURL);
  position = 1.2;
  fireEvent.play(audio);
  await waitFor(() => expect(take.querySelectorAll('.voice-read .w.now')).toHaveLength(1));
  fireEvent.pause(audio);

  // 念的就是那段字，逐字稿已经填好。
  expect(tab.querySelector<HTMLTextAreaElement>('.voices-field textarea')!.value).toMatch(/大家好/);
  await user.type(screen.getByPlaceholderText('给它起个名字，例如：我的声音'), '我的声音');
  await user.click(within(tab).getByRole('button', { name: '存进音色库' }));

  const voice = await waitFor(() => {
    const el = [...tab.querySelectorAll<HTMLElement>('.voice')].find((v) => v.textContent?.includes('我的声音'));
    expect(el).toBeTruthy();
    return el!;
  });
  expect(voice.querySelector('.voice-badge')!.textContent).toBe('默认');
  expect(voice.textContent).toContain('本人录音');

  // 交给后端的是录音本身、名字、逐字稿；音色库还空着时第一个声音不用勾「设为默认」。
  const init = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === '/api/voice-record')![1]!;
  const form = init.body as FormData;
  expect(form.get('name')).toBe('我的声音');
  expect(form.get('text')).toBe(sampleText);
  expect(form.get('make_default')).toBe('false');
  const file = form.get('file') as File;
  expect(file.name).toBe('take.webm');
  expect(await file.text()).toBe('麦克风录音');
  expect(backend.unmatched).toEqual([]);
});
