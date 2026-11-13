// 移植自 internal/scene/run_unix.go 的 VerificationError（单独成文件：scene、timing、frames 都要用它，
// 放在 run.ts 里会让这几个模块与渲染流程互相依赖）。

/**
 * 产物规格校验失败。
 *
 * 单独立一个类型是为了让调度层能把它和「渲染器崩了」区分开：规格不符是确定性的，
 * 同样的提示词和渲染器重跑只会得到同样不合规的产物，而每次重试都是一次完整的
 * AI CLI 调用。调用方用 instanceof 认出它之后应当交给 schedule.Fatal 停止重试。
 */
export class VerificationError extends Error {
  constructor(
    readonly output: string,
    readonly problems: string[],
    /**
     * 每条问题对应的校验器 ID（与 problems 等长、一一对应），供渲染记忆
     * 按校验器聚类失败经历；给人看的仍是 problems。Go 的 nil 写成 null。
     */
    readonly checks: string[] | null = null,
  ) {
    super(
      problems.length === 1
        ? `产物不符合规格：${output} —— ${problems[0]}`
        : `产物不符合规格：${output}\n  - ${problems.join('\n  - ')}`,
    );
    this.name = 'VerificationError';
  }
}
