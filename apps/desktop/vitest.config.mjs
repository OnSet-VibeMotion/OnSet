import { defineConfig } from 'vitest/config';

// 界面里的纯函数（进度怎么说、过程怎么整理、时间怎么估）与组件（*.test.tsx，在 jsdom 里渲染，不开客户端）写在这里；
// e2e 只测核心流程（AGENTS.md「端到端测试」）。
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx,mjs}'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
