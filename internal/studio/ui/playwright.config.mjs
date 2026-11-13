import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 项目登记文件每次用新的临时文件：不设的话本机跑会读写用户真实的登记，
// 上一次测试留下的项目会被当成这一次新建的。CI 用 AM_STUDIO_E2E_CONFIG 指定。
const registry =
  process.env.AM_STUDIO_E2E_CONFIG || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-studio-e2e-config-')), 'projects.json');

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4321', headless: true },
  webServer: {
    // e2e/fake-bin 里的假 claude 只对这个 Studio 进程生效，见 e2e/fake-bin/claude。
    // Studio 二进制内嵌的是 ../web 下已提交的构建产物，改了 src 要先 npm run build。
    command:
      'cd ../../.. && PATH="$PWD/internal/studio/ui/e2e/fake-bin:$PATH" AM_STUDIO_SKIP_SKILL_INSTALL=1 ORCHESTRATOR=claude RENDERER=claude go run ./cmd/am studio --listen 127.0.0.1:4321 --config ' + JSON.stringify(registry),
    url: 'http://127.0.0.1:4321/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
