import { useEffect, useMemo } from 'react';
import { errorText, post } from '../api';
import { usePetCommands } from '../components/chat/crew';
import { type Tab, tabs } from '../components/Preview';
import { isStationTab } from '../components/Stations';
import { revealInFinder } from '../reveal';
import type { TreeFile, ViewRequest } from '../types';
import { pageForFile } from './helpers';

export function useAppNavigation(opts: {
  currentId: string;
  steps: Tab[];
  tree: TreeFile[];
  pluginTabs: [Tab, string][];
  sessionId: string;
  chooseSession: (id: string) => void;
  setJump: (jump: { turn: string; nonce: number }) => void;
  setHomeOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setPanelOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  setFilePath: (path: string) => void;
  setSceneId: (id: string) => void;
  showTab: (tab: Tab) => void;
  loadProject: () => Promise<void>;
  loadProjects: () => Promise<string>;
  notify: (message: string) => void;
}) {
  const {
    currentId,
    steps,
    tree,
    pluginTabs,
    sessionId,
    chooseSession,
    setJump,
    setHomeOpen,
    setSettingsOpen,
    setPanelOpen,
    setFilePath,
    setSceneId,
    showTab,
    loadProject,
    loadProjects,
    notify,
  } = opts;

  const jumpToTurn = (session: string, turn: string) => {
    if (session && session !== sessionId) chooseSession(session);
    setJump({ turn, nonce: Date.now() });
    // 窄窗口里面板是盖在对话上的抽屉，收起来才看得到对话。
    if (window.innerWidth < 1180) setPanelOpen(false);
  };

  // Markdown 里写到的项目文件可点：口播稿开口播稿页，其余开文件页。
  const treePaths = useMemo(() => tree.map((f) => f.path), [tree]);
  const markdownLinks = useMemo(
    () => ({
      files: treePaths,
      onOpenFile: (path: string) => {
        const page = pageForFile(path);
        if (page) {
          showTab(page);
          return;
        }
        setFilePath(path);
        showTab('file');
      },
    }),
    [treePaths, showTab],
  );

  // 编排工具经 onset studio show 请用户看某一页：切过去，镜头与文件页带上对象。
  const openView = (view: ViewRequest) => {
    // 标了制作步骤：重新读项目状态，顶栏的进度跟着变。只标步骤的请求不切页。
    if (view.step) void loadProject();
    if (isStationTab(view.page)) {
      // 插件页面：装了这个插件才切过去。
      if (pluginTabs.some(([id]) => id === view.page)) showTab(view.page as Tab);
      return;
    }
    const page = tabs.find(([id]) => id === view.page)?.[0];
    if (!page) return;
    if (page === 'file') {
      if (!view.target) return;
      const special = pageForFile(view.target);
      if (special) {
        showTab(special);
        return;
      }
      setFilePath(view.target);
    }
    if ((page === 'scene' || page === 'compose' || page === 'audition') && view.target) setSceneId(view.target);
    showTab(page);
  };

  // 桌宠上点了某个人或某样东西：主进程已经把窗口叫到前面，这里切到那一页（与 studio_show 同一条路）。
  usePetCommands((command) => {
    if (command.kind !== 'open' || !currentId) return;
    setHomeOpen(false);
    openView({ page: command.page, target: command.target });
  });

  // 原生菜单（客户端里才有）：新建回首页，打开文件夹走与「打开项目」同一个接口，⌘1–⌘5 切五个步骤。
  useEffect(() => {
    return window.onset?.onMenu?.((action) => {
      if (action.type === 'new' || action.type === 'home') setHomeOpen(true);
      else if (action.type === 'settings') setSettingsOpen(true);
      else if (action.type === 'step') {
        const id = steps[action.index];
        if (id && currentId) {
          setHomeOpen(false);
          showTab(id);
        }
      } else if (action.type === 'panel') {
        if (currentId) setPanelOpen((open) => !open);
      } else if (action.type === 'reveal') {
        if (currentId) revealInFinder('');
      } else if (action.type === 'open') {
        void (async () => {
          try {
            await post('/api/projects/open', { path: action.path });
            await loadProjects();
            setHomeOpen(false);
          } catch (err) {
            notify(errorText(err));
          }
        })();
      }
    });
  }, [currentId, loadProjects, steps, showTab, setPanelOpen]);

  return { jumpToTurn, markdownLinks, openView };
}
