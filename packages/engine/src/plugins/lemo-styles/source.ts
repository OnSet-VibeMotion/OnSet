// lemo 的 source 类型：实现 filmstyle.Source，由插件的 apply 登记（index.ts）。
import fs from 'node:fs';
import { goQuote } from '../../gofmt';
import { missing } from '../../prereq';
import { type PrepareOptions, type Source, type Style } from '../../filmstyle';
import { fill } from './fill';
import { Gallery, PinnedStyleCount, SourceID, catalog, entryStyle, find } from './lemo';
import { libraryDir, openLibrary, posterPath } from './library';
import { prepareLibrary, requireLibrary, requireStyle } from './prepare';

/** lemo-opuscar 风格来源。 */
export const lemoSource: Source = {
  id: () => SourceID,
  name: () => `lemo-opuscar 风格库（LemoLab，${PinnedStyleCount} 种）`,
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
    const lib = openLibrary({ env });
    const file = posterPath(lib, slug);
    try {
      fs.statSync(file);
    } catch {
      throw missing('风格海报', file + ' 不存在');
    }
    return file;
  },
  fill: (dir, style, env) => {
    const entry = find(style.slug);
    if (!entry) throw new Error(`lemo-opuscar 风格库里没有 ${goQuote(style.slug)}`);
    const lib = requireLibrary({ env });
    requireStyle(lib, entry);
    fill(dir, entry, lib);
    return lib.commit || 'unknown';
  },
};

