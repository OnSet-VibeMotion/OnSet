import type { ReactNode } from 'react';
import type { Attachment } from '../types';
import { BeatBanner, BeatPage } from './Beat';
import type { RunAction } from './Preview';

/** 内置插件页面的组件拿到的东西：与宿主的页面同一组回调。 */
export interface PageViewProps {
  version: number;
  busy: string;
  run: RunAction;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  onScene: (id: string) => void;
  onTab?: (tab: string) => void;
}

/**
 * 内置插件登记的页面（后端 ctx.page，经 /api/state 的 pages 告诉界面有没有这一页）在界面里的组件，按页面 id 对上。
 * 有没有这一页、它排在哪、叫什么由登记决定；这里只放「这一页长什么样」。banner 是不在这一页时挂在画面面板顶上的提示条，
 * media 是按「看画面」那一类记面板宽度。
 */
export interface PageView {
  label: string;
  media?: boolean;
  render: (props: PageViewProps) => ReactNode;
  banner?: (props: PageViewProps) => ReactNode;
}

export const pageViews = {
  // 卡点插件的节拍页。
  beat: { label: '节拍', media: true, render: (p) => <BeatPage {...p} />, banner: (p) => <BeatBanner {...p} /> },
} satisfies Record<string, PageView>;

export type PageViewID = keyof typeof pageViews;

/** 页面 id 对应的插件页面组件；不是插件页面时为 undefined。 */
export function pageView(id: string): PageView | undefined {
  return (pageViews as Record<string, PageView>)[id];
}
