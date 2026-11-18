// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../testing';
import type { Attachment } from '../types';
import { idleActivity, renderPreview, sceneRow } from './previewTesting';

// 镜头页：方向键逐帧、在画面上直接拖出选区并带进对话、「⋯」菜单。
// jsdom 不解码视频，画面换成一段 1 秒、30 帧、320×180 的假视频：改 currentTime 时像浏览器一样派发 seeked。
// 菜单「挂到 body、不被外层裁掉、不被时间线盖住」要真实排版，留在 e2e（content.spec.mjs）。

const scene = sceneRow('scene-001', { exists: true });

function setup() {
  const api = mockApi({
    '/api/storyboard': { gate: null, plan_path: '', installed_styles: [], scenes: [] },
    '/api/film-style': { installed: false },
    '/api/scenes/scene-001/activity': idleActivity('scene-001'),
    'POST /api/scenes/scene-001/attachment': (req: { body: unknown }) => ({ scene_id: 'scene-001', path: 'production/studio/frames/scene-001.png', ...(req.body as object) }),
  });
  const view = renderPreview('scene', [scene]);
  const video = view.container.querySelector('video:not(.thumb)') as HTMLVideoElement;
  let time = 0;
  Object.defineProperties(video, {
    duration: { configurable: true, get: () => 1 },
    videoWidth: { configurable: true, get: () => 320 },
    videoHeight: { configurable: true, get: () => 180 },
    clientWidth: { configurable: true, get: () => 320 },
    clientHeight: { configurable: true, get: () => 180 },
    currentTime: {
      configurable: true,
      get: () => time,
      set: (v: number) => {
        time = v;
        video.dispatchEvent(new Event('seeked'));
      },
    },
  });
  const play = vi.spyOn(video, 'play');
  fireEvent.loadedMetadata(video);
  return { api, video, play, ...view };
}

const frame = (container: HTMLElement) => [...container.querySelectorAll('.transport span')].find((s) => s.textContent!.startsWith('帧'))!.textContent;

/** 在选区层上按下、拖动、松手（坐标相对画面左上角；层的 getBoundingClientRect 在 jsdom 里是 0）。 */
function drag(layer: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(layer, { button: 0, buttons: 1, pointerId: 1, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(layer, { buttons: 1, pointerId: 1, clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 });
  fireEvent.pointerMove(layer, { buttons: 1, pointerId: 1, clientX: to[0], clientY: to[1] });
}

function release(layer: Element, at: [number, number]) {
  fireEvent.pointerUp(layer, { button: 0, buttons: 0, pointerId: 1, clientX: at[0], clientY: at[1] });
}

beforeEach(() => {
  Element.prototype.setPointerCapture ??= function () {};
});

afterEach(() => vi.restoreAllMocks());

it('keeps the review and the review action tied to the selected film across tabs', async () => {
  const final = 'production/final.mp4';
  const candidate = 'production/audio/candidate.mp4';
  const sheet = 'production/review-final/sheet-01.png';
  const report = {
    available: true, path: final, report_dir: 'production/review-final',
    report: { problems: ['成片的检查结论'], sheets: [{ image: sheet }] },
  };
  const api = mockApi({ '/api/review': report });
  const tree = [final, candidate, sheet].map((path) => ({ path, size: 1, mtime: 1 }));
  const view = renderPreview('final', [], '', tree);
  expect(await screen.findByRole('button', { name: '1 个问题，去看' })).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: '配音合成版' }));
  expect(await screen.findByText('该报告不是针对当前文件。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '1 个问题，去看' })).toBeNull();
  expect(screen.queryByRole('button', { name: '确认可用，去发布' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '复查' }));
  expect(view.props.run).toHaveBeenLastCalledWith('/api/review/run', { video: candidate });

  view.show('review');
  expect(await screen.findByText('该报告不是针对当前文件。')).toBeTruthy();
  expect(screen.queryByText('成片的检查结论')).toBeNull();
  expect(screen.queryByText('sheet-01.png')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '运行复查' }));
  expect(view.props.run).toHaveBeenLastCalledWith('/api/review/run', { video: candidate });

  await userEvent.click(screen.getByRole('button', { name: '成片' }));
  expect(await screen.findByText('成片的检查结论')).toBeTruthy();
  expect(screen.getByText('sheet-01.png')).toBeTruthy();
  expect(api.calls.filter((call) => call.path === '/api/review').map((call) => call.query.get('video'))).toEqual([final, candidate, final]);
});

it('distinguishes same-named films and hides the approval during report refresh', async () => {
  const final = 'final.mp4';
  const video_sha256 = 'a'.repeat(64);
  const report = { available: true, path: final, can_approve: true, report: { ok: true, problems: [], video_sha256 } };
  let deliver!: (value: unknown) => void;
  const pending = new Promise((resolve) => { deliver = resolve; });
  let requests = 0;
  mockApi({ '/api/review': () => ++requests === 1 ? report : pending });
  const tree = [final, 'production/final.mp4'].map((path) => ({ path, size: 1, mtime: 1 }));
  const view = renderPreview('final', [], '', tree);
  expect(screen.getByRole('button', { name: '成片 · final.mp4' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '成片 · production/final.mp4' })).toBeTruthy();
  const approve = { name: '确认可用，去发布' };
  await userEvent.click(await screen.findByRole('button', approve));
  expect(view.props.run).toHaveBeenCalledWith('/api/memory/actions/consolidate', { final: true, video: final, video_sha256 }, expect.any(Function));
  expect(view.props.onTab).not.toHaveBeenCalled();
  view.props.run.mock.calls[0][2]();
  expect(view.props.onTab).toHaveBeenCalledWith('publish');
  await userEvent.click(screen.getByRole('button', { name: '成片 · production/final.mp4' }));
  await userEvent.click(screen.getByRole('button', { name: '成片 · final.mp4' }));
  expect(screen.queryByRole('button', approve)).toBeNull();
  view.show('final', '', 2);
  expect(screen.queryByRole('button', approve)).toBeNull();
  await act(async () => deliver({ ...report, can_approve: false, report: { ok: false, problems: ['复查未通过'] } }));
  expect(await screen.findByRole('button', { name: '1 个问题，去看' })).toBeTruthy();
  expect(screen.queryByRole('button', approve)).toBeNull();
});

it('shows an unbound legacy report as read-only even when the video is absent', async () => {
  mockApi({ '/api/review': { available: true, path: null, unbound: true, report: { problems: ['旧报告的问题'] } } });
  renderPreview('review', []);
  expect(await screen.findByText('旧报告的问题')).toBeTruthy();
  expect(screen.getByText('这份旧报告未绑定影片，仅供查看。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '确认可用，去发布' })).toBeNull();
});

describe('镜头页', () => {
  it('方向键逐帧，Shift 一次 10 帧；输入框里的方向键不动画面', async () => {
    const { container } = setup();
    expect(frame(container)).toBe('帧 0 / 30');
    for (let i = 0; i < 3; i++) await userEvent.keyboard('{ArrowRight}');
    expect(frame(container)).toBe('帧 3 / 30');
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(frame(container)).toBe('帧 13 / 30');
    await userEvent.keyboard('{ArrowLeft}');
    expect(frame(container)).toBe('帧 12 / 30');
    // 输入框里的方向键照常移光标，不动画面（对话输入框、菜单里的反馈说明都一样）。
    const input = document.body.appendChild(document.createElement('textarea'));
    input.value = 'abc';
    input.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(frame(container)).toBe('帧 12 / 30');
    input.remove();
  });

  it('在画面上拖出选区，点一下清掉、Esc 取消，「说说这里…」带着这一帧和选区填进输入框', async () => {
    const { container, play, props, api } = setup();
    const layer = container.querySelector('.select-layer')!;
    // 不用先进「圈选模式」：按下、拖动就是一块选区；松手之前不出工具条。
    drag(layer, [96, 54], [160, 81]);
    expect(container.querySelector('.select-box')).toBeTruthy();
    expect(container.querySelector('.selection-bar')).toBeNull();
    release(layer, [160, 81]);
    expect(container.querySelector('.selection-bar')).toBeTruthy();
    // 点一下画面：清掉选区，不播放。
    fireEvent.pointerDown(layer, { button: 0, buttons: 1, pointerId: 1, clientX: 20, clientY: 20 });
    release(layer, [20, 20]);
    expect(container.querySelector('.select-box')).toBeNull();
    expect(play).not.toHaveBeenCalled();
    // 再圈一次，Esc 取消。
    drag(layer, [96, 54], [160, 81]);
    release(layer, [160, 81]);
    await userEvent.keyboard('{Escape}');
    expect(container.querySelector('.selection-bar')).toBeNull();
    // 再圈，「说说这里…」把这一帧和选区带进输入框，等用户说哪里不对。
    drag(layer, [96, 54], [160, 81]);
    release(layer, [160, 81]);
    await userEvent.click(screen.getByRole('button', { name: '说说这里…' }));
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ seconds: 0, region: { x: 96, y: 54, w: 64, h: 27 } });
    await vi.waitFor(() => expect(props.onQuick).toHaveBeenCalled());
    const [text, attachments, draftOnly] = props.onQuick.mock.calls[0] as [string, Attachment[], boolean];
    expect(text).toBe('镜头 scene-001 圈出的这块：');
    expect(attachments).toEqual([expect.objectContaining({ scene_id: 'scene-001', region: { x: 96, y: 54, w: 64, h: 27 } })]);
    expect(draftOnly).toBe(true);
    expect(container.querySelector('.selection-bar')).toBeNull();
    expect(api.unmatched).toEqual([]);
  });

  it('「⋯」菜单挂到 body 上，放不下就往上开；菜单里输入不收起，点外面收起；从这里进试镜', async () => {
    const { container, props } = setup();
    const summary = container.querySelector<HTMLElement>('.scene-menu > summary')!;
    // 按钮贴近窗口底部：下面放不下，菜单往上开，高度限在上方的空间里。
    vi.spyOn(summary, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 900, y: 580, width: 32, height: 32 }));
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(640);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1100);
    await userEvent.click(summary);
    const body = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('.scene-menu-body');
      if (!el) throw new Error('菜单还没出现');
      return el;
    });
    expect(container.contains(body)).toBe(false);
    expect(body.parentElement).toBe(document.body);
    expect(body.style.bottom).toBe(`${640 - 580 + 8}px`);
    expect(body.style.top).toBe('');
    expect(body.style.maxHeight).toBe(`${580 - 8 - 12}px`);
    expect(body.style.right).toBe(`${1100 - 932}px`);
    // 菜单里的输入不算点外面。
    await userEvent.type(within(body).getByRole('textbox', { name: '反馈说明' }), '保留这个镜头');
    expect(container.querySelector<HTMLDetailsElement>('.scene-menu')!.open).toBe(true);
    // 点外面收起。
    await userEvent.click(container.querySelector('.scene-title')!);
    expect(container.querySelector<HTMLDetailsElement>('.scene-menu')!.open).toBe(false);
    await vi.waitFor(() => expect(document.querySelector('.scene-menu-body')).toBeNull());

    // 按钮在上面：往下开。试镜从菜单进去。
    vi.spyOn(summary, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 900, y: 40, width: 32, height: 32 }));
    await userEvent.click(summary);
    const below = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('.scene-menu-body');
      if (!el) throw new Error('菜单还没出现');
      return el;
    });
    expect(below.style.top).toBe(`${72 + 8}px`);
    await act(async () => {
      fireEvent.click(below.querySelector('#audition-scene')!);
    });
    expect(props.onTab).toHaveBeenCalledWith('audition');
    expect(container.querySelector<HTMLDetailsElement>('.scene-menu')!.open).toBe(false);
  });
});
