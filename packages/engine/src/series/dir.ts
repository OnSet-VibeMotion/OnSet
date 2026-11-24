/** 专栏库目录。单独一个文件：config 要用它，避免引入额外依赖。 */
import path from 'node:path';
import { dataDir } from '../envutil';

/** 覆盖专栏库目录的环境变量。 */
export const DirEnv = 'ONSET_SERIES_DIR';

/** 专栏库目录：ONSET_SERIES_DIR，否则 <数据目录>/onset/series。环境里什么都没有时为空。 */
export function defaultDir(env: Record<string, string | undefined>): string {
  if (env[DirEnv]) return env[DirEnv]!;
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'series');
}
