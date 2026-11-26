/**
 * 离线本地风格参考帧查询（film_style_refs）：
 * 指向本机目录（ONSET_FILM_STYLE_REFS_DIR 或 refs_dir 参数），列出 <refs_dir>/<slug>/*.{png,jpg,webp}
 * 并在存在 manifest.json 时校验 SHA-256；未配置目录时优雅降级不报错。
 */
import path from 'node:path';
import * as filmstyle from '@onset/engine/filmstyle';
import '@onset/engine/flow';
import { encodeLine } from '@onset/engine/gojson';
import '@onset/engine/plugin';
import { currentEnvironment } from './cli';
import { bool, str } from './ops/common';
import { defineOp } from './ops/op';

function resolveSlugArg(styleInput: string, projectRoot: string): string {
  const trimmed = styleInput.trim();
  if (trimmed !== '') {
    const matched = filmstyle.find(trimmed);
    if (matched.ok && matched.style) return matched.style.slug;
    return trimmed;
  }
  const abs = path.resolve(projectRoot || '.');
  const { manifest, ok } = filmstyle.installed(abs);
  if (ok && manifest.slug) return manifest.slug;
  throw new Error('请指定 style（如 "mg-styles/03-isometric" 或 "03-isometric"），或在已设置默认风格的项目中调用');
}

defineOp({
  name: 'film_style_refs',
  cli: ['film-style', 'refs'],
  summary: '列出某套整片风格的本地离线参考帧，并在有 manifest.json 时校验 SHA-256',
  description: `按 <refs_dir>/<slug>/*.{png,jpg,webp} 检索本地离线风格参考帧（由环境变量 ${filmstyle.RefsDirEnv} 或 refs_dir 参数指定）。
存在 manifest.json 时自动校验每帧 SHA-256；未配置参考帧目录或目录不存在时优雅降级返回 available: false 与指引提示，不报错也不联网。`,
  examples: [
    'film_style_refs({"style": "mg-styles/03-isometric"})',
    'film_style_refs({"style": "03-isometric", "refs_dir": "/path/to/mg-refs"})',
    'film_style_refs({"style": "mg-styles/07-liquid", "json": true})',
  ],
  params: {
    style: {
      type: 'string',
      description: '风格标识（如 mg-styles/03-isometric）、目录名或中文名；省略时取当前项目默认风格',
      positional: 0,
    },
    refs_dir: {
      type: 'string',
      description: `本地参考帧根目录，覆盖环境变量 ${filmstyle.RefsDirEnv}`,
    },
    verify: {
      type: 'boolean',
      description: '存在 manifest.json 时校验 SHA-256（缺省开启）',
      default: true,
    },
    json: {
      type: 'boolean',
      description: '以 JSON 输出',
    },
    project_root: {
      type: 'string',
      description: '项目根目录，缺省为当前目录',
    },
  },
  run: (p, { out }) => {
    const slug = resolveSlugArg(str(p.style), str(p.project_root));
    const verify = p.verify === undefined ? true : bool(p.verify);
    const result = filmstyle.listStyleRefs(slug, {
      refsDir: str(p.refs_dir) || undefined,
      env: currentEnvironment(),
      verify,
    });
    if (bool(p.json)) {
      out.write(encodeLine(result, { indent: '  ' }));
      return { data: result };
    }
    if (!result.available) {
      out.write(`未找到风格 ${result.slug} 的本地参考帧。${result.hint ? '\n' + result.hint : ''}\n`);
      return { data: result };
    }
    out.write(`风格 ${result.slug} 本地参考帧（共 ${result.frames.length} 张，目录 ${result.refs_dir}）：\n`);
    for (const frame of result.frames) {
      const status = frame.verified === true ? ' [SHA-256 校验通过]' : frame.mismatch ? ' [SHA-256 不匹配]' : '';
      out.write(`- ${frame.file}（${frame.size_bytes} B）${status}  ${frame.path}\n`);
    }
    if (result.mismatches.length > 0) {
      out.write(`警告：${result.mismatches.length} 张参考帧与 manifest.json 校验和不一致\n`);
    }
    return { data: result };
  },
});
