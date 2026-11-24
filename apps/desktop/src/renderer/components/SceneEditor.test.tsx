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

  it('切换镜头前拦截未保存改动、后台刷新保留草稿、取消混合内容文字编辑时恢复子节点、seek 后按当前帧动画透明度计算、且保存响应不覆盖后续输入', async () => {
    const scene2 = sceneRow('scene-002', { exists: true, duration_seconds: 3 });
    const twoTree = [
      { path: 'scenes/scene-001/index.html', size: 1200, mtime: 100 },
      { path: 'scenes/scene-002/index.html', size: 1200, mtime: 100 },
    ];
    let resolvePut: ((value: unknown) => void) | null = null;
    let putBody: unknown = null;
    mockApi({
      '/api/storyboard': { gate: null, plan_path: '', installed_styles: [], scenes: [] },
      '/api/film-style': { installed: false },
      '/api/scenes/scene-001/activity': idleActivity('scene-001'),
      '/api/scenes/scene-002/activity': idleActivity('scene-002'),
      '/api/scenes/scene-001/edits': { has_html: true, edits: { schema: 1, elements: {} } },
      '/api/scenes/scene-002/edits': { has_html: true, edits: { schema: 1, elements: {} } },
      'PUT /api/scenes/scene-001/edits': (req: { body: unknown }) => {
        putBody = req.body;
        return new Promise((resolve) => {
          resolvePut = resolve;
        });
      },
    });

    const view = renderPreview('scene', [scene, scene2], 'scene-001', twoTree);
    await userEvent.click(view.container.querySelector('#enter-html-edit')!);
    const iframe = await vi.waitFor(() => {
      const el = view.container.querySelector<HTMLIFrameElement>('iframe.se-iframe');
      if (!el) throw new Error('iframe 还没挂载');
      return el;
    });
    const stage = view.container.querySelector<HTMLDivElement>('.se-stage')!;
    Object.defineProperties(stage, { clientWidth: { configurable: true, get: () => 640 }, clientHeight: { configurable: true, get: () => 360 } });
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 360 }));

    // 构造混合内容与跨帧动画透明度的 iframe。
    const doc = document.implementation.createHTMLDocument('scene');
    doc.body.innerHTML = `
      <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="4">
        <div id="mixed">标题 <span id="em">强调文字</span></div>
        <div id="anim-box" style="opacity: 0.2; background-color: rgb(31, 155, 233);"></div>
      </div>
    `;
    const mixedEl = doc.getElementById('mixed')!;
    const emEl = doc.getElementById('em')!;
    const animEl = doc.getElementById('anim-box')!;
    vi.spyOn(mixedEl, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 300, y: 120, width: 200, height: 60 }));
    vi.spyOn(animEl, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 100, y: 120, width: 80, height: 80 }));
    const seek = vi.fn((t: number) => {
      animEl.style.opacity = t >= 1 ? '0.8' : '0.2';
    });
    const fakeWin = {
      __hf: { seek },
      HTMLElement,
      SVGElement,
      getComputedStyle: (el: Element) => ({
        color: 'rgb(20, 40, 60)',
        backgroundColor: el === animEl ? 'rgb(31, 155, 233)' : 'rgba(0, 0, 0, 0)',
        fontSize: '36px',
        opacity: (el as HTMLElement).style?.opacity || '1',
        visibility: 'visible',
        display: 'block',
      }) as CSSStyleDeclaration,
    };
    Object.defineProperty(doc, 'defaultView', { configurable: true, get: () => fakeWin });
    (doc as Document & { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = (x: number) => {
      if (x < 250) return [animEl, doc.getElementById('root')!, doc.body];
      return [mixedEl, doc.getElementById('root')!, doc.body];
    };
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => doc });
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fakeWin });
    fireEvent.load(iframe);

    // 1. 修改混合内容元素文字后点「取消」，原始 <span> 子节点必须完整恢复。
    const interact = view.container.querySelector('.se-interact')!;
    fireEvent.pointerDown(interact, { button: 0, clientX: 120, clientY: 50 });
    const mixedDialog = await screen.findByRole('dialog', { name: '元素编辑面板' });
    await userEvent.click(within(mixedDialog).getByRole('tab', { name: /属性调整/ }));
    const textInput = within(mixedDialog).getByLabelText('文字内容') as HTMLInputElement;
    await userEvent.clear(textInput);
    await userEvent.type(textInput, '临时文字');
    expect(mixedEl.textContent).toBe('临时文字');
    expect(doc.getElementById('em')).toBeNull();
    await userEvent.click(within(mixedDialog).getByRole('button', { name: '取消' }));
    expect(doc.getElementById('em')).toBe(emEl);
    expect(mixedEl.textContent).toContain('强调文字');

    // 2. 选中动画元素改透明度为 50%（原帧 0.2 → 0.1），seek 到 2s（新帧动画值 0.8 → 应为 0.4 而非 0.1）。
    fireEvent.pointerDown(interact, { button: 0, clientX: 50, clientY: 50 });
    const animDialog = await screen.findByRole('dialog', { name: '元素编辑面板' });
    await userEvent.click(within(animDialog).getByRole('tab', { name: /属性调整/ }));
    const opacityInput = within(animDialog).getByLabelText('不透明度') as HTMLInputElement;
    fireEvent.change(opacityInput, { target: { value: '50' } });
    expect(Number(animEl.style.opacity)).toBeCloseTo(0.1, 4);

    const scrubber = view.container.querySelector<HTMLInputElement>('input[type="range"][aria-label="播放位置"]')!;
    fireEvent.change(scrubber, { target: { value: '2' } });
    expect(Number(animEl.style.opacity)).toBeCloseTo(0.4, 4);

    // 3. 后台刷新（version 递增）时保留未应用草稿，不清空改动。
    view.show('scene', 'scene-001', 2, twoTree);
    await act(async () => {
      await Promise.resolve();
    });
    expect(Number(animEl.style.opacity)).toBeCloseTo(0.4, 4);

    // 4. 点时间线中的镜头 2 时弹出离开确认，不直接丢草稿；点「继续编辑」留下。
    const timeline = screen.getByRole('region', { name: '时间线' });
    const scene2Btn = within(timeline).getAllByRole('button')[1]!;
    await userEvent.click(scene2Btn);
    expect(view.props.onScene).not.toHaveBeenCalled();
    expect(screen.getByText('有未应用的修改')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '继续编辑' }));

    // 5. PUT 等待期间继续修改为 B（背景色 #123456），响应 A 返回后不能覆盖 B。
    await userEvent.click(within(animDialog).getByRole('button', { name: /应用修改/ }));
    await vi.waitFor(() => expect(putBody).toEqual({
      edits: { schema: 1, elements: { '#anim-box': { selector: '#anim-box', opacity: 0.5 } } },
      encode: false,
    }));
    const bgInput = within(animDialog).getByLabelText('背景色值') as HTMLInputElement;
    await userEvent.clear(bgInput);
    await userEvent.type(bgInput, '#123456');
    await act(async () => {
      resolvePut!({ edits: { schema: 1, elements: { '#anim-box': { selector: '#anim-box', opacity: 0.5 } } } });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(view.props.run).toHaveBeenCalledWith('/api/scenes/scene-001/encode', {}, expect.any(Function)));
    expect(doc.getElementById('onset-edits-live')?.textContent).toContain('background-color: #123456 !important');
    // 草稿仍有未保存修改，切镜确认后再点「放弃退出」应一次性切换镜头（不二次弹窗）。
    await userEvent.click(scene2Btn);
    expect(screen.getByText('有未应用的修改')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '放弃退出' }));
    expect(view.props.onScene).toHaveBeenCalledWith('scene-002');
  });

  it('重新打开已保存混合内容文字覆盖的镜头后，点恢复默认仍能还原子节点', async () => {
    mockApi({
      '/api/storyboard': { gate: null, plan_path: '', installed_styles: [], scenes: [] },
      '/api/film-style': { installed: false },
      '/api/scenes/scene-001/activity': idleActivity('scene-001'),
      '/api/scenes/scene-001/edits': {
        has_html: true,
        edits: { schema: 1, elements: { '#mixed': { selector: '#mixed', text: '已保存纯文本' } } },
      },
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

    const doc = document.implementation.createHTMLDocument('scene');
    doc.body.innerHTML = `<div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="4"><div id="mixed">标题 <span id="em">强调文字</span></div></div>`;
    const mixedEl = doc.getElementById('mixed')! as HTMLElement & { __onsetOrigNodes?: Node[] };
    const emEl = doc.getElementById('em')!;
    // 模拟落盘脚本在 iframe 加载时保存原节点再覆写 textContent。
    mixedEl.dataset.onsetOrigText = mixedEl.textContent ?? '';
    const savedNodes: Node[] = [];
    while (mixedEl.firstChild) savedNodes.push(mixedEl.removeChild(mixedEl.firstChild));
    mixedEl.__onsetOrigNodes = savedNodes;
    mixedEl.textContent = '已保存纯文本';

    vi.spyOn(mixedEl, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 300, y: 120, width: 200, height: 60 }));
    const fakeWin = {
      __hf: { seek: vi.fn() },
      HTMLElement,
      SVGElement,
      getComputedStyle: () => ({ color: 'rgb(20, 40, 60)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '36px', opacity: '1', visibility: 'visible', display: 'block' }) as CSSStyleDeclaration,
    };
    Object.defineProperty(doc, 'defaultView', { configurable: true, get: () => fakeWin });
    (doc as Document & { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [mixedEl, doc.getElementById('root')!, doc.body];
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => doc });
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fakeWin });
    fireEvent.load(iframe);

    // 等 GET edits 应用完成，点选混合元素并点击「恢复默认」。
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '重置全部' })).toBeTruthy());
    const interact = view.container.querySelector('.se-interact')!;
    fireEvent.pointerDown(interact, { button: 0, clientX: 120, clientY: 50 });
    const dialog = await screen.findByRole('dialog', { name: '元素编辑面板' });
    await userEvent.click(within(dialog).getByRole('tab', { name: /属性调整/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: '恢复默认' }));
    expect(doc.getElementById('em')).toBe(emEl);
    expect(mixedEl.textContent).toContain('强调文字');
  });
});
