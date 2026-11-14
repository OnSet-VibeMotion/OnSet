/**
 * 试渲染：在临时目录里用 HyperFrames 渲染一个 1 秒的小镜头，看这台电脑能不能出片。
 *
 * 给 Windows 用的：那里渲染借用客户端自带的浏览器走的是引导脚本接管的路（hyperframes/browserhook.ts），
 * 隐藏窗口截图等行为只有真机才验证得了。命令行不对外，用户只能在安装页点这个按钮；走的是与真正渲染同一个入口
 * （hyperframes.cliCommandFor），所以这里能出片，镜头渲染就能出片。成功时回传中间一帧给用户看，失败时回传原因与输出的最后几行。
 *
 * 同一时间只跑一次；不占项目写锁（只写临时目录）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envMap } from '../envutil';
import * as hyperframes from '../hyperframes';
import { newToolchain } from '../mediaprobe';
import { methodNotAllowed, writeError, writeJSON } from './http';

/** 试渲染的结果。 */
export interface RenderCheckResult {
  ok: boolean;
  /** 从开始到出片用了多少秒。 */
  seconds: number;
  /** 用的是哪种浏览器：lent（借用客户端自带的）、own（用户自己指定的）、downloaded（HyperFrames 自己下载的）。 */
  browser: 'lent' | 'own' | 'downloaded';
  /** 借用客户端浏览器时走的是不是引导脚本接管的路（Windows 上是）。 */
  hooked: boolean;
  /** 中间一帧（PNG 的 data URL）；抽不出来时省略。 */
  frame?: string;
  error?: string;
  /** HyperFrames 输出的最后几行。 */
  log_tail?: string[];
}

/**
 * 试渲染的小镜头：暖色底、一行中英文字（看得出字体能显示）。不用 GSAP、不连网：要查的是浏览器能不能出片，
 * 不让网络问题混进来。
 */
const composition = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
html,body{margin:0;background:#000}
#main{position:absolute;inset:0;background:#c8844a;overflow:hidden}
#title{position:absolute;left:32px;top:72px;font:bold 44px sans-serif;color:#fff}
#bar{position:absolute;left:32px;bottom:40px;width:256px;height:10px;background:#2a2520}
</style></head><body>
<div id="main" data-composition-id="main" data-start="0" data-duration="1" data-width="320" data-height="240" data-no-timeline>
  <div id="title">片场 OnSet</div>
  <div id="bar"></div>
</div>
</body></html>
`;

let running = false;

/** 本次渲染会用哪种浏览器（与 hyperframes.cliCommandFor 的判断一致）。 */
function browserKind(env: Record<string, string>): { browser: RenderCheckResult['browser']; hooked: boolean } {
  if (env[hyperframes.HyperFramesBrowserEnv]) return { browser: 'own', hooked: false };
  if (hyperframes.browserFor(env) !== '') return { browser: 'lent', hooked: env[hyperframes.BrowserHookEnv] === '1' };
  return { browser: 'downloaded', hooked: false };
}

function tail(text: string, lines = 15): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '' && !l.startsWith('@hf-progress'))
    .slice(-lines);
}

/** 跑一次 HyperFrames render，最多等 timeoutMs。 */
function render(spec: hyperframes.CLICommandSpec, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(spec.file, spec.args, { cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const keep = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 64_000) output = output.slice(-32_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      output += `\n[onset] 等了 ${Math.round(timeoutMs / 1000)} 秒还没渲染完，停掉了。\n`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: output + `\n${err.message}\n` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** 试渲染一次。env 缺省取本进程的环境（客户端主进程设好的借用浏览器的变量都在里面）。 */
export async function runRenderCheck(env: Record<string, string> = envMap(), timeoutMs = 180_000): Promise<RenderCheckResult> {
  const kind = browserKind(env);
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  let cli: string;
  try {
    cli = hyperframes.requireCLI(env);
  } catch (err) {
    return { ok: false, seconds: 0, ...kind, error: (err as Error).message };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-render-check-'));
  try {
    const out = path.join(dir, 'check.mp4');
    fs.writeFileSync(path.join(dir, 'index.html'), composition);
    const spec = hyperframes.cliCommandFor(cli, env, ['render', '--output', out, '--workers', '1', '--quality', 'draft', dir]);
    const { output } = await render(spec, dir, timeoutMs);
    if (!fs.existsSync(out)) {
      return { ok: false, seconds: seconds(), ...kind, error: '没有渲染出视频', log_tail: tail(output) };
    }
    const result: RenderCheckResult = { ok: true, seconds: seconds(), ...kind };
    try {
      const png = path.join(dir, 'frame.png');
      newToolchain(env).extractFrame(out, 0.5, png);
      result.frame = 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
    } catch {
      // 抽不出帧（没有 ffmpeg）不算渲染失败：视频已经出来了。
    }
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** POST /api/setup/render-check：试渲染一次，跑完才返回（十几秒）。同一时间只跑一次。 */
export async function renderCheckAPI(request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  if (running) return writeError(409, 'render_check_running', '已经在试渲染了');
  running = true;
  try {
    return writeJSON(200, await runRenderCheck());
  } finally {
    running = false;
  }
}
