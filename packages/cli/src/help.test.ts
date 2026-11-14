// onset memory 整组命令推迟到 memory 那一轮移植，这里遍历的命令树暂时不含它。
import { describe, expect, it } from 'vitest';
import { Buffer, run } from './testutil';
import { newRoot } from './cli';
import type { Command } from './cobra';
import { allOps } from './ops/op';

/** 遍历命令树，跳过 cobra 自动生成的 help / completion。 */
function walk(cmd: Command, visit: (cmd: Command) => void): void {
  for (const child of cmd.commands()) {
    if (child.name() === 'help' || child.name() === 'completion') continue;
    visit(child);
    walk(child, visit);
  }
}

const byteLength = (s: string) => globalThis.Buffer.byteLength(s);

describe('help', () => {
  // 门槛刻意定得低（有 Long、且比 Short 长），只拦「新增命令时忘了写」，不评价内容好坏。
  it('every command has agent-readable long help', () => {
    const { root } = newRoot(new Buffer(), new Buffer());
    expect(root.long.trim(), '根命令缺少 Long：onset --help 是调用方读到的第一屏').not.toBe('');
    const problems: string[] = [];
    walk(root, (cmd) => {
      const p = cmd.commandPath();
      if (cmd.short.trim() === '') problems.push(`${p} 缺少 Short`);
      if (cmd.long.trim() === '') {
        problems.push(`${p} 缺少 Long：调用方只能看到一行 Short，不足以正确使用`);
        return;
      }
      if (byteLength(cmd.long) <= byteLength(cmd.short)) problems.push(`${p} 的 Long 不比 Short 长，等于没写`);
    });
    expect(problems).toEqual([]);
  });

  // 纯分组命令（config、scene、validate）只做路由，不要求 Example。
  it('runnable commands carry examples', () => {
    const { root } = newRoot(new Buffer(), new Buffer());
    const problems: string[] = [];
    walk(root, (cmd) => {
      if (!cmd.runnable()) return;
      if (cmd.example.trim() === '') {
        problems.push(`${cmd.commandPath()} 缺少 Example`);
        return;
      }
      // 样例必须真的调用这个命令，否则是复制粘贴留下的错样例。来自操作表的命令按工具写法举例
      //（scene run → scene_run(…)），只给开发用的命令（init、setup）按命令行写法。
      const route = cmd.commandPath().replace(/^onset /, '');
      const tool = allOps().find(op => op.cli.join(' ') === route)?.name ?? route.replace(/[ -]/g, '_');
      if (!cmd.example.includes(cmd.commandPath()) && !cmd.example.includes(tool + '(')) problems.push(`${cmd.commandPath()} 的 Example 里没有出现该命令本身：${cmd.example}`);
    });
    expect(problems).toEqual([]);
  });

  // cobra 默认给的是 "accepts 1 arg(s), received 0"：既是英文，也没说缺的是哪个参数。
  it('positional arg errors are Chinese and name the argument', async () => {
    const cases: [string[], string][] = [
      [['scene', 'run'], 'SCENE'],
      [['scene', 'run-all'], 'SCENES'],
      [['config', 'get'], 'KEY'],
      [['validate', 'publish'], 'FILE'],
      [['init', 'a', 'b'], 'DIR'],
      [['archive', 'extra'], '不接受位置参数'],
    ];
    for (const [args, want] of cases) {
      const out = new Buffer();
      expect(await run(args, new Buffer(), out), `${args.join(' ')} 应以退出码 1 失败`).toBe(1);
      const message = out.text;
      expect(message).toContain(want);
      expect(message.includes('accepts') || message.includes('arg(s)'), `${args.join(' ')} 仍在使用 cobra 的英文默认信息：${message}`).toBe(false);
      // 用法行要能直接照着补参数。
      expect(message).toContain('用法：');
    }
  });

  // 调用方靠退出码分支，帮助里少写一个就会被当成通用失败处理。
  it('exit codes are documented in root help', () => {
    const { root } = newRoot(new Buffer(), new Buffer());
    for (const code of ['127', '130']) expect(root.long).toContain(code);
  });
});
