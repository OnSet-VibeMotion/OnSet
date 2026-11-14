// esbuild 的 inject：onset-agent.cjs 里把 import.meta.url 换成这个文件自己的 file:// 地址（见 build.mjs）。
export const importMetaUrl = require('url').pathToFileURL(__filename).href;
