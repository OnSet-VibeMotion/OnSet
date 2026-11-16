import { defineConfig } from 'vitest/config';

// 界面里的纯函数（进度怎么说、过程怎么整理、时间怎么估）写单元测试，不开客户端；e2e 只测真实的跨进程流程。
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,mjs}'],
  },
});
