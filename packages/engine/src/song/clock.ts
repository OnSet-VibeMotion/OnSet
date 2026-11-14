// Go 的 time.Now().UnixNano() 与 time.RFC3339Nano 写法。只供本包内部使用。

const startNs = process.hrtime.bigint();
const startMs = BigInt(Date.now());

/** time.Now().UnixNano()：墙钟毫秒加单调时钟补齐纳秒，保证同一进程内递增。 */
export function unixNano(): string {
  return (startMs * 1_000_000n + (process.hrtime.bigint() - startNs)).toString();
}

/** time.Now().UTC().Format(time.RFC3339Nano)：小数部分去掉末尾的 0，全为 0 时不写小数点。 */
export function rfc3339Nano(d: Date = new Date()): string {
  const iso = d.toISOString(); // 2026-11-06T12:34:56.789Z
  const [main, frac] = iso.slice(0, -1).split('.');
  const trimmed = (frac ?? '').replace(/0+$/, '');
  return main + (trimmed ? '.' + trimmed : '') + 'Z';
}
