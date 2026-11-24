import type { Attachment, Scene } from '../../types';
import type { RunAction } from '../Preview';

export const FPS = 30;
export const POPOVER_W = 344;
export const POPOVER_H = 260;

export type HandleKind = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface StageFit {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export interface SelectedInfo {
  selector: string;
  hasText: boolean;
  canSelectParent: boolean;
  computedColor: string;
  computedBg: string;
  computedFontSize: number;
  computedOpacity: number;
  origText: string;
}

export interface HFWindow extends Window {
  __ONSET_EDITOR_ACTIVE__?: boolean;
  __hf?: { seek?: (t: number) => void };
  __player?: { seek?: (t: number) => void };
  __timelines?: Record<string, { seek?: (t: number, suppress?: boolean) => void; pause?: () => void }>;
  ONSET_SCENE?: { width_px?: number; height_px?: number; duration_seconds?: number; fps?: number };
}

export interface SceneEditorProps {
  scene: Scene;
  sceneRel: string;
  initialTime: number;
  duration: number;
  version: number;
  busy: string;
  onTimeChange: (seconds: number) => void;
  onExit: () => void;
  /** 向父级注册离开确认守卫：返回 true 表示允许直接离开，false 表示已弹出未保存确认。 */
  onRegisterExitGuard?: (guard: ((proceed: () => void) => boolean) | null) => void;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  run: RunAction;
}
