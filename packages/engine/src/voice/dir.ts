/** 音色库目录。单独一个文件：config 要用它，而 library.ts 依赖 mediaprobe。 */
import path from 'node:path';
import { dataDir } from '../envutil';

/** 覆盖音色库目录的环境变量。 */
export const DirEnv = 'ONSET_VOICES_DIR';

/** 音色库目录：ONSET_VOICES_DIR，否则 <数据目录>/onset/voices。环境里什么都没有时为空。 */
export function defaultDir(env: Record<string, string | undefined>): string {
  if (env[DirEnv]) return env[DirEnv]!;
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'voices');
}
