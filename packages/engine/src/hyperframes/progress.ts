/**
 * 安装的一次进度汇报。percent 是整体进度（0–100）；indeterminate 为 true
 * 时这一步没有可量的进度（检出技能文件时 git 一声不吭），界面显示不确定进度。
 * 字段名照抄 Go 的 JSON tag。
 */
export interface Progress {
  stage: string;
  percent: number;
  indeterminate?: boolean;
}

/** 接收子进程原始输出的地方（对应 io.Writer）。process.stdout 之类的流可以直接传。 */
export interface Writer {
  write(chunk: string): unknown;
}

// 各步在整体进度里占的区间。实测（0.8.225，经代理）克隆约 49 秒、检出约 11 秒、
// 拷贝不到 1 秒；克隆又分成 git 报告的几个阶段，最耗时的是接收对象。
const cloneStages: { prefix: string; label: string; from: number; to: number }[] = [
  { prefix: 'remote: Counting objects', label: '连接上游仓库', from: 0, to: 4 },
  { prefix: 'remote: Compressing objects', label: '连接上游仓库', from: 4, to: 8 },
  { prefix: 'Receiving objects', label: '下载技能仓库', from: 8, to: 62 },
  { prefix: 'Resolving deltas', label: '整理下载内容', from: 62, to: 68 },
  { prefix: 'Updating files', label: '整理下载内容', from: 68, to: 72 },
];

export const checkoutStart = 72;
export const copyStart = 95;

const percentPattern = /(\d{1,3})%/;

/**
 * 解析 git --progress 写到 stderr 的进度行（以 \r 或 \n 分隔），
 * 换算成整体进度回调出去；原始输出照样转给 next。
 */
export class GitProgress implements Writer {
  private buf = '';
  private last = 0;

  constructor(
    private readonly report: (p: Progress) => void,
    private readonly next?: Writer,
  ) {}

  write(chunk: string): number {
    this.next?.write(chunk);
    this.buf += chunk;
    for (;;) {
      const i = this.buf.search(/[\r\n]/);
      if (i < 0) break;
      this.line(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
    return chunk.length;
  }

  private line(line: string): void {
    for (const stage of cloneStages) {
      if (!line.startsWith(stage.prefix)) continue;
      const match = percentPattern.exec(line);
      if (!match) return;
      const percent = Number.parseInt(match[1], 10);
      const overall = stage.from + ((stage.to - stage.from) * Math.min(percent, 100)) / 100;
      // 只往前走：git 的几个阶段偶尔交错，进度条倒退比停一下更让人不安。
      if (overall < this.last) return;
      this.last = overall;
      this.report({ stage: stage.label, percent: overall });
      return;
    }
  }
}
