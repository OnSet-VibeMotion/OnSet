import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import type { Attachment, ProgressState, ProjectState, ProjectUsage, Scene, TreeFile } from '../types';
import { AuditionTab } from './Audition';
import { EvidenceTab } from './Evidence';
import { MemoryTab } from './Memory';
import { MotionEffects } from './MotionEffects';
import { ProgressTab } from './Progress';
import { PublishTab } from './Publish';
import { type PageViewID, pageView, pageViews } from './pageViews';
import { ComposeTab } from './preview/ComposeTab';
import { FilesTab } from './preview/FilesTab';
import { FinalTab } from './preview/FinalTab';
import { finalCandidates, useFilmReview } from './preview/filmReview';
import { ReviewTab } from './preview/ReviewTab';
import { SceneTab } from './preview/SceneTab';
import { StyleTab } from './preview/StyleTab';
import type { BuiltinTab, RunAction } from './preview/shared';
import { Timeline } from './preview/Timeline';
import { ScriptTab } from './Script';
import { isStationTab, StationPage, StationSlots } from './Stations';
import { StoryboardTab } from './Storyboard';
import { VoicesTab } from './Voices';

export { FileView } from './preview/FilesTab';
export { type BuiltinTab, noSceneText, type RunAction, spendParts } from './preview/shared';

/** 内置插件登记的页面（组件在 pageViews.tsx）与第三方插件自己的页面：x:<站>:<页面>（Stations.tsx）。 */
export type Tab = BuiltinTab | PageViewID | `x:${string}`;

/** 宿主的页面。内置插件的页面（例如卡点的节拍页）有没有、排在哪由后端的页面表定（/api/state 的 pages）。 */
const hostTabs: [Tab, string][] = [
  ['progress', '制作路线'],
  ['script', '口播稿'],
  ['storyboard', '分镜'],
  ['scene', '镜头'],
  ['compose', '合成'],
  ['final', '成片'],
  ['style', '风格'],
  ['motion', '动效'],
  ['voice', '音色'],
  ['review', '复查'],
  ['publish', '发布'],
  ['memory', '记忆'],
  ['evidence', '进化'],
  ['audition', '试镜'],
  ['file', '文件'],
];

/** 全部页面的名字（宿主的与界面认识的内置插件页面），切页、显示名字时查它。 */
export const tabs: [Tab, string][] = [
  ...hostTabs,
  ...Object.entries(pageViews).map(([id, v]): [Tab, string] => [id as Tab, v.label]),
];

/**
 * 顶栏中间的五个步骤，按制作顺序编号；其余页面（合成、复查、风格、音色、记忆、文件）在顶栏右侧用小字列出。
 * 项目的步骤来自它的流程声明（/api/state 的 flow.steps），这里只是还没读到时的缺省（口播）。
 */
export const stepTabs: Tab[] = ['script', 'storyboard', 'scene', 'final', 'publish'];

/**
 * 顶栏列出的页面：后端页面表里有的（pages，按它的顺序；还没读到时只列宿主的），不列这个项目的流程用不上的页
 * （flow.hidden_pages；编排工具仍可以 studio_show 切过去）。界面没有组件的页面不列。
 */
export function visibleTabs(
  hidden: readonly string[],
  pages?: readonly { id: string; label: string }[],
): [Tab, string][] {
  const known = (id: string) => hostTabs.some(([t]) => t === id) || pageView(id) !== undefined;
  const list: [Tab, string][] = pages
    ? pages.filter((pg) => known(pg.id)).map((pg) => [pg.id as Tab, pg.label])
    : hostTabs;
  // 制作路线在顶栏步骤条左边有自己的按钮。
  return list.filter(([id]) => id !== 'progress' && !hidden.includes(id));
}

interface Props {
  tab: Tab;
  /** 页面里的「去发布」这类按钮切页用。 */
  onTab?: (tab: Tab) => void;
  state: ProjectState | null;
  scenes: Scene[];
  usage: ProjectUsage | null;
  sceneId: string;
  filePath: string;
  tree: TreeFile[];
  /** 这一轮对话改过的文件，文件树里打点。 */
  recent: Set<string>;
  version: number;
  /** 这个项目用得上的内置插件页面（后端页面表里有、流程没藏起来的）：它们的提示条挂在面板顶上。 */
  pages: string[];
  progress: ProgressState | null;
  busy: string;
  onAttach: (attachment: Attachment) => void;
  /** 把一条消息交给对话：draftOnly 为 true 时只填进输入框。 */
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean, appendDraft?: boolean) => void;
  onFile: (path: string) => void;
  onScene: (id: string) => void;
  /** 跳到对话里的某一轮（制作路线里点「做了什么」）。 */
  onTurn: (sessionId: string, turnId: string) => void;
  /** 镜头可视化编辑器向父级注册未保存离开守卫（切换标签/收起面板前确认）。 */
  onRegisterExitGuard?: (guard: ((proceed: () => void) => boolean) | null) => void;
  run: RunAction;
}

/** 内置插件页面组件拿到的回调。 */
function viewProps(props: Props) {
  return {
    version: props.version,
    busy: props.busy,
    run: props.run,
    onQuick: props.onQuick,
    onScene: props.onScene,
    onTab: props.onTab as ((tab: string) => void) | undefined,
  };
}

export function Preview(props: Props) {
  const scene = props.scenes.find((s) => s.id === props.sceneId) ?? null;
  const project = props.state?.project.path;
  const [filmChoice, setFilmChoice] = useState<{ project?: string; path: string }>();
  const localExitGuardRef = useRef<((proceed: () => void) => boolean) | null>(null);
  const registerExitGuard = useCallback(
    (guard: ((proceed: () => void) => boolean) | null) => {
      localExitGuardRef.current = guard;
      props.onRegisterExitGuard?.(guard);
    },
    [props.onRegisterExitGuard],
  );
  const guardedOnScene = useCallback(
    (id: string) => {
      if (id !== props.sceneId && localExitGuardRef.current && !localExitGuardRef.current(() => props.onScene(id)))
        return;
      props.onScene(id);
    },
    [props.sceneId, props.onScene],
  );
  const guardedOnTab = useCallback(
    (next: Tab) => {
      if (next !== props.tab && localExitGuardRef.current && !localExitGuardRef.current(() => props.onTab?.(next)))
        return;
      props.onTab?.(next);
    },
    [props.tab, props.onTab],
  );
  const guardedOnFile = useCallback(
    (p: string) => {
      if (localExitGuardRef.current && !localExitGuardRef.current(() => props.onFile(p))) return;
      props.onFile(p);
    },
    [props.onFile],
  );
  const guardedProps = useMemo(
    () => ({ ...props, onScene: guardedOnScene, onTab: props.onTab ? guardedOnTab : undefined, onFile: guardedOnFile }),
    [props, guardedOnScene, guardedOnTab, guardedOnFile],
  );
  const variants = finalCandidates.filter((path) => props.tree.some((file) => file.path === path));
  const selected = filmChoice?.project === project ? filmChoice?.path : undefined;
  const video = selected && variants.includes(selected) ? selected : variants[0];
  const onVideo = (path: string) => setFilmChoice({ project, path });
  const showingReview = props.tab === 'review' || (props.tab === 'final' && !!video);
  const review = useFilmReview(showingReview, video, props.version, project);
  const film = { video, variants, onVideo, review };
  return (
    <main className="pane center">
      {props.pages
        .filter((id) => id !== props.tab)
        .map((id) => {
          const banner = pageView(id)?.banner;
          return banner ? <Fragment key={id}>{banner(viewProps(guardedProps))}</Fragment> : null;
        })}
      <div className="preview-body">
        {props.tab === 'progress' && (
          <ProgressTab
            progress={props.progress}
            flowError={props.state?.flow_error}
            busy={props.busy}
            onPage={(page) => {
              const tab = isStationTab(page) ? (page as Tab) : tabs.find(([id]) => id === page)?.[0];
              if (tab) guardedOnTab(tab);
            }}
            onFile={guardedOnFile}
            onQuick={props.onQuick}
            onTurn={props.onTurn}
          />
        )}
        {pageView(props.tab)?.render(viewProps(guardedProps))}
        {props.tab === 'script' && (
          <ScriptTab
            version={props.version}
            busy={props.busy}
            onQuick={props.onQuick}
            onFile={guardedOnFile}
            onAttach={props.onAttach}
          />
        )}
        {props.tab === 'storyboard' && (
          <StoryboardTab
            version={props.version}
            busy={props.busy}
            onQuick={props.onQuick}
            onFile={guardedOnFile}
            onScene={guardedOnScene}
            onStyles={() => guardedOnTab('style')}
          />
        )}
        {props.tab === 'scene' && <SceneTab {...guardedProps} scene={scene} onRegisterExitGuard={registerExitGuard} />}
        {props.tab === 'compose' && <ComposeTab {...guardedProps} scene={scene} />}
        {props.tab === 'final' && (
          <FinalTab {...film} tree={props.tree} version={props.version} run={props.run} onTab={guardedOnTab} />
        )}
        {props.tab === 'style' && (
          <StyleTab
            version={props.version}
            run={props.run}
            scenes={props.scenes}
            onScene={guardedOnScene}
            onQuick={props.onQuick}
          />
        )}
        {props.tab === 'motion' && (
          <MotionEffects
            key={project}
            version={props.version}
            scenes={props.scenes}
            sceneId={props.sceneId}
            onQuick={props.onQuick}
          />
        )}
        {props.tab === 'voice' && <VoicesTab version={props.version} />}
        {props.tab === 'review' && (
          <ReviewTab
            {...film}
            tree={props.tree}
            version={props.version}
            run={props.run}
            onScene={guardedOnScene}
            onQuick={props.onQuick}
          />
        )}
        {props.tab === 'publish' && <PublishTab version={props.version} run={props.run} />}
        {isStationTab(props.tab) && (
          <StationPage
            key={props.tab}
            tab={props.tab}
            version={props.version}
            run={props.run}
            onQuick={props.onQuick}
            onOpen={(t) => guardedOnTab(t as Tab)}
            projectName={props.state?.project.name ?? ''}
          />
        )}
        {/* 第三方插件嵌进这一页的小窗：能嵌在哪几页由后端的页面表定（studioview.slotPages），清单校验时已经拦过。 */}
        {!isStationTab(props.tab) && (
          <StationSlots
            at={props.tab}
            context={props.tab === 'scene' && scene ? { scene: scene.id } : {}}
            version={props.version}
            run={props.run}
            onQuick={props.onQuick}
            onOpen={(t) => guardedOnTab(t as Tab)}
            projectName={props.state?.project.name ?? ''}
          />
        )}
        {props.tab === 'memory' && <MemoryTab scene={scene} version={props.version} run={props.run} />}
        {props.tab === 'audition' && (
          <AuditionTab scene={scene} scenes={props.scenes} version={props.version} busy={props.busy} run={props.run} />
        )}
        {props.tab === 'evidence' && (
          <EvidenceTab
            version={props.version}
            run={props.run}
            onOpen={(t) => guardedOnTab(t)}
            scenes={props.scenes}
            sceneId={props.sceneId}
          />
        )}
        {props.tab === 'file' && (
          <FilesTab
            tree={props.tree}
            recent={props.recent}
            path={props.filePath}
            version={props.version}
            onFile={guardedOnFile}
          />
        )}
      </div>
      {/* 镜头条只在跟镜头有关的页面出现：口播稿、发布这些页面不需要它。 */}
      {(props.tab === 'scene' || props.tab === 'compose' || props.tab === 'final') && (
        <Timeline
          scenes={props.scenes}
          usage={props.usage}
          sceneId={props.sceneId}
          version={props.version}
          onScene={guardedOnScene}
        />
      )}
    </main>
  );
}
