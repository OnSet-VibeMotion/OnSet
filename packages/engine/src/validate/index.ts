// Package validate：项目文件校验共用的部分——YAML frontmatter 解析、项目内路径检查、图片尺寸。
export { frontmatter, parseFrontmatter, resolveExisting, safeRelative } from './validate';
export { decodeConfig } from './imageconfig';
export type { ImageConfig } from './imageconfig';
export { AnyMap, GoFloat, YamlDecodeError, decodeFrontmatterYAML, deepEqual, formatV, toPlain } from './yamlany';
export type { GoMap } from './yamlany';
