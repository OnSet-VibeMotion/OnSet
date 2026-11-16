// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ExamCell } from '../types';
import { ExamPlayer } from './ExamPlayer';
import { examCell } from './memoryFixtures';

// 考试对照的两段画面：一个播放键两边同步、一条时间轴一起拖、口播只放一份并按冻结时间合同对齐。
// jsdom 不解码媒体，这里把 <video>/<audio> 换成只记状态的假播放器：play/pause 像浏览器一样异步派发事件，
// 只核对接线（地址、谁在播、各自停在哪一秒），真实解码与出声留给真机。

interface FakeMedia {
  el: HTMLMediaElement;
  plays: number;
}

/** 让一个媒体元素有时长、可播放；play()/pause() 改状态并在下一个微任务派发 play/pause 事件。 */
function fake(el: HTMLMediaElement, duration: number): FakeMedia {
  const state = { paused: true, time: 0, src: el.getAttribute('src') ?? '' };
  const media: FakeMedia = { el, plays: 0 };
  Object.defineProperties(el, {
    paused: { configurable: true, get: () => state.paused },
    ended: { configurable: true, get: () => false },
    duration: { configurable: true, get: () => duration },
    currentTime: {
      configurable: true,
      get: () => state.time,
      set: (v: number) => {
        state.time = v;
      },
    },
    src: {
      configurable: true,
      get: () => state.src,
      set: (v: string) => {
        state.src = v;
      },
    },
  });
  el.play = () => {
    media.plays++;
    state.paused = false;
    queueMicrotask(() => el.dispatchEvent(new Event('play')));
    return Promise.resolve();
  };
  el.pause = () => {
    if (state.paused) return;
    state.paused = true;
    queueMicrotask(() => el.dispatchEvent(new Event('pause')));
  };
  return media;
}

const narration = (over: Partial<NonNullable<ExamCell['preview_audio']>> = {}): ExamCell['preview_audio'] => ({
  url: '/api/memory/exams/exam-0001/audio?question=q1&renderer=claude&arm=control&repeat=1',
  start_seconds: 0.5,
  duration_seconds: 5,
  label: '来源项目口播',
  source_project: 'earlier-video-project',
  ...over,
});

function setup() {
  // 无声镜头按冻结时间合同叠加来源项目的口播：镜头从全片 0.5 秒起。
  const control = examCell('control', true, { audio_unavailable: undefined, preview_video: { url: '/api/memory/exams/exam-0001/video?arm=control', source_project: 'earlier-video-project' }, preview_audio: narration() });
  const trial = examCell('trial', false, {
    problems: 1,
    checks: ['reads.duration'],
    audio_unavailable: undefined,
    preview_video: { url: '/api/memory/exams/exam-0001/video?arm=trial', source_project: 'earlier-video-project' },
    preview_audio: narration({ url: '/api/memory/exams/exam-0001/audio?question=q1&renderer=claude&arm=trial&repeat=1' }),
  });
  const view = render(<ExamPlayer control={control} trial={trial} labels={{ 'reads.duration': '文字停留太短，读不完' }} version={3} />);
  const [left, right] = [...view.container.querySelectorAll('video')].map((v) => fake(v, 3));
  const audio = fake(view.container.querySelector('.exam-player > audio')!, 5);
  for (const v of [left, right]) fireEvent.loadedMetadata(v.el);
  return { ...view, left, right, audio };
}

const flush = () => act(async () => {});

describe('考试对照播放器', () => {
  it('两段画面用各自的考场地址，带播放器控件，只有一份口播', () => {
    const { container, left, right } = setup();
    expect(left.el.getAttribute('src')).toBe('/api/memory/exams/exam-0001/video?arm=control&v=3');
    expect(right.el.getAttribute('src')).toBe('/api/memory/exams/exam-0001/video?arm=trial&v=3');
    expect(container.querySelectorAll('video[controls]')).toHaveLength(2);
    expect(container.querySelectorAll('audio')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '配音已开启' })).toBeTruthy();
    expect(container.querySelector('.exam-audio-controls')!.textContent).toContain('earlier-video-project');
    expect(container.querySelector('.evidence-side.trial')!.textContent).toContain('文字停留太短，读不完');
  });

  it('一起播放、一起暂停，拖时间轴两边一起跳，口播跟着对齐到起点之后', async () => {
    const { left, right, audio } = setup();
    await userEvent.click(screen.getByRole('button', { name: '回到开头' }));
    await userEvent.click(screen.getByRole('button', { name: '两边一起播放' }));
    await flush();
    expect(left.el.paused).toBe(false);
    expect(right.el.paused).toBe(false);
    // 口播从来源项目的地址载入，起点是镜头在全片里的 0.5 秒。
    expect(audio.el.src).toBe('/api/memory/exams/exam-0001/audio?question=q1&renderer=claude&arm=control&repeat=1&v=3');
    expect(audio.el.paused).toBe(false);
    expect(audio.el.currentTime).toBeCloseTo(0.5);
    expect(audio.el.muted).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: '暂停' }));
    await flush();
    expect([left.el.paused, right.el.paused, audio.el.paused]).toEqual([true, true, true]);

    fireEvent.change(screen.getByRole('slider', { name: '对照视频时间' }), { target: { value: '1' } });
    await flush();
    expect(left.el.currentTime).toBe(1);
    expect(right.el.currentTime).toBe(1);
    expect(audio.el.currentTime).toBeCloseTo(1.5);
    expect(audio.el.paused).toBe(true);
  });

  it('单侧原生播放也带口播；换到另一侧只留一份声音，旧一侧迟到的 play 不会停掉新的一侧', async () => {
    const { left, right, audio } = setup();
    // 先放左边。
    void left.el.play();
    await flush();
    expect(audio.el.paused).toBe(false);
    // 再放右边：左边被停下，它的 pause 事件还没送到时又迟到一个 play 事件（拖动后浏览器常这样）。
    void right.el.play();
    await Promise.resolve();
    left.el.dispatchEvent(new Event('play'));
    await flush();
    expect(left.el.paused).toBe(true);
    expect(right.el.paused).toBe(false);
    expect(audio.el.paused).toBe(false);
    expect(audio.el.src).toContain('arm=trial');
    // 拖右边自己的进度条：口播重新对齐。
    right.el.currentTime = 0.8;
    fireEvent.seeking(right.el);
    await flush();
    expect(audio.el.currentTime).toBeCloseTo(1.3);
    right.el.pause();
    await flush();
    expect(audio.el.paused).toBe(true);
  });

  it('配音能静音再打开', async () => {
    const { audio } = setup();
    await userEvent.click(screen.getByRole('button', { name: '配音已开启' }));
    expect(audio.el.muted).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '配音已静音' }));
    expect(audio.el.muted).toBe(false);
  });
});
