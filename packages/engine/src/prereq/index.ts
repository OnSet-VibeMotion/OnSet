//
// 「前置资源」的共同约定。
//
// 要联网下载的东西（HyperFrames 技能与 CLI、lemo-opuscar 风格库）只由 am setup 准备，
// 由用户自己在终端里跑：网络慢时能看着进度、换代理、断了重来。其余命令（am init、
// am film-style use、am scene run、am hyperframes、Studio）只检查不下载，缺了就返回
// MissingError，统一指向 am setup。以前这些东西在渲染途中、建项目途中、打开菜单时
// 各自现下载，网络一差就卡在半路，用户还看不到卡在哪。

/** 准备前置资源的命令（开发与 CI 用；客户端用户在安装页里装）。 */
export const SetupCommand = 'am setup';

/** 缺前置资源时给用户与编排工具的说明：命令行不对外，一律指向客户端的安装页。 */
export const SetupHint = '请在客户端的工具准备页安装（首页的「召集你的摄制组」，或顶栏的「还差几项工具 · 去安装」；网络慢可以在「网络」里填代理，断了重试会接着下），装好后再重试';

/** 表示某项前置资源还没准备好。 */
export class MissingError extends Error {
  /**
   * @param what 资源名，例如「HyperFrames CLI 0.8.225」。
   * @param detail 补充说明（缺在哪里），可以为空。
   */
  constructor(
    readonly what: string,
    readonly detail = '',
  ) {
    super(
      `缺少前置资源：${what}${detail !== '' ? '（' + detail + '）' : ''}。${SetupHint}`,
    );
    this.name = 'MissingError';
  }
}

/** 构造一个 MissingError。 */
export function missing(what: string, detail: string): MissingError {
  return new MissingError(what, detail);
}

/** 判断 err 是否（包着）MissingError：沿 cause 链查找，对应 errors.As。 */
export function isMissing(err: unknown): boolean {
  let current = err;
  // 限定层数：cause 链理论上可以成环。
  for (let depth = 0; current != null && depth < 100; depth++) {
    if (current instanceof MissingError) return true;
    if (typeof current !== 'object') return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
