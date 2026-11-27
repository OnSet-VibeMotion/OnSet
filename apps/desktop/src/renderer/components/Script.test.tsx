// @vitest-environment jsdom
/*
 * 口播稿页的配音播放器（原 e2e/script-playback.spec.mjs「subtitles alone are not playable, unreadable audio says so,
 * and versioned audio works without subtitles」）。
 *
 * 哪些文件算配音（只有 voice.srt 不算、voice-v01.wav 没有字幕也算）是后端的事，
 * packages/engine/src/studio/script.test.ts 已经钉着；这里把 /api/script 换成后端在那几种情况下给的样子，
 * 看页面怎么说、怎么放。jsdom 不解码音频：时长、出错、播放进度都由测试在 <audio> 上触发对应事件。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mockApi } from '../testing';
import type { ScriptResponse } from '../types';
import { ScriptTab } from './Script';

const base: ScriptResponse = {
  gate: null,
  path: 'production/script-final.md',
  content: '你好世界',
  final: true,
  blocks: [{ kind: 'para', nodes: [{ kind: 'text', text: '你好世界' }] }],
  stats: { units: 4, paragraphs: 1, phrases: 0 },
  estimate_seconds: 1,
};

/** 后端给的配音：没有字幕与对齐时 seconds 为 0、按时长估算逐字时间。 */
function withAudio(path: string): ScriptResponse {
  const name = path.split('/').pop()!;
  return {
    ...base,
    voice: { path, name, version: 1, seconds: 0, timing: 'estimated' },
    audio_options: [{ path, name, version: 1 }],
  };
}

const originalPlay = HTMLMediaElement.prototype.play;
beforeEach(() => {
  // 真的播放器开始播放时会发 play 事件，页面靠它切到「暂停配音」并开始逐字跟读。
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  };
});
afterEach(() => {
  HTMLMediaElement.prototype.play = originalPlay;
});

function audioElement(): HTMLAudioElement {
  const el = document.querySelector<HTMLAudioElement>('audio[aria-label="口播配音"]');
  if (!el) throw new Error('没有配音播放器');
  return el;
}

/** 让 <audio> 报出时长与播放位置（jsdom 里这两个属性是只读的 0）。 */
function setMedia(el: HTMLAudioElement, values: { duration?: number; currentTime?: number; readyState?: number }) {
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(el, key, { configurable: true, writable: true, value });
}

test('subtitles alone are not playable, unreadable audio says so, and versioned audio works without subtitles', async () => {
  // 只有 voice.srt：后端不给 voice。页面说还没有配音，没有播放按钮。
  const api = mockApi({ '/api/script': base });
  const props = { busy: '', onQuick: vi.fn(), onFile: vi.fn(), onAttach: vi.fn() };
  const { rerender } = render(<ScriptTab version={1} {...props} />);
  await screen.findByText('还没有找到配音音频，生成后可在这里试听。');
  expect(screen.queryByRole('button', { name: '播放配音' })).toBeNull();
  expect(document.querySelector('audio')).toBeNull();

  // 读不了的音频文件：照实说放不了，不当成没有配音。
  api.set('/api/script', withAudio('production/audio/voice.wav'));
  rerender(<ScriptTab version={2} {...props} />);
  await waitFor(() =>
    expect(audioElement().getAttribute('src')).toContain(encodeURIComponent('production/audio/voice.wav')),
  );
  fireEvent.error(audioElement());
  expect((await screen.findByRole('alert')).textContent).toContain('音频无法播放');
  expect(screen.queryByText('还没有找到配音音频，生成后可在这里试听。')).toBeNull();

  // 浏览器拒绝播放（不是用户自己打断）同样照实说。
  api.set('/api/script', withAudio('production/audio/voice-v00.wav'));
  rerender(<ScriptTab version={3} {...props} />);
  await waitFor(() => expect(audioElement().getAttribute('src')).toContain('voice-v00.wav'));
  // 换了一份音频：上一份的报错清掉（清除在 effect 里，等它跑完）。
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('no supported source', 'NotSupportedError'));
  fireEvent.click(screen.getByRole('button', { name: '播放配音' }));
  expect((await screen.findByRole('alert')).textContent).toContain('音频无法播放');
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  };

  // 带版本号、没有字幕的配音：能放，按音频自身的时长估算逐字时间，从第一个字亮起。
  api.set('/api/script', withAudio('production/audio/voice-v01.wav'));
  rerender(<ScriptTab version={4} {...props} />);
  await waitFor(() => expect(audioElement().getAttribute('src')).toContain('voice-v01.wav'));
  const audio = audioElement();
  setMedia(audio, { duration: 4, currentTime: 0, readyState: 4 });
  fireEvent.loadedMetadata(audio);
  await screen.findByText(/按时长估算/);
  expect(document.querySelector('.script-stats .voiced')!.textContent).toBe('配音 0:04');
  fireEvent.click(screen.getByRole('button', { name: '播放配音' }));
  await screen.findByRole('button', { name: '暂停配音' });
  setMedia(audio, { currentTime: 0.2 });
  act(() => {
    fireEvent.timeUpdate(audio);
  });
  await waitFor(() => expect(document.querySelector('.script-char.now')?.textContent).toBe('你'));
  // 点后面的字从那里接着放。
  const chars = document.querySelectorAll<HTMLElement>('.script-char');
  expect(chars).toHaveLength(4);
  fireEvent.click(chars[3]);
  expect(audio.currentTime).toBe(Number(chars[3].dataset.start));
  await waitFor(() => expect(document.querySelector('.script-char.now')?.textContent).toBe('界'));
  expect(api.unmatched).toEqual([]);
});

test('reviews and seeks dialogue turns and opens role requests in the conversation', async () => {
  const onQuick = vi.fn();
  const api = mockApi({ '/api/script': { ...base, can_convert_to_dialogue: true } });
  const props = { busy: '', onQuick, onFile: vi.fn(), onAttach: vi.fn() };
  const { rerender } = render(<ScriptTab version={1} {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '改为多人对话' }));
  expect(onQuick).toHaveBeenLastCalledWith(expect.stringContaining('等我确认'), [], true);

  api.set('/api/script', {
    ...withAudio('production/audio/voice.wav'),
    dialogue: { provider: 'edge', roles: [{ id: 'host', name: '主持人', voice_id: 'voice-a' }] },
    blocks: [{ ...base.blocks![0], speaker: 'host', time: { start: 2, end: 3 } }],
    voice: { ...withAudio('production/audio/voice.wav').voice!, timing: 'dialogue', seconds: 3 },
  });
  rerender(<ScriptTab version={2} {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '为主持人换音色' }));
  expect(onQuick).toHaveBeenLastCalledWith(expect.stringContaining('host'), [], true);
  const audio = audioElement();
  setMedia(audio, { readyState: 4 });
  const turn = screen.getByRole('button', { name: '从主持人的这句开始播放' });
  fireEvent.click(turn);
  expect(audio.currentTime).toBe(2);
  expect(turn.closest('p')?.getAttribute('aria-current')).toBe('true');
});

test('original drafts offer dialogue conversion without offering voice approval', async () => {
  mockApi({ '/api/script': { ...base, final: false, gate: { id: 'script:approved' }, can_convert_to_dialogue: true } });
  render(<ScriptTab version={1} busy="" onQuick={vi.fn()} onFile={vi.fn()} onAttach={vi.fn()} />);
  await screen.findByRole('button', { name: '改为多人对话' });
  expect(screen.queryByRole('button', { name: '确认，开始配音' })).toBeNull();
});

test('uses server-provided timings for subtitled and segmented playback without falling back to linear estimation', async () => {
  const timedBlocks: ScriptResponse['blocks'] = [
    {
      kind: 'para',
      nodes: [
        {
          kind: 'text',
          text: '你好世界',
          timings: [
            { start: 0.5, end: 1.0 },
            { start: 1.0, end: 1.5 },
            { start: 5.0, end: 6.0 },
            { start: 6.0, end: 7.0 },
          ],
        },
      ],
    },
  ];
  const api = mockApi({
    '/api/script': {
      ...withAudio('production/audio/voice.wav'),
      blocks: timedBlocks,
      voice: { ...withAudio('production/audio/voice.wav').voice!, seconds: 10, timing: 'subtitled' },
    },
  });
  const props = { busy: '', onQuick: vi.fn(), onFile: vi.fn(), onAttach: vi.fn() };
  const { rerender } = render(<ScriptTab version={1} {...props} />);
  await screen.findByText(/按字幕逐句跟读/);
  const audio = audioElement();
  setMedia(audio, { duration: 10, currentTime: 5.2, readyState: 4 });
  act(() => {
    fireEvent.loadedMetadata(audio);
    fireEvent.timeUpdate(audio);
  });
  // 如果误退回线性估算（10s/4字 = 2.5s/字），5.2s 会亮「世」但 data-start 会被改成 5；这里检查第 2 字起点仍保持后端给的 1.0 而非 2.5。
  const chars = document.querySelectorAll<HTMLElement>('.script-char');
  expect(Number(chars[1].dataset.start)).toBe(1);
  expect(document.querySelector('.script-char.now')?.textContent).toBe('世');

  api.set('/api/script', {
    ...withAudio('production/audio/voice.wav'),
    blocks: timedBlocks,
    voice: { ...withAudio('production/audio/voice.wav').voice!, seconds: 10, timing: 'segmented' },
  });
  rerender(<ScriptTab version={2} {...props} />);
  await screen.findByText(/按配音段落跟读/);
  expect(Number(document.querySelectorAll<HTMLElement>('.script-char')[1].dataset.start)).toBe(1);
});
