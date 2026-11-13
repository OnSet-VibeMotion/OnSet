// Package concat：把镜头产物按顺序拼成静音母版，刻意不提供重定时。移植自 internal/concat。
export { DefaultCodec, DefaultPixelFormat, Runner, analyze, newRunner } from './concat';
export type { Input, Plan, Target } from './concat';
