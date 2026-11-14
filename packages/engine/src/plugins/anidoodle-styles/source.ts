// anidoodle 的 source 类型：实现 filmstyle.Source，由插件的 apply 登记（index.ts）。
import fs from 'node:fs';
import { goQuote } from '../../gofmt';
import { missing } from '../../prereq';
import type { PrepareOptions, Source, Style } from '../../filmstyle';
import { Gallery, PinnedStyleCount, SourceID, catalog, entryStyle, find } from './anidoodle';
import { buildDir, posterFile } from './build';
import { fill } from './fill';
import { libraryDir, prepareLibrary, requireLibrary } from './library';

/** anidoodle 风格来源。 */
export const anidoodleSource: Source = {
  runtimeAssets: ['anidoodle'],
  id: () => SourceID,
  name: () => `anidoodle 代码绘画（Alex Greenshpun，${PinnedStyleCount} 种）`,
  gallery: () => Gallery,
  catalog: (): Style[] => catalog().map(entryStyle),
  location: (env) => libraryDir({ env }),
  check: (env) => {
    requireLibrary({ env });
  },
  prepare: async (opts: PrepareOptions, signal?: AbortSignal) => {
    await prepareLibrary({ env: opts.env, output: opts.output, progress: opts.progress }, signal);
  },
  poster: (env, slug) => {
    const entry = find(slug);
    if (!entry) throw new Error(`anidoodle 里没有 ${goQuote(slug)}`);
    const lib = requireLibrary({ env });
    const file = posterFile(buildDir(lib, env), entry);
    if (!fs.existsSync(file)) throw missing('风格海报', file + ' 不存在');
    return file;
  },
  fill: (dir, style, env) => {
    const entry = find(style.slug);
    if (!entry) throw new Error(`anidoodle 里没有 ${goQuote(style.slug)}`);
    const lib = requireLibrary({ env });
    fill(dir, entry, { ...lib, build: buildDir(lib, env) });
    return lib.commit;
  },
};
