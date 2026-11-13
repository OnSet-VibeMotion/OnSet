// 移植自 internal/hyperframes/hftest：给测试造一份「已装好」的 HyperFrames CLI，免得测试真的去 npm install。
import fs from 'node:fs';
import path from 'node:path';
import { PinnedVersion, cliBinary } from '../index';

/**
 * 在 dir 里写出带完成标记的假 CLI：它打印版本号并原样回显参数，退出码 0。
 * 测试的 setup 把 CLIDirEnv 指向这里。
 */
export function fakeCLI(dir: string): void {
  const bin = cliBinary(dir);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const script = '#!/bin/sh\nif [ "$1" = --version ]; then echo ' + PinnedVersion + '; exit 0; fi\necho "fake hyperframes $*"\n';
  fs.writeFileSync(bin, script, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, '.am-cli'), PinnedVersion + '\n', { mode: 0o644 });
}
