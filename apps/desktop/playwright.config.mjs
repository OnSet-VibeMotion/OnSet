import { defineConfig } from '@playwright/test';

// 客户端的端到端测试：每个用例用 Playwright 的 Electron 模式启动一次 out/ 下构建好的客户端（见 e2e/fixtures.mjs），
// 临时的 HOME、userData、项目登记与记忆库都随用例建、随用例删。改了 src 要先 npm run build（npm run test:e2e 会做），
// 写任务调用的 onset 是 packages/cli/dist/onset.cjs，要先 npm run build -w @onset/cli。
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
});
