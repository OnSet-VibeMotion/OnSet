import { useEffect, useRef, useState } from 'react';
import type { Tab } from '../components/Preview';
import { scriptFinalPath } from '../components/Script';
import { storyboardFiles } from '../components/Storyboard';
import type { Scene, TreeFile } from '../types';

export function useAutoTabs(opts: {
  projectPath: string;
  tree: TreeFile[];
  scenes: Scene[];
  tab: Tab;
  setTab: (next: Tab) => void;
  landPage: Tab | '';
  flowHidden: string[];
}) {
  const { projectPath, tree, scenes, tab, setTab, landPage, flowHidden } = opts;

  // 口播稿：有了终稿却还没有镜头时（稿件审核阶段）自动切到口播稿页；稿子改过而没看过时标签打点。
  const scriptMtime = tree.find((f) => f.path === scriptFinalPath)?.mtime ?? 0;
  const seenKey = `onset-studio.script-seen:${projectPath}`;
  const [scriptSeen, setScriptSeen] = useState(0);
  useEffect(() => {
    try {
      setScriptSeen(Number(window.localStorage.getItem(seenKey) ?? 0) || 0);
    } catch {
      setScriptSeen(0);
    }
  }, [seenKey]);

  // 流程声明了落脚页（卡点是节拍页）：用不上的页换成它；还没有镜头时（节拍、分镜阶段）打开项目先到它。
  const autoLand = useRef('');
  useEffect(() => {
    if (!landPage) return;
    if (flowHidden.includes(tab)) setTab(landPage);
    else if (tab === 'scene' && scenes.length === 0 && autoLand.current !== seenKey) {
      autoLand.current = seenKey;
      setTab(landPage);
    }
  }, [landPage, flowHidden, tab, scenes.length, seenKey]);

  const autoScript = useRef('');
  useEffect(() => {
    if (!scriptMtime || scenes.length > 0 || tab !== 'scene' || autoScript.current === seenKey) return;
    autoScript.current = seenKey;
    setTab('script');
  }, [scriptMtime, scenes.length, seenKey]);

  useEffect(() => {
    if (tab !== 'script' || !scriptMtime || scriptMtime <= scriptSeen) return;
    setScriptSeen(scriptMtime);
    try {
      window.localStorage.setItem(seenKey, String(scriptMtime));
    } catch {
      // 记不住只是下次还会打点。
    }
  }, [tab, scriptMtime, scriptSeen, seenKey]);

  // 分镜：有了分镜计划、镜头一个都还没渲染、分镜又有没看过的改动时（分镜审核阶段）自动切到分镜页；
  // 分镜或画面描述改过而没看过时标签打点。
  const storyboardMtime = tree.reduce(
    (latest, f) =>
      storyboardFiles.includes(f.path) || /^scenes\/[^/]+\/prompt\.md$/.test(f.path)
        ? Math.max(latest, f.mtime ?? 0)
        : latest,
    0,
  );
  const boardSeenKey = `onset-studio.storyboard-seen:${projectPath}`;
  const [boardSeen, setBoardSeen] = useState(0);
  useEffect(() => {
    try {
      setBoardSeen(Number(window.localStorage.getItem(boardSeenKey) ?? 0) || 0);
    } catch {
      setBoardSeen(0);
    }
  }, [boardSeenKey]);
  const hasPlan = tree.some((f) => f.path === storyboardFiles[0]);
  const unrendered = hasPlan && scenes.length > 0 && scenes.every((s) => !s.exists && !s.rendering);
  const autoBoard = useRef('');
  useEffect(() => {
    if (!unrendered || storyboardMtime <= boardSeen || tab !== 'scene' || autoBoard.current === boardSeenKey) return;
    autoBoard.current = boardSeenKey;
    setTab('storyboard');
  }, [unrendered, storyboardMtime, boardSeen, tab, boardSeenKey]);

  useEffect(() => {
    if (tab !== 'storyboard' || !storyboardMtime || storyboardMtime <= boardSeen) return;
    setBoardSeen(storyboardMtime);
    try {
      window.localStorage.setItem(boardSeenKey, String(storyboardMtime));
    } catch {
      // 记不住只是下次还会打点。
    }
  }, [tab, storyboardMtime, boardSeen, boardSeenKey]);

  return { scriptMtime, scriptSeen, storyboardMtime, boardSeen };
}
