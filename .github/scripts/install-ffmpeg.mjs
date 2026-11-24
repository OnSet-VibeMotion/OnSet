// CI 用：装 ffmpeg / ffprobe，代替 `brew install ffmpeg`（每台机器 30 多秒，要拉一串依赖）。
// 下的是客户端安装页同一份钉死的静态构建（packages/engine/src/toolinstall/binaries.ts 的 ffmpegAssets）：
// 地址与 sha256 直接从那个文件读，升级版本时 CI 跟着变，不另记一份。对不上 sha256 就失败，不装。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const source = fs.readFileSync(new URL('../../packages/engine/src/toolinstall/binaries.ts', import.meta.url), 'utf8');
const release = /export const FFmpegRelease = '([^']+)'/.exec(source)?.[1];
const platform = `${process.platform}/${process.arch}`;
const idx = source.indexOf(`'${platform}': {`);
const block = idx >= 0 ? source.slice(idx) : '';
if (!release || !block) throw new Error(`toolinstall 里找不到 ${platform} 的 ffmpeg`);
const dir = path.resolve(process.argv[2] ?? 'ffmpeg-bin');
fs.mkdirSync(dir, { recursive: true });
for (const name of ['ffmpeg', 'ffprobe']) {
  const m = new RegExp(`${name}: \\{\\s*url: \`([^\`]+)\`,\\s*sha256: '([0-9a-f]{64})'`).exec(block);
  if (!m) throw new Error(`toolinstall 里找不到 ${platform} 的 ${name}`);
  const url = m[1].replace('${FFmpegRelease}', release);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const digest = crypto.createHash('sha256').update(gz).digest('hex');
  if (digest !== m[2]) throw new Error(`${name} 的 sha256 是 ${digest}，期望 ${m[2]}`);
  fs.writeFileSync(path.join(dir, name), zlib.gunzipSync(gz), { mode: 0o755 });
  console.log(`${name} ${release} → ${path.join(dir, name)}`);
}
if (process.env.GITHUB_PATH) fs.appendFileSync(process.env.GITHUB_PATH, dir + '\n');
