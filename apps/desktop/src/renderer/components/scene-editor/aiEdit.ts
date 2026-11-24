import { api } from '../../api';
import type { Attachment, Scene } from '../../types';

/** 发送 AI 编辑指令到左侧主对话，附带当前元素选择器、源文件与当前帧。 */
export async function dispatchElementAiEdit(options: {
  scene: Scene;
  sceneRel: string;
  selector: string;
  seconds: number;
  text: string;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
}): Promise<void> {
  const { scene, sceneRel, selector, seconds, text, onQuick } = options;
  let framePath: string | undefined;
  if (scene.exists) {
    try {
      const shot = await api<Attachment>(`/api/scenes/${encodeURIComponent(scene.id)}/attachment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: Number(seconds.toFixed(3)) }),
      });
      framePath = shot.path;
    } catch {
      // 抽帧失败不阻断，仍带上选择器与时间点。
    }
  }
  const attachment: Attachment = {
    scene_id: scene.id,
    selector,
    source: `${sceneRel}/index.html`,
    seconds: Number(seconds.toFixed(3)),
    ...(framePath ? { path: framePath } : {}),
  };
  onQuick(`修改镜头 ${scene.id} 里的元素 ${selector}：${text}`, [attachment], false);
}
