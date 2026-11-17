import { describe, expect, it } from 'vitest';
import { compactHyperFrames, hyperFramesProgress } from './hfoutput';

// 输出取自 2026-11 真实渲染的工具结果（HyperFrames 0.8.225），只删了中间重复的行。
const render = `
◆  Rendering scene-02 → /p/scenes/scene-02/scene-02.mp4
   30fps · standard · 8 workers
   GPU: browser GPU (auto-detect)

Checking browser...
Browser: env
[INFO] [Render] Pipeline started {"renderJobId":"b1","platform":"darwin"}
  █░░░░░░░░░░░░░░░░░░░░░░░░  5%  Compiling composition
@hf-progress {"code":"compile","pct":5}
[hyperframes] browserGpuMode probe → hardware (WebGL renderer vendor="Google Inc. (Apple)")
[BrowserManager] Browser launched (Chrome/156.0.8078.80, screenshot, headlessShell=true, platform=darwin)
[BrowserManager] Browser launched (Chrome/156.0.8078.80, screenshot, headlessShell=true, platform=darwin)
[initSession:screenshot] page.goto start (0ms)
[Browser:WARN] Electron Security Warning (Insecure Content-Security-Policy) This renderer process has either no Content Security
  Policy set or a policy with "unsafe-eval" enabled. This exposes users of
  this app to unnecessary security risks.

For more information and help, consult
https://electronjs.org/docs/tutorial/security.
This warning will not show up
once the app is packaged.
[Browser:WARN] Failed to load font assets/fonts/x.woff2
[StaticGuard] Invalid HyperFrame contract: Missing \`window.__timelines\` registration.
[StaticGuard] Invalid HyperFrame contract: Missing \`window.__timelines\` registration.
  █████████████████████████  100%  Render complete

◇  /p/scenes/scene-02/scene-02.mp4
   1.2 MB · 6.4s video · rendered in 10.3s
   Keep editing by chatting with Framey in the HyperFrames desktop app → https://hyperframes.studio/studio/download?src=cli
`;

const check = `[hyperframes] check: samples 1/9
[hyperframes] check: samples 9/9
[hyperframes] check: craft 52/52
{
  "ok": false,
  "runtime": {
    "ok": false,
    "errorCount": 1,
    "warningCount": 1,
    "findings": [
      {
        "code": "console_warning",
        "severity": "warning",
        "message": "Electron Security Warning (Insecure Content-Security-Policy) This renderer ...",
        "selector": "[data-composition-id]",
        "dataAttributes": { "data-width": "1920" },
        "bbox": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
        "time": 0,
        "url": "http://127.0.0.1:56093/"
      },
      {
        "code": "page_error",
        "severity": "error",
        "message": "g is not defined",
        "selector": "[data-composition-id]",
        "sourceFile": "index.html",
        "bbox": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
        "time": 11.963
      }
    ]
  },
  "layout": { "ok": true, "findings": [], "samples": [0.939, 2.817, 4.694] },
  "craft": { "ok": true, "samples": 136 },
  "saved": { "report": "/p/scenes/scene-02/.hyperframes/artifacts/checks/a.json" },
  "_meta": { "version": "0.8.225", "updateAvailable": false }
}`;

describe('compactHyperFrames', () => {
  it('drops progress and debug logs but keeps the summary, warnings and errors', () => {
    const { text, trimmed } = compactHyperFrames(render);
    expect(trimmed).toBe(true);
    expect(text).toContain('◆  Rendering scene-02');
    expect(text).toContain('◇  /p/scenes/scene-02/scene-02.mp4');
    expect(text).toContain('1.2 MB · 6.4s video');
    expect(text).toContain('[Browser:WARN] Failed to load font assets/fonts/x.woff2');
    expect(text).toContain('registration.（×2）');
    for (const gone of ['[INFO]', '@hf-progress', '█', 'BrowserManager', 'initSession', 'Electron Security Warning', 'once the app is packaged', 'Framey', 'Checking browser', 'browserGpuMode']) {
      expect(text).not.toContain(gone);
    }
  });

  it('rewrites the check report compactly and keeps every real finding', () => {
    const { text, trimmed } = compactHyperFrames(check);
    expect(trimmed).toBe(true);
    expect(text).not.toContain('check: samples');
    const report = JSON.parse(text) as Record<string, any>;
    expect(report.ok).toBe(false);
    // Electron 的安全提示是借用浏览器带来的，与镜头无关：删掉并改对计数。
    expect(report.runtime.findings).toEqual([{ code: 'page_error', severity: 'error', message: 'g is not defined', selector: '[data-composition-id]', sourceFile: 'index.html', time: 11.963 }]);
    expect(report.runtime.warningCount).toBe(0);
    expect(report.runtime.errorCount).toBe(1);
    // 采样时刻数组删掉，采样个数（数字）保留。
    expect(report.layout.samples).toBeUndefined();
    expect(report.craft.samples).toBe(136);
    expect(report._meta).toBeUndefined();
    expect(report.saved.report).toBe('/p/scenes/scene-02/.hyperframes/artifacts/checks/a.json');
  });

  it('writes a shared snapshot directory once', () => {
    const dir = '/p/scenes/scene-07/.hyperframes/artifacts/snapshots/5142';
    const json = JSON.stringify({ frames: [{ path: `${dir}/frame-00-at-4.533s.png`, time: 4.533 }, { path: `${dir}/frame-01-at-4.567s.png`, time: 4.567 }] }, null, 2);
    const report = JSON.parse(compactHyperFrames(json).text) as Record<string, any>;
    expect(report.frames_dir).toBe(dir);
    expect(report.frames).toEqual([{ path: 'frame-00-at-4.533s.png', time: 4.533 }, { path: 'frame-01-at-4.567s.png', time: 4.567 }]);
  });

  it('leaves short or unparsable output alone', () => {
    expect(compactHyperFrames('◇  0 errors, 0 warnings\n')).toEqual({ text: '◇  0 errors, 0 warnings', trimmed: false });
    expect(compactHyperFrames('{\n  "ok": tru').text).toBe('{\n  "ok": tru');
  });
});

describe('hyperFramesProgress', () => {
  it('reports the latest progress', () => {
    expect(hyperFramesProgress('@hf-progress {"code":"compile","pct":5}\n  ███  40%  Capturing\n@hf-progress {"code":"capture","pct":40}\n')).toBe('进度 40%（capture）');
    expect(hyperFramesProgress('[hyperframes] check: craft 17/52\n')).toBe('进度：check: craft 17/52');
    expect(hyperFramesProgress('')).toBe('');
  });
});
