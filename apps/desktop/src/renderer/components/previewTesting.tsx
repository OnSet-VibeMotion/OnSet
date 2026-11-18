/*
 * 渲染 Preview 某一页的组件测试共用部分（只给 *.test.tsx 用）：一份最小的 Preview props，回调都是 vi.fn()。
 */
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { Scene, SceneActivity, TreeFile } from '../types';
import { Preview, type Tab } from './Preview';

export function sceneRow(id: string, over: Partial<Scene> = {}): Scene {
  return { id, directory: `scenes/${id}`, duration_seconds: 1, output: 'out.mp4', exists: false, stale: false, attempts: 0, ...over };
}

/** 镜头没在渲染、也没有渲染记录时 /api/scenes/{id}/activity 的回答。 */
export function idleActivity(id: string): SceneActivity {
  return { scene_id: id, rendering: false, step_count: 0, steps: [] };
}

export function renderPreview(tab: Tab, scenes: Scene[], sceneId = scenes[0]?.id ?? '', tree: TreeFile[] = []) {
  const props = {
    tab,
    state: null,
    scenes,
    usage: null,
    sceneId,
    filePath: '',
    tree,
    recent: new Set<string>(),
    version: 1,
    pages: [],
    progress: null,
    busy: '',
    onTab: vi.fn(),
    onAttach: vi.fn(),
    onQuick: vi.fn(),
    onFile: vi.fn(),
    onScene: vi.fn(),
    onTurn: vi.fn(),
    run: vi.fn(),
  };
  const view = render(<Preview {...props} />);
  return {
    ...view,
    props,
    show: (next: Tab, id = sceneId, version = props.version, files = tree) =>
      view.rerender(<Preview {...props} tab={next} sceneId={id} version={version} tree={files} />),
  };
}
