import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Command, ExactArgs, formatDuration, NoArgs, parseDuration, ref, Second } from './cobra';

/**
 * testdata/cobra-expected.txt 是用真实的 cobra v1.10.2 搭同一棵命令树、跑同一组参数得到的输出
 * （生成程序见本文件末尾的注释）。这里逐段比对：帮助格式、版本、错误文案、各类参数的解析结果。
 */
function tree() {
  let out = '';
  const root = new Command({ use: 'am', short: '短说明', long: '长说明第一行\n\n第二段。  ', version: 'dev' });
  root.persistentFlags().boolVar(ref(false), 'unsafe', false, '关闭隔离（危险）');
  const scene = new Command({ use: 'scene', short: '镜头相关操作' });
  const s = ref('');
  const empty = ref('');
  const n = ref(0);
  const b = ref(false);
  const d = ref(0);
  const arr = ref<string[]>([]);
  const slice = ref<string[]>([]);
  const goList = (xs: string[]) => '[' + xs.join(' ') + ']';
  const run = new Command({
    use: 'run <scene-dir>',
    short: '执行单个镜头',
    args: ExactArgs(1),
    runE: (_c, a) => {
      out += `ran ${goList(a)} "${s.value}" ${n.value} ${b.value} ${formatDuration(d.value)} ${goList(arr.value)} ${goList(slice.value)}`;
    },
  });
  run.flags().stringVar(s, 'renderer', 'claude', '渲染工具');
  run.flags().stringVar(empty, 'out', '', '输出 `path`，多行\n第二行');
  run.flags().intVar(n, 'retries', 2, '重试次数');
  run.flags().boolVar(b, 'force', false, '强制');
  run.flags().durationVar(d, 'timeout', 90 * Second, '超时');
  run.flags().stringArrayVar(arr, 'attach', [], '附件');
  run.flags().stringSliceVar(slice, 'tags', ['a', 'b'], '标签');
  const all = new Command({ use: 'run-all', short: '并行执行多个镜头', args: NoArgs, runE: () => {} });
  scene.addCommand(run, all);
  scene.addCommand(new Command({ use: 'cues', short: '推导镜头', runE: () => {} }));
  root.addCommand(scene, new Command({ use: 'config', short: '读取配置', runE: () => {} }));
  return { root, output: () => out };
}

async function show(...args: string[]): Promise<string> {
  const { root, output } = tree();
  let buf = '';
  root.setOut({ write: (t) => (buf += t) });
  root.setErr({ write: (t) => (buf += t) });
  let err = '';
  try {
    await root.execute(args);
  } catch (e) {
    err = `ERR: ${(e as Error).message}`;
  }
  const quoted = '[' + args.map((a) => JSON.stringify(a)).join(' ') + ']';
  return `=== ${quoted}\n${buf}${output()}${err}\n=== end\n`;
}

const cases = [
  ['--help'],
  ['scene', '--help'],
  ['scene', 'run', '--help'],
  ['help', 'scene'],
  ['--version'],
  ['scen'],
  ['scene', 'run'],
  ['scene', 'run-all', 'x'],
  ['scene', 'run', 'a', '--retries', 'abc'],
  ['scene', 'run', 'a', '--nope'],
  ['scene', 'run', 'a', '--renderer'],
  ['scene', 'run', 'dir', '--renderer=codex', '--retries', '0x10', '--force', '--timeout', '1m30s', '--attach', 'x,y', '--attach', 'z', '--tags', 'c,d', '--unsafe'],
];

describe('cobra compatibility', () => {
  const expected = fs.readFileSync(path.join(__dirname, 'testdata', 'cobra-expected.txt'), 'utf8');
  const sections = expected.split(/(?<=\n=== end\n)/);
  cases.forEach((args, index) => {
    it(`matches cobra for ${args.join(' ')}`, async () => {
      expect(await show(...args)).toBe(sections[index]);
    });
  });
});

describe('durations', () => {
  it('round-trips Go duration strings', () => {
    for (const [text, canonical] of [
      ['90s', '1m30s'],
      ['1h2m3.5s', '1h2m3.5s'],
      ['500ms', '500ms'],
      ['0', '0s'],
      ['2m', '2m0s'],
    ]) {
      expect(formatDuration(parseDuration(text))).toBe(canonical);
    }
  });
});
