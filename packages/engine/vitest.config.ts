import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // 移植自 Go 的集成测试会起真实子进程（ffmpeg、假 CLI），默认 5 秒不够。
    testTimeout: 30_000,
  },
});
