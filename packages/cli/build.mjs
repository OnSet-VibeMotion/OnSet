// onset 的构建：onset.cjs（命令行本体）与 onset-agent.cjs（导演的 pi，只由 onset studio agent 加载）。
// 发布流程经环境变量 ONSET_VERSION 把版本号写进 onset --version。
import { build } from 'esbuild';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' };
const version = process.env.ONSET_VERSION;
// 回归测试在独立目录构建，不覆盖客户端正在使用的 dist。
const outdir = process.argv[2] ?? 'dist';

await build({
  ...common,
  entryPoints: ['src/main.ts'],
  loader: { '.tmpl': 'text' },
  outfile: path.join(outdir, 'onset.cjs'),
  // agent/command.ts 开发时 import('./pi')；打包后改为 require 同目录的 onset-agent.cjs，这条 import 留着不打进来。
  plugins: [{ name: 'agent-external', setup: (b) => b.onResolve({ filter: /^\.\/pi$/ }, (args) => (args.importer.endsWith('command.ts') ? { path: args.path, external: true } : undefined)) }],
  define: {
    // command.ts 据此 require 同目录的 onset-agent.cjs，pi 不进 onset.cjs（见 agent/command.ts）。
    ONSET_AGENT_BUNDLE: JSON.stringify('onset-agent.cjs'),
    ...(version ? { ONSET_VERSION: JSON.stringify(version) } : {}),
  },
});

await build({
  ...common,
  entryPoints: ['src/agent/pi.ts'],
  outfile: path.join(outdir, 'onset-agent.cjs'),
  // pi 是 ESM，用 import.meta.url 找自己的包目录；打成 CJS 后换成这个文件自己的地址。
  inject: ['src/agent/import-meta-url.cjs'],
  define: { 'import.meta.url': 'importMetaUrl' },
});

// Photon 的 JS 会打进 onset-agent.cjs，WASM 则按 __dirname 从磁盘加载。
// 缺它时 pi 把所有图片静默省略（连小图也一样）；整个 dist 随客户端复制到资源目录。
const require = createRequire(import.meta.url);
fs.copyFileSync(require.resolve('@silvia-odwyer/photon-node/photon_rs_bg.wasm'), path.join(outdir, 'photon_rs_bg.wasm'));
