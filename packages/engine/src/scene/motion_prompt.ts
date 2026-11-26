/**
 * 镜头动效选型的校验、插件技能联动与单镜渲染提示词配方注入。
 *
 * 独立成小模块以保持 scene_prompt / timing_plan / scene_cues_run 简洁可读，
 * 并确保未指定 motion_effects 的老镜头提示词与输入指纹逐字节不变。
 */
import * as flow from '../flow';
import type { Scene } from './scene';

/** 单镜最多指定的标志性动效条数（守住「一拍一个焦点」）。 */
export const MaxSceneMotionEffects = 3;

export { normalizeMotionEffectRef, normalizeMotionEffects } from '../flow';

/** 解析来自原始 JSON（如 scene_prepare 清单）的 motion_effects 字段：严禁非数组或非字符串元素。 */
export function parseMotionEffectsInput(raw: unknown, where = 'motion_effects'): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${where} 必须是字符串数组`);
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(`${where} 的每一项必须是字符串`);
  }
  return flow.normalizeMotionEffects(raw as string[], where);
}

/**
 * 严格校验单镜动效列表：
 * 1) 归一化与去重保序；
 * 2) 数量不超过 MaxSceneMotionEffects（3 条）；
 * 3) 每条均可在内置 + 已安装插件动效目录中解析。
 */
export function verifySceneMotionEffects(
  refs: readonly string[] | null | undefined,
  sources: readonly flow.MotionEffectSource[] = flow.listMotionSources(),
  where = '',
): flow.MotionEffectHit[] {
  const normalized = flow.normalizeMotionEffects(refs, where);
  const prefix = where ? `${where}：` : '';
  if (normalized.length > MaxSceneMotionEffects) {
    throw new Error(
      `${prefix}指定了 ${normalized.length} 条动效，单镜最多 ${MaxSceneMotionEffects} 条（守住「一拍一个焦点」）`,
    );
  }
  return normalized.map((ref) => {
    try {
      return flow.lookupMotionEffect(ref, sources);
    } catch (err) {
      throw new Error(`${prefix}${(err as Error).message}`, { cause: err });
    }
  });
}

/**
 * 收集镜头 motion_effects 命中的第三方插件动效所声明的 renderer_skill（「站 id/技能名」），
 * 供 resolveAllSkills 自动并入 plugin_skills 解析列表。
 */
export function motionEffectPluginSkills(
  refs: readonly string[] | null | undefined,
  env?: Record<string, string | undefined>,
): string[] {
  if (!refs || refs.length === 0) return [];
  const sources = flow.listMotionSources(env as Record<string, string> | undefined);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of refs) {
    let hit: flow.MotionEffectHit;
    try {
      const ref = flow.normalizeMotionEffectRef(raw);
      hit = flow.lookupMotionEffect(ref, sources);
    } catch {
      continue;
    }
    if (!hit.effect.renderer_skill) continue;
    const skillRef = `${hit.source.id}/${hit.effect.renderer_skill}`;
    if (seen.has(skillRef)) continue;
    seen.add(skillRef);
    out.push(skillRef);
  }
  return out;
}

/**
 * 生成插入单镜动态区的「本镜头指定动效配方（强制参考）」段。
 * 当 s.motion_effects 为空时返回空串，保证老镜头与无动效镜头的提示词逐字节不变。
 */
export function motionEffectsSection(
  s: Pick<Scene, 'motion_effects'>,
  env?: Record<string, string | undefined>,
): string {
  const refs = s.motion_effects ?? [];
  if (refs.length === 0) return '';
  const sources = flow.listMotionSources(env as Record<string, string> | undefined);
  const hits = refs.map((raw) => flow.lookupMotionEffect(flow.normalizeMotionEffectRef(raw), sources));
  const lines: string[] = [
    '',
    '本镜头指定动效配方（强制参考）：',
    '- 把配方示例元素替换为本镜头文案与画面主体，曲线、缓动与交错优先结合 SceneKit（如 snappyOut / spring / stagger）实现；不要机械照抄示例字样。',
  ];
  for (const hit of hits) {
    lines.push(`- **${hit.effect.name}**（\`${hit.ref}\`）：${hit.effect.summary}`);
    for (const step of hit.effect.spec ?? []) {
      lines.push(`  - ${step}`);
    }
  }
  lines.push(
    '- 验收锚点：调用 `scene_preview_check` 时采样帧需覆盖上述指定动效的关键动作时刻，核对是否按配方落地，不得退化为普通淡入。',
  );
  return lines.join('\n') + '\n';
}
