// Package validate：am validate 的各项检查——publish.md（字段、密钥、路径、平台封面与标题字数）、
// 旧版风格文件（frame.md 与说明书、字体、示例图）与示例图重新生成、多角色项目的一致性。
// 移植自 internal/validate。
export { frontmatter, parseFrontmatter, publish, readPublish, regenerateExamples, resolveExisting, safeRelative, style, validateFontStacks, validateNumericMap, validateStyleSchema, pngDimensions } from './validate';
export type { Writer } from './validate';
export { validateCopyTitles, titleLimits } from './copy_titles';
export { coverSpecs, minCoverShortSide, parseRatio, platformName, validateCoverImages } from './cover_images';
export type { CoverSpec } from './cover_images';
export { beatsRecomputeHint, castProblems, setDialogueRelPath } from './cast';
export { decodeConfig } from './imageconfig';
export type { ImageConfig } from './imageconfig';
export { AnyMap, GoFloat, YamlDecodeError, decodeFrontmatterYAML, deepEqual, formatV, toPlain } from './yamlany';
export type { GoMap } from './yamlany';
