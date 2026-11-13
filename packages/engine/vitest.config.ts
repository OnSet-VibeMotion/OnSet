import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // .tmpl 是随程序下发的文本模板：按文本导入，与打包时 esbuild 的 --loader:.tmpl=text 一致。
      name: 'am-text-templates',
      transform(code, id) {
        if (id.endsWith('.tmpl')) return { code: `export default ${JSON.stringify(code)};`, map: null };
        return null;
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
    // 移植自 Go 的集成测试会起真实子进程（ffmpeg、假 CLI），默认 5 秒不够。
    testTimeout: 30_000,
  },
});
