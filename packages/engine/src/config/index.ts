// 移植自 internal/config：配置解析（环境变量 > 项目 .env > article-to-motion.conf > 缺省值）、
// 子进程环境的安全模式白名单、编排工具的命令放行清单、TTS 与对齐工具取值表、渲染记忆设置。
export * from './config';
export * from './providers';
export * from './global';
