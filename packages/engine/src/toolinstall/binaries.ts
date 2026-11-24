/**
 * 独立二进制前置工具安装：ffmpeg / ffprobe 与 uv。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { lookPath } from '../envutil';
import { binDir, bundled, findOptional } from '../toolpath';
import { type Asset, download, type InstallOptions, platformKey, requireBinDir, run } from './download';

/** ffmpeg-static（eugeneware/ffmpeg-static）的 release：ffmpeg 6.0 静态构建，含 libx264、aac、libmp3lame、libopus、libvpx。 */
export const FFmpegRelease = 'b6.1.1';

const ffmpegAssets: Record<string, { ffmpeg: Asset; ffprobe: Asset }> = {
  'darwin/arm64': {
    ffmpeg: {
      url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFmpegRelease}/ffmpeg-darwin-arm64.gz`,
      sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
      size: 19246198,
    },
    ffprobe: {
      url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFmpegRelease}/ffprobe-darwin-arm64.gz`,
      sha256: 'd986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be',
      size: 19207077,
    },
  },
  'darwin/x64': {
    ffmpeg: {
      url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFmpegRelease}/ffmpeg-darwin-x64.gz`,
      sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
      size: 25296431,
    },
    ffprobe: {
      url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFmpegRelease}/ffprobe-darwin-x64.gz`,
      sha256: 'd4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186',
      size: 25239438,
    },
  },
};

/** uv（astral-sh/uv）：给 Python 类工具建环境，它自己下载独立的 Python，不依赖系统 Python。 */
export const UVVersion = '0.13.1';

const uvAssets: Record<string, Asset & { dir: string }> = {
  'darwin/arm64': {
    url: `https://github.com/astral-sh/uv/releases/download/${UVVersion}/uv-aarch64-apple-darwin.tar.gz`,
    sha256: 'cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2',
    size: 14280170,
    dir: 'uv-aarch64-apple-darwin',
  },
  'darwin/x64': {
    url: `https://github.com/astral-sh/uv/releases/download/${UVVersion}/uv-x86_64-apple-darwin.tar.gz`,
    sha256: 'bb7b805bdcf3d0bc8c74ceb94569e6b3e8aa35bd492acdbb9d46bf46d9d4ff6b',
    size: 17491796,
    dir: 'uv-x86_64-apple-darwin',
  },
};

/** ffmpeg 与 ffprobe 都能找到（自带、onset 下载的或 PATH 里的）。where 是 ffmpeg 的位置，缺时是将要装到的目录。 */
export function ffmpegStatus(env: Record<string, string | undefined>): { ok: boolean; where: string } {
  const ffmpeg = findOptional('ffmpeg', env);
  const ffprobe = findOptional('ffprobe', env);
  if (ffmpeg !== '' && ffprobe !== '') return { ok: true, where: ffmpeg };
  return { ok: false, where: binDir(env) };
}

/** 装好 ffmpeg 与 ffprobe（已能找到就不动），返回 ffmpeg 的路径。 */
export async function ensureFFmpeg(opts: InstallOptions): Promise<string> {
  const report = opts.progress ?? (() => {});
  const status = ffmpegStatus(opts.env);
  if (status.ok) {
    report({ stage: 'ffmpeg 已就绪', percent: 100 });
    return status.where;
  }
  const assets = ffmpegAssets[platformKey()];
  if (!assets) {
    throw new Error(`没有给 ${platformKey()} 准备 ffmpeg 的下载：请用系统的包管理器安装 ffmpeg（含 ffprobe）后重试`);
  }
  const dir = requireBinDir(opts.env);
  const total = assets.ffmpeg.size + assets.ffprobe.size;
  let base = 0;
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    if (bundled(name, opts.env) !== '') {
      base += assets[name].size;
      continue;
    }
    const asset = assets[name];
    const offset = base;
    const archive = await download(asset, dir, name + '.gz', opts, (bytes) =>
      report({ stage: `下载 ${name}`, percent: Math.min(99, (100 * (offset + bytes)) / total) }),
    );
    const target = path.join(dir, name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(archive)), { mode: 0o755 });
    fs.renameSync(tmp, target);
    fs.rmSync(archive, { force: true });
    base += asset.size;
  }
  fs.writeFileSync(path.join(dir, '.ffmpeg-release'), FFmpegRelease + '\n');
  report({ stage: 'ffmpeg 已就绪', percent: 100 });
  return path.join(dir, 'ffmpeg');
}

/** uv 能找到（onset 下载的或 PATH 里的）。 */
export function uvStatus(env: Record<string, string | undefined>): { ok: boolean; where: string } {
  const uv = findOptional('uv', env);
  return uv !== '' ? { ok: true, where: uv } : { ok: false, where: binDir(env) };
}

/** 装好 uv（已能找到就不动），返回它的路径。 */
export async function ensureUV(opts: InstallOptions): Promise<string> {
  const report = opts.progress ?? (() => {});
  const status = uvStatus(opts.env);
  if (status.ok) {
    report({ stage: 'uv 已就绪', percent: 100 });
    return status.where;
  }
  const asset = uvAssets[platformKey()];
  if (!asset) {
    throw new Error(`没有给 ${platformKey()} 准备 uv 的下载：请按 https://docs.astral.sh/uv/ 安装 uv 后重试`);
  }
  const dir = requireBinDir(opts.env);
  const archive = await download(asset, dir, 'uv.tar.gz', opts, (bytes) =>
    report({ stage: '下载 uv', percent: Math.min(99, (100 * bytes) / asset.size) }),
  );
  const unpack = fs.mkdtempSync(path.join(dir, '.uv-'));
  try {
    await run(lookPath('tar', opts.env.PATH || '/usr/bin:/bin'), ['-xzf', archive, '-C', unpack], opts);
    for (const name of ['uv', 'uvx']) {
      const from = path.join(unpack, asset.dir, name);
      if (!fs.existsSync(from)) {
        if (name === 'uv') throw new Error(`uv 的压缩包里没有 ${asset.dir}/uv：包结构已变`);
        continue;
      }
      fs.chmodSync(from, 0o755);
      fs.renameSync(from, path.join(dir, name));
    }
  } finally {
    fs.rmSync(unpack, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }
  report({ stage: 'uv 已就绪', percent: 100 });
  return path.join(dir, 'uv');
}
