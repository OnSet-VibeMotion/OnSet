// am 的构建：am.cjs（命令行本体）与 am-agent.cjs（导演的 pi，只由 am studio agent 加载）。
// 发布流程经环境变量 AM_VERSION 把版本号写进 am --version。
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' };
const version = process.env.AM_VERSION;

await build({
  ...common,
  entryPoints: ['src/main.ts'],
  loader: { '.tmpl': 'text' },
  outfile: 'dist/am.cjs',
  // agent/command.ts 开发时 import('./pi')；打包后改为 require 同目录的 am-agent.cjs，这条 import 留着不打进来。
  plugins: [{ name: 'agent-external', setup: (b) => b.onResolve({ filter: /^\.\/pi$/ }, (args) => (args.importer.endsWith('command.ts') ? { path: args.path, external: true } : undefined)) }],
  define: {
    // command.ts 据此 require 同目录的 am-agent.cjs，pi 不进 am.cjs（见 agent/command.ts）。
    AM_AGENT_BUNDLE: JSON.stringify('am-agent.cjs'),
    ...(version ? { AM_VERSION: JSON.stringify(version) } : {}),
  },
});

await build({
  ...common,
  entryPoints: ['src/agent/pi.ts'],
  outfile: 'dist/am-agent.cjs',
  // pi 是 ESM，用 import.meta.url 找自己的包目录；打成 CJS 后换成这个文件自己的地址。
  inject: ['src/agent/import-meta-url.cjs'],
  define: { 'import.meta.url': 'importMetaUrl' },
});
