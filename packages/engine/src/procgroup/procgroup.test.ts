import { describe, expect, it } from 'vitest';
import { DefaultGrace, ExitError, run, start } from './index';

describe('procgroup', () => {
  it('run returns process error', async () => {
    if (process.platform === 'win32') {
      const err = await run(process.execPath, ['-e', 'process.exit(4)'], { env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } }, DefaultGrace).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExitError);
      expect((err as ExitError).exitCode()).toBe(4);
      await expect(run(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } }, DefaultGrace)).resolves.toBeUndefined();
      return;
    }
    const err = await run('sh', ['-c', 'exit 4'], {}, DefaultGrace).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).exitCode()).toBe(4);
    await expect(run('true', [], {}, DefaultGrace)).resolves.toBeUndefined();
  });

  it('run escalates to SIGKILL', async () => {
    const signal = AbortSignal.timeout(200);
    const started = Date.now();
    // 忽略 SIGTERM 的进程只能靠宽限期后的 SIGKILL 结束。
    const err = process.platform === 'win32'
      ? await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal, env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } }, 300).catch((e: unknown) => e)
      : await run('sh', ['-c', "trap '' TERM; sleep 30"], { signal }, 300).catch((e: unknown) => e);
    expect((err as Error).name).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('start fails for missing binary', async () => {
    await expect(start('/nonexistent/binary', [], {}, DefaultGrace)).rejects.toThrow();
  });
});
