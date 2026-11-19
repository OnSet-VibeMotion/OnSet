import { createHash } from 'node:crypto';
import { files } from '../assets';
import { loadStations } from '../flow';
import { MotionPromptID, type MotionEffect } from '../flow/motion';
import { methodNotAllowed, notFound, writeJSON } from './http';

interface BundledCatalog {
  version: string;
  effects: (MotionEffect & { pack: string; cell: number })[];
}

const motionAssets = () => files().sub('motion-prompt');
const bundledCatalog = (): BundledCatalog => JSON.parse(motionAssets().readText('catalog.json')) as BundledCatalog;

export function motionEffectsAPI(request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const { version, effects } = bundledCatalog();
  const installed = loadStations().stations
    .filter(({ manifest }) => manifest.motion_effects.length > 0)
    .map(({ manifest, entry }) => ({
      id: manifest.id,
      name: manifest.name,
      version: entry.commit || manifest.version,
      effects: manifest.motion_effects,
    }));
  return writeJSON(200, {
    sources: [
      {
        id: MotionPromptID,
        name: 'Motion Prompt',
        version,
        effects: effects.map(({ pack: _pack, cell: _cell, ...effect }) => ({
          ...effect,
          preview: '/preview/motion/' + effect.id,
        })),
      },
      ...installed,
    ],
  });
}

export function motionPreviewAPI(request: Request, id: string): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  if (!/^\d{3}$/.test(id)) return notFound();
  const effect = bundledCatalog().effects.find((item) => item.id === id);
  if (!effect) return notFound();
  const assets = motionAssets();
  // 只执行随应用下发的预览代码，第三方插件仅提供目录元数据与可打开的 HTTPS 示例链接。
  const script = [
    'let pack; const MotionPrompt = { pack(_name, create) { pack = create(); } };',
    assets.readText(effect.pack + '.js'),
    assets.readText('preview.js'),
  ].join('\n').replace(/\r\n?/g, '\n');
  const hash = createHash('sha256').update(script).digest('base64');
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; grid-template-rows: minmax(0, 1fr) auto; color: #eee9df; background: #191917; font: 12px system-ui; color-scheme: dark; }
  canvas { width: 100%; height: 100%; object-fit: contain; }
  .controls { display: flex; align-items: center; gap: 12px; padding: 7px 12px; border-top: 1px solid #33302a; }
  button { color: inherit; background: transparent; border: 1px solid #655848; border-radius: 12px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  input { min-width: 0; flex: 1; accent-color: #d9ae71; }
</style></head><body>
<canvas data-cell="${effect.cell}" aria-label="动效示例"></canvas>
<div class="controls"><button type="button">播放</button><input type="range" aria-label="预览进度" min="0" max="1000" step="1" value="0"></div>
<script>${script}</script></body></html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; sandbox allow-scripts`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
