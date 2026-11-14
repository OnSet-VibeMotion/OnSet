/**
 * 导演用的模型看不了图片时怎么办。
 *
 * 画面验收与整片复查要打开 PNG 看图判断；看不了图的模型用 pi 的 read 打开图片只拿到一句「图片已省略」，
 * 验收等于没做，而且没人知道。所以：
 * - 设置页、开工前在界面上照实告诉用户（/api/agent-keys 的 vision 与 /api/agent-keys/vision）；
 * - 这一轮的提示词末尾加 noVisionNote，让它把要看的图切给用户看，而不是假装看过。
 * 模型能不能读图只按 director.modelVision 查：目录里查不到按不知道，不提示。
 */
import * as config from '../config';
import * as director from '../director';
import { envMap } from '../envutil';

/** 导演这一轮实际用的模型：设置或会话写了就用写的，否则按填了 key 的服务商挑（与 onset studio agent 同一个 pickModel）。 */
export function directorModel(model: string): string {
  return director.pickModel(model, director.configuredProviders(director.defaultDir(envMap())));
}

/** 这一轮的编排是导演、且实际用的模型确定看不了图。 */
export function orchestratorCannotSee(cfg: config.Config): boolean {
  if (cfg.orchestrator !== director.Tool) return false;
  return director.modelVision(directorModel(cfg.orchestratorModel)) === false;
}

/**
 * 接在这一轮提示词末尾的说明。写法守制作提示词的约束：不点名执行者身份，工具写成调用（studio_show 的页面与参数以
 * studioview.ViewPages、packages/cli/src/studio.ts 为准），vision.test.ts 钉着。
 */
export const noVisionNote = `## 这一轮看不了图片

你这一轮打不开图片：读 PNG、JPG 只会得到一句「图片已省略」，什么也看不到。首帧封面和视觉验收、整片复查里凡是要看图判断的地方，不要假装看过，也不要凭文件名、条带图的张数或检查命令的输出下「画面没问题」的结论：

- 机器能判的照常做：\`scene_frames\` 的纯色帧、\`review\` 报告里的 \`problems\` 与 \`hints\`、\`validate_reads\` 的结果都照读。
- 要用眼睛看的，把那几张图在项目里的相对路径列出来，用 \`studio_show({"page": "file", "target": "<第一张图的相对路径>", "note": "我看不了图，请你看这几张"})\` 把界面切过去；整片复查切到 \`studio_show({"page": "review", "note": "我看不了图，请你看联系表和交界条带"})\`，单个镜头切到 \`studio_show({"page": "scene", "target": "<镜头编号>"})\`。
- 回复里明说「我看不了图，请你看这几张」，写清每张要看什么（对齐、可读性、交接是否接上……），然后停下来等用户看完告诉你结论，再按结论继续或重渲染。`;
