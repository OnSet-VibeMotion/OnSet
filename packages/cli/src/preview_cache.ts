import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Report } from '@onset/engine/determinism';
import { atomicWrite } from '@onset/engine/fsutil';
import * as hyperframes from '@onset/engine/hyperframes';
import * as resources from '@onset/engine/renderassets';
import { contained, sceneCanvas, type Scene } from '@onset/engine/scene';

const ignored = /^(?:\.onset(?:$|-render(?:\.json$|-leases$))|\.git$|\.env(?:\.|$)|attempts$|visual-qc$|renders$|snapshots$|render-.*\.(?:log|jsonl|attempt\.json)$)/;
const hyperframesArtifacts = new Set([
  '.hyperframes/artifacts', '.hyperframes/render-outputs-lock', '.hyperframes/video-state-lock',
  '.hyperframes/video-state.json', '.hyperframes/history-id',
]);
const remoteRef = /(?:https?:\/\/|["'`]\/\/)(?!www\.w3\.org\/(?:1999\/(?:xhtml|xlink)|2000\/svg)\b)/i;

function digest(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function identity(file: string) {
  const real = fs.realpathSync(file);
  const stat = fs.statSync(real, { bigint: true });
  return [real, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
}

/** The bundled GSAP uses URLs in license and diagnostic text. Verify the local copy byte for byte. */
function matchesBundledGSAP(cli: string, relative: string, body: Buffer): boolean {
  if (!relative.startsWith('vendor/') || path.posix.basename(relative) !== 'gsap.min.js') return false;
  const npm = path.join(cli, 'node_modules', 'hyperframes', 'dist', 'vendor', 'npm');
  try {
    return fs.readdirSync(npm).filter(name => /^gsap@\d+\.\d+\.\d+$/.test(name)).some(name => {
      const bundle = path.join(npm, name, 'dist', 'gsap.min.js');
      return fs.existsSync(bundle) && body.equals(fs.readFileSync(bundle));
    });
  } catch {
    return false;
  }
}

/** The render record intentionally excludes generated source. Preview reuse checks the actual workspace. */
export function previewKey(s: Scene, source: Report, cli: string, env: Record<string, string>): string {
  if (!source.entries.length || source.allowed?.length) return '';
  try {
    const root = fs.realpathSync(s.directory);
    const browser = hyperframes.browserFor(env);
    // If HyperFrames chooses a browser on its own, its identity isn't fixed before launch.
    if (!browser) return '';
    const mounted = resources.inputs(root, []);
    const active = new Set(source.files);
    const files: [string, string][] = [];
    function walk(dir: string, prefix: string) {
      for (const name of fs.readdirSync(dir).sort()) {
        const relative = prefix + name;
        if (relative === s.output || ignored.test(name) || hyperframesArtifacts.has(relative)) {
          if (active.has(relative) || source.files.some(file => file.startsWith(relative + '/'))) {
            throw new Error('Preview depends on a generated artifact');
          }
          continue;
        }
        const file = path.join(dir, name);
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) {
          walk(file, relative + '/');
          continue;
        }
        if (stat.isSymbolicLink()) {
          const hash = mounted['asset:' + relative];
          if (!hash) throw new Error('Unmanaged preview link');
          if (!active.has(relative)) {
            files.push([relative, hash]);
            continue;
          }
          // Only read a shared link after renderassets has verified its destination and bytes.
          resources.verify(root);
        } else if (!stat.isFile()) {
          throw new Error('Unsupported preview input');
        }
        const body = fs.readFileSync(file);
        if (active.has(relative) && remoteRef.test(body.toString('utf8')) && !matchesBundledGSAP(cli, relative, body)) {
          throw new Error('Unpinned preview input');
        }
        files.push([relative, digest(body)]);
      }
    }
    walk(root, '');
    // The installed CLI has a pinned version. The entry and lock also distinguish replaced local installs.
    const entry = hyperframes.cliEntry(cli) || hyperframes.cliBinary(cli);
    const lock = path.join(cli, 'package-lock.json');
    const options = Object.entries(env)
      .filter(([name]) => /^(?:HYPERFRAMES_|PRODUCER_|ONSET_BROWSER|ELECTRON_RUN_AS_NODE$|LANG$|LC_|TZ$)/.test(name))
      .sort(([a], [b]) => a.localeCompare(b));
    return digest(JSON.stringify([
      2, root, files, mounted, s.output, sceneCanvas(s), hyperframes.PinnedVersion, identity(entry),
      fs.existsSync(lock) ? identity(lock) : null, identity(browser), identity(process.execPath),
      process.versions, options,
    ]));
  } catch {
    // Preview remains available for old projects and dependencies we cannot safely fingerprint.
    return '';
  }
}

export interface CachedArtifact {
  file: string;
  sha256: string;
}

export interface PreviewCache {
  check?: CachedArtifact & { warnings: string[]; passed?: string[] };
  frames: Record<string, CachedArtifact>;
  sheets: Record<string, CachedArtifact>;
}

export function loadPreviewCache(file: string, key: string): PreviewCache {
  if (key) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value?.key === key && value.frames && typeof value.frames === 'object'
        && value.sheets && typeof value.sheets === 'object') return value;
    } catch { /* A missing or damaged index is a cache miss. */ }
  }
  return { frames: {}, sheets: {} };
}

export function savePreviewCache(file: string, key: string, data: PreviewCache): void {
  atomicWrite(file, JSON.stringify({ ...data, key }) + '\n');
}

export function rememberArtifact(root: string, file: string): CachedArtifact {
  return { file: path.relative(root, file), sha256: digest(fs.readFileSync(file)) };
}

export function cachedArtifact(root: string, record?: CachedArtifact): string {
  if (!record || typeof record.file !== 'string' || !/^preview-[^/\\]+[/\\]/.test(record.file)) return '';
  try {
    const file = contained(root, record.file, '预览缓存');
    const bytes = fs.readFileSync(file);
    return bytes.length && digest(bytes) === record.sha256 ? file : '';
  } catch {
    return '';
  }
}
