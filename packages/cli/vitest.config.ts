import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // .tmpl 是随程序下发的文本模板：按文本导入，与打包时 esbuild 的 --loader:.tmpl=text 一致（同 packages/engine）。
      name: 'am-text-templates',
      transform(code, id) {
        if (id.endsWith('.tmpl')) return { code: `export default ${JSON.stringify(code)};`, map: null };
        return null;
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
