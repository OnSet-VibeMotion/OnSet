import { defineConfig } from '@playwright/test';

// 客户端的端到端测试：每个用例用 Playwright 的 Electron 模式启动一次 out/ 下构建好的客户端（见 e2e/fixtures.mjs），
// 临时的 HOME、userData、项目登记与记忆库都随用例建、随用例删。改了 src 要先 npm run build（npm run test:e2e 会做），
// 写任务调用的 onset 是 packages/cli/dist/onset.cjs，要先 npm run build -w @onset/cli。
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // 每个用例一套临时目录与自己的 Electron（e2e/fixtures.mjs），彼此不共享状态，可以并行：
  // 本机 4 个（再多 Electron 互相抢 CPU、反而不快），CI 的 macOS 机器只有 3 个核，用 3 个。
  // ONSET_E2E_WORKERS 可以改（调试时设 1 回到逐个跑）。不加自动重试：不稳定的用例要暴露出来修，不能被重跑盖住。
  fullyParallel: true,
  workers: Number(process.env.ONSET_E2E_WORKERS) || (process.env.CI ? 3 : 4),
  reporter: [['list']],
});
