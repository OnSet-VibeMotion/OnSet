import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 客户端界面（React）。源码在 src/renderer，产物写进 out/renderer，由主进程经 am:// 协议提供。
// 文件名固定不带 hash：主进程按路径直接取文件，产物 diff 也好读。
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(here, 'src/renderer'),
  plugins: [react()],
  base: '/',
  build: {
    outDir: path.resolve(here, 'out/renderer'),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
