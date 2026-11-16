// @vitest-environment jsdom
/*
 * 回复里的试听（Chat.tsx 的 MediaStrip）与全局的「同一时间只放一段」（media.ts 的 installExclusiveAudioPlayback）：
 * 对话里的几段试听、后来才挂上的文件页播放器、静音的视频预览、音色页的隐藏播放器之间互斥，切走不重置进度。
 * 原来在 e2e/audio-playback.spec.mjs。jsdom 不解码音频：播放器换成只记状态、照常发 play / pause / volumechange 事件的假实现。
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installExclusiveAudioPlayback } from '../../media';
import { createStudio, findEl, session, turnDone, turnStart } from './studioHarness';
import type { TreeFile, VoiceEntry, VoiceLibrary } from '../../types';

/** 只记状态的播放器：play / pause / 取消静音照浏览器的样子发事件，排他逻辑听的就是这些事件。 */
function fakeMedia() {
  type Media = { paused: boolean; time: number; muted: boolean };
  const states = new WeakMap<HTMLMediaElement, Media>();
  const of = (el: HTMLMediaElement) => {
    let state = states.get(el);
    if (!state) states.set(el, (state = { paused: true, time: 0, muted: el.hasAttribute('muted') }));
    return state;
  };
  const proto = HTMLMediaElement.prototype;
  const keys = ['paused', 'currentTime', 'muted', 'volume', 'ended', 'play', 'pause'] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  Object.defineProperties(proto, {
    paused: { configurable: true, get(this: HTMLMediaElement) { return of(this).paused; } },
    ended: { configurable: true, get() { return false; } },
    volume: { configurable: true, get() { return 1; }, set() {} },
    currentTime: { configurable: true, get(this: HTMLMediaElement) { return of(this).time; }, set(this: HTMLMediaElement, value: number) { of(this).time = value; } },
    muted: {
      configurable: true,
      get(this: HTMLMediaElement) { return of(this).muted; },
      set(this: HTMLMediaElement, value: boolean) {
        if (of(this).muted === value) return;
        of(this).muted = value;
        this.dispatchEvent(new Event('volumechange'));
      },
    },
    play: {
      configurable: true,
      value(this: HTMLMediaElement) {
        if (of(this).paused) {
          of(this).paused = false;
          this.dispatchEvent(new Event('play'));
        }
        return Promise.resolve();
      },
    },
    pause: {
      configurable: true,
      value(this: HTMLMediaElement) {
        if (!of(this).paused) {
          of(this).paused = true;
          this.dispatchEvent(new Event('pause'));
        }
      },
    },
  });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  };
}

const files = ['try-A.wav', 'try-B.wav', 'try-C.wav'].map((name) => 'production/audio/auditions/' + name);
const tree: TreeFile[] = [{ path: 'notes.md', size: 13, mtime: 1 }, ...files.map((path) => ({ path, size: 960_044, mtime: 5 }))];

/** 一轮已经结束的试听回复：第一段只写文件名、目录在前文另说，界面要能按项目文件树找到它。 */
function seedAuditions() {
  const studio = createStudio({ tree, sessions: [session('s-audio', { title: '音频试听', turns: ['t-audio'] })], open: 's-audio' });
  studio.seed(
    [
      ...turnStart('t-audio', '比较三段试听'),
      ...turnDone('t-audio', '试听在 `production/audio/auditions/` 里：\n\n' + files.map((file, index) => '`' + (index === 0 ? file.split('/').pop() : file) + '`').join('\n\n')),
    ],
    's-audio',
  );
  return studio;
}

const clips = () => [...document.querySelectorAll<HTMLAudioElement>('.media-strip audio')];
const paused = () => clips().map((el) => el.paused);
const play = (el: HTMLMediaElement) => act(() => void el.play());

describe('exclusive audio playback', () => {
  let restore = () => {};
  beforeAll(() => {
    restore = fakeMedia();
    installExclusiveAudioPlayback();
  });
  afterAll(() => restore());

  test('switches chat auditions and the file preview without resetting progress', async () => {
    const studio = seedAuditions();
    studio.render();
    await waitFor(() => expect(clips()).toHaveLength(3));
    expect(document.querySelector('.media-strip .media-item.audio')?.textContent).toContain('try-A.wav');
    expect(clips()[0].getAttribute('src')).toMatch(/production%2Faudio%2Fauditions%2Ftry-A\.wav/);
    // 原生播放控件的「⋮」菜单里不出现「下载」与「投放」。
    expect(clips()[0].controls).toBe(true);
    expect(clips()[0].getAttribute('controlslist')?.split(' ')).toEqual(['nodownload', 'noremoteplayback']);

    clips()[0].currentTime = 2;
    play(clips()[0]);
    expect(paused()).toEqual([false, true, true]);
    play(clips()[1]);
    expect(paused()).toEqual([true, false, true]);
    const savedPosition = clips()[0].currentTime;
    expect(savedPosition).toBeGreaterThanOrEqual(2);
    play(clips()[2]);
    expect(paused()).toEqual([true, true, false]);
    expect(clips()[0].currentTime).toBe(savedPosition);
    play(clips()[0]);
    expect(paused()).toEqual([false, true, true]);
    expect(clips()[0].currentTime).toBeGreaterThanOrEqual(savedPosition);

    // 文件页的播放器后来才挂载，也与聊天里的试听互斥。
    await userEvent.setup().click([...document.querySelectorAll<HTMLElement>('.media-name')].find((el) => el.textContent === 'try-B.wav')!);
    const preview = await findEl<HTMLAudioElement>('.file-tab audio');
    play(preview);
    expect(paused()).toEqual([true, true, true]);
    expect(preview.paused).toBe(false);
    play(clips()[2]);
    expect(preview.paused).toBe(true);
    expect(paused()).toEqual([true, true, false]);

    // 静音的视频预览不打断试听；取消静音后接过声音，试听再播又把它停下。
    const clip = clips()[0];
    play(clip);
    expect(paused()).toEqual([false, true, true]);
    const video = document.createElement('video');
    video.muted = true;
    video.src = clip.src;
    document.body.append(video);
    play(video);
    expect(clip.paused).toBe(false);
    act(() => { video.muted = false; });
    expect(clip.paused).toBe(true);
    expect(video.paused).toBe(false);
    play(clip);
    expect(video.paused).toBe(true);
    video.remove();
    expect(studio.api.unmatched).toEqual([]);
  });

  test('syncs hidden voice player buttons when a chat audition interrupts them', async () => {
    const voice = (name: string): VoiceEntry => ({
      name, text: '试听音色', source: 'uploaded', instruction: '', duration_seconds: 20, created: '2026-11-17T00:00:00Z', is_default: false,
    });
    const library: VoiceLibrary = {
      dir: '/Users/me/.local/share/onset/voices',
      default: '',
      voices: [voice('音色甲'), voice('音色乙')],
      sample_text: '今天天气不错。',
      design: { ready: false, supported: true, problem: '', install_id: 'voice:breeze' },
    };
    const studio = seedAuditions();
    studio.api.set('/api/voices', library);
    // 波形要解码参考音频：jsdom 里解不了，页面照样画按钮与文字稿。
    for (const v of library.voices) studio.api.set(`/api/voices/${encodeURIComponent(v.name)}/reference.wav`, {});
    studio.render();
    await waitFor(() => expect(clips()).toHaveLength(3));
    const user = userEvent.setup();
    await user.click(document.getElementById('page-menu-trigger')!);
    await user.click(document.querySelector('.page-menu-list [data-tab="voice"]') as HTMLElement);
    await waitFor(() => expect(document.querySelectorAll('.voices-tab .voice')).toHaveLength(2));
    const button = (index: number) => document.querySelectorAll<HTMLElement>('.voices-tab .voice')[index].querySelector('.voice-play') as HTMLElement;
    const hidden = document.querySelector('.voices-tab > audio') as HTMLAudioElement;

    await user.click(button(0));
    expect(button(0).className).toMatch(/armed/);
    expect(hidden.paused).toBe(false);
    await user.click(button(1));
    expect(button(0).className).not.toMatch(/armed/);
    expect(button(1).className).toMatch(/armed/);

    // 对话里的试听接过声音：隐藏播放器停下，按钮回到「试听」。
    play(clips()[0]);
    expect(hidden.paused).toBe(true);
    expect(button(1).className).not.toMatch(/armed/);
    expect(button(1).getAttribute('title')).toBe('试听');

    // 外部暂停后再点一次就能播放，不会先执行一次多余的「停止」。
    await user.click(button(1));
    expect(button(1).className).toMatch(/armed/);
    expect(hidden.paused).toBe(false);
    expect(paused()).toEqual([true, true, true]);
    expect(screen.queryByText('正在读取音色库…')).toBeNull();
    expect(studio.api.unmatched).toEqual([]);
  });
});
