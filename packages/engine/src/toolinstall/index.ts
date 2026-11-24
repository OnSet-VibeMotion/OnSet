// onset setup 下载的独立工具：ffmpeg / ffprobe 与 uv。装进 toolpath.binDir（默认 ~/.local/share/onset/bin），
// toolpath.find 先找那里再找 PATH，所以用户不必装 Homebrew。
//
// 为什么下载而不是打进 .app：HyperFrames 与 onset 自己的拼接都写死了 libx264（GPL），LGPL 构建渲染不了；
// 把 GPL 加 x264 的二进制随应用发布要背许可与专利义务，还让安装包大一百多 MB。由用户机器从上游下载，
// 不算我们分发。系统里已经有 ffmpeg（PATH 能找到）就直接算就绪，不重复下载。
//
// 每个文件都钉了版本与 sha256（来自上游 release 的 digest），下载后核对，对不上就丢掉：上游被替换、
// 镜像被篡改都会被拦下，所以也可以放心走镜像（ONSET_GITHUB_MIRROR）。
export { ensureFFmpeg, ensureUV, FFmpegRelease, ffmpegStatus, UVVersion, uvStatus } from './binaries';
export { GitHubMirrorEnv, type InstallOptions, mirrored, sha256File } from './download';
export { ensureModel, HFEndpointEnv, ModelSourceEnv, type ModelSpec, modelDir, modelReady } from './models';
export {
  ensureTool,
  pipIndexURL,
  pythonInstallDir,
  ToolPythonVersion,
  type ToolSpec,
  toolBins,
  toolStatus,
  toolSupported,
} from './tools';
