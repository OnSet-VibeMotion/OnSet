// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../testing';
import type { Attachment } from '../types';
import { idleActivity, renderPreview, sceneRow } from './previewTesting';

const scene = sceneRow('scene-001', { exists: true, duration_seconds: 4 });
const tree = [{ path: 'scenes/scene-001/index.html', size: 1200, mtime: 100 }];

function mountIframeContent(iframe: HTMLIFrameElement) {
  const doc = document.implementation.createHTMLDocument('scene');
  doc.body.innerHTML = `
    <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="4">
      <div id="headline">
        <span id="text-0-char-1" style="color: rgb(20, 40, 60); font-size: 48px;">富</span>
      </div>
      <div id="timeline-bar" style="background-color: rgb(31, 155, 233);"></div>
    </div>
  `;
  const charEl = doc.getElementById('text-0-char-1')!;
  const headlineEl = doc.getElementById('headline')!;
  const barEl = doc.getElementById('timeline-bar')!;
  vi.spyOn(charEl, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 300, y: 120, width: 60, height: 60 }));
  vi.spyOn(headlineEl, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 280, y: 110, width: 240, height: 80 }));
  vi.spyOn(barEl, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 180, y: 100, width: 6, height: 500 }));
  const seek = vi.fn();
  const fakeWin = {
    __hf: { seek },
    HTMLElement,
    SVGElement,
    getComputedStyle: (el: Element) => {
      if (el === barEl) return { color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(31, 155, 233)', fontSize: '16px', opacity: '1', visibility: 'visible', display: 'block' } as CSSStyleDeclaration;
      return { color: 'rgb(20, 40, 60)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '48px', opacity: '1', visibility: 'visible', display: 'block' } as CSSStyleDeclaration;
    },
  };
  Object.defineProperty(doc, 'defaultView', { configurable: true, get: () => fakeWin });
  (doc as Document & { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = (x: number) => {
    if (x < 220) return [barEl, doc.getElementById('root')!, doc.body];
    return [charEl, headlineEl, doc.getElementById('root')!, doc.body];
  };
  Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => doc });
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fakeWin });
  fireEvent.load(iframe);
  return { doc, seek, charEl, headlineEl, barEl };
}

beforeEach(() => {
  Element.prototype.setPointerCapture ??= function () {};
});

afterEach(() => vi.restoreAllMocks());

describe('镜头页 HTML 可视化编辑', () => {
  it('原地切入 HTML 编辑模式，同步视频帧，支持 AI 编辑与属性调整，且不暴露 HTML 源码编辑器', async () => {
    let savedBody: unknown = null;
    const api = mockApi({
      '/api/storyboard': { gate: null, plan_path: '', installed_styles: [], scenes: [] },
      '/api/film-style': { installed: false },
      '/api/scenes/scene-001/activity': idleActivity('scene-001'),
      '/api/scenes/scene-001/edits': { has_html: true, edits: { schema: 1, elements: {} } },
      'PUT /api/scenes/scene-001/edits': (req: { body: unknown }) => {
        savedBody = req.body;
        const b = req.body as { edits: unknown };
        return { edits: b.edits };
      },
      'POST /api/scenes/scene-001/attachment': (req: { body: unknown }) => ({
        scene_id: 'scene-001',
        path: 'production/studio/attachments/scene-001-a1.png',
        ...(req.body as object),
      }),
    });

    const view = renderPreview('scene', [scene], 'scene-001', tree);
    const video = view.container.querySelector('video:not(.thumb)') as HTMLVideoElement;
    let time = 1.5;
    Object.defineProperties(video, {
      duration: { configurable: true, get: () => 4 },
      currentTime: { configurable: true, get: () => time, set: (v: number) => { time = v; } },
    });
    fireEvent.loadedMetadata(video);
    fireEvent.timeUpdate(video);

    // 点击「编辑画面」切入 HTML 视图。
    await userEvent.click(view.container.querySelector('#enter-html-edit')!);
    const iframe = await vi.waitFor(() => {
      const el = view.container.querySelector<HTMLIFrameElement>('iframe.se-iframe');
      if (!el) throw new Error('iframe 还没挂载');
      return el;
    });
    const stage = view.container.querySelector<HTMLDivElement>('.se-stage')!;
    Object.defineProperties(stage, { clientWidth: { configurable: true, get: () => 640 }, clientHeight: { configurable: true, get: () => 360 } });
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 360 }));

    const { doc, seek } = mountIframeContent(iframe);
    expect(seek).toHaveBeenCalledWith(1.5);
    // 顶部有「退出编辑」，没有任何 HTML 源码编辑框。
    expect(screen.getByRole('button', { name: '退出编辑' })).toBeTruthy();
    expect(view.container.querySelector('code.html-source, textarea.html-source')).toBeNull();

    // 点选画布上的文字元素 #text-0-char-1。
    const interact = view.container.querySelector('.se-interact')!;
    fireEvent.pointerDown(interact, { button: 0, clientX: 120, clientY: 50 });

    const dialog = await screen.findByRole('dialog', { name: '元素编辑面板' });
    expect(within(dialog).getByText('#text-0-char-1')).toBeTruthy();

    // 点「↑ 选父级」切到外层 #headline。
    await userEvent.click(within(dialog).getByRole('button', { name: '↑ 选父级' }));
    expect(within(dialog).getByText('#headline')).toBeTruthy();

    // 在「AI 编辑」输入修改意见并发送，自动带入选择器、index.html 路径与截图。
    await userEvent.type(within(dialog).getByLabelText('AI 编辑说明'), '把标题改成暖金色并加一点弹跳感');
    await userEvent.click(within(dialog).getByRole('button', { name: '发送 AI 编辑' }));
    await vi.waitFor(() => expect(view.props.onQuick).toHaveBeenCalled());
    const [promptText, attachments, draftOnly] = view.props.onQuick.mock.calls[0] as [string, Attachment[], boolean];
    expect(promptText).toContain('#headline');
    expect(promptText).toContain('暖金色');
    expect(draftOnly).toBe(false);
    expect(attachments).toEqual([
      expect.objectContaining({
        scene_id: 'scene-001',
        selector: '#headline',
        source: 'scenes/scene-001/index.html',
        seconds: 1.5,
        path: 'production/studio/attachments/scene-001-a1.png',
      }),
    ]);

    // 点选竖线元素 #timeline-bar，切到「属性调整」修改背景色并点击「应用修改」。
    fireEvent.pointerDown(interact, { button: 0, clientX: 60, clientY: 80 });
    const barDialog = await screen.findByRole('dialog', { name: '元素编辑面板' });
    await userEvent.click(within(barDialog).getByRole('tab', { name: /属性调整/ }));
    const bgInput = within(barDialog).getByLabelText('背景色值') as HTMLInputElement;
    expect(bgInput.value).toBe('rgb(31, 155, 233)');
    await userEvent.clear(bgInput);
    await userEvent.type(bgInput, '#ff6600');

    // 实时预览样式已经注入 iframe。
    expect(doc.getElementById('onset-edits-live')?.textContent).toContain('background-color: #ff6600 !important');

    await userEvent.click(within(barDialog).getByRole('button', { name: /应用修改/ }));
    await vi.waitFor(() => expect(savedBody).not.toBeNull());
    expect(savedBody).toEqual({
      edits: {
        schema: 1,
        elements: { '#timeline-bar': { selector: '#timeline-bar', backgroundColor: '#ff6600' } },
      },
      encode: false,
    });
    expect(view.props.run).toHaveBeenCalledWith('/api/scenes/scene-001/encode', {}, expect.any(Function));

    // 点「退出编辑」切回视频播放器。
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '退出编辑' }));
    });
    expect(view.container.querySelector('video:not(.thumb)')).toBeTruthy();
    expect(api.unmatched).toEqual([]);
  });

  it('支持删除元素、撤销与未保存退出确认', async () => {
    mockApi({
      '/api/storyboard': { gate: null, plan_path: '', installed_styles: [], scenes: [] },
      '/api/film-style': { installed: false },
      '/api/scenes/scene-001/activity': idleActivity('scene-001'),
      '/api/scenes/scene-001/edits': { has_html: true, edits: { schema: 1, elements: {} } },
    });

    const view = renderPreview('scene', [scene], 'scene-001', tree);
    await userEvent.click(view.container.querySelector('#enter-html-edit')!);
    const iframe = await vi.waitFor(() => {
      const el = view.container.querySelector<HTMLIFrameElement>('iframe.se-iframe');
      if (!el) throw new Error('iframe 还没挂载');
      return el;
    });
    const stage = view.container.querySelector<HTMLDivElement>('.se-stage')!;
    Object.defineProperties(stage, { clientWidth: { configurable: true, get: () => 640 }, clientHeight: { configurable: true, get: () => 360 } });
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 360 }));
    const { doc } = mountIframeContent(iframe);

    // 选中竖线并点击删除图标隐藏它。
    const interact = view.container.querySelector('.se-interact')!;
    fireEvent.pointerDown(interact, { button: 0, clientX: 60, clientY: 80 });
    const dialog = await screen.findByRole('dialog', { name: '元素编辑面板' });
    await userEvent.click(within(dialog).getByRole('button', { name: '删除元素' }));
    expect(doc.getElementById('onset-edits-live')?.textContent).toContain('display: none !important');

    // 有未保存改动时点「退出编辑」弹出确认，点「继续编辑」留下，再点「撤销」恢复。
    await userEvent.click(screen.getByRole('button', { name: '退出编辑' }));
    expect(screen.getByText('有未应用的修改')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    await userEvent.click(screen.getByRole('button', { name: /撤销/ }));
    expect(doc.getElementById('onset-edits-live')?.textContent ?? '').not.toContain('display: none');
    // 撤销后不再有未保存改动，点「退出编辑」直接回到视频。
    await userEvent.click(screen.getByRole('button', { name: '退出编辑' }));
    expect(view.container.querySelector('video:not(.thumb)')).toBeTruthy();
  });
});
