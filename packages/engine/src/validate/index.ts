// Package validate：am validate 的各项检查——旧版风格文件（frame.md 与说明书、字体、示例图）与示例图重新生成、多角色项目的一致性。
// 移植自 internal/validate。
export { frontmatter, parseFrontmatter, regenerateExamples, resolveExisting, safeRelative, style, validateFontStacks, validateNumericMap, validateStyleSchema, pngDimensions } from './validate';
export type { Writer } from './validate';
export { decodeConfig } from './imageconfig';
export type { ImageConfig } from './imageconfig';
export { AnyMap, GoFloat, YamlDecodeError, decodeFrontmatterYAML, deepEqual, formatV, toPlain } from './yamlany';
export type { GoMap } from './yamlany';
