import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goTrimSpace } from '../gofmt';
import { marshalIndent } from '../gojson';
import { seriesDir } from './store';
import { ConfigFile, PublishTemplateFile } from './types';

/** 专栏级发布模板：固定标题规则、常用话题、简介脚标、系列封面规范与固定署名。 */
export interface SeriesPublishTemplate {
  schema: 1;
  title_pattern?: string;
  default_hashtags?: string[];
  description_footer?: string;
  cover_guidelines?: string;
  credits_lines?: string[];
  updated_at: string;
}

export interface PublishTemplateInput {
  title_pattern?: string;
  default_hashtags?: string[];
  description_footer?: string;
  cover_guidelines?: string;
  credits_lines?: string[];
}

function cleanStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = goTrimSpace(v);
  return t === '' ? undefined : t;
}

function cleanList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.map(cleanStr).filter((x): x is string => !!x))];
  return out.length > 0 ? out : undefined;
}

/** 读取专栏的 publish-template.json；没有时返回 null。 */
export function readPublishTemplate(rootDir: string, id: string): SeriesPublishTemplate | null {
  if (!rootDir) return null;
  const file = path.join(seriesDir(rootDir, id), PublishTemplateFile);
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const raw = JSON.parse(body) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${PublishTemplateFile} 格式无效`);
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1) throw new Error(`不支持的发布模板版本：${String(r.schema)}`);
  return {
    schema: 1,
    title_pattern: cleanStr(r.title_pattern),
    default_hashtags: cleanList(r.default_hashtags),
    description_footer: cleanStr(r.description_footer),
    cover_guidelines: cleanStr(r.cover_guidelines),
    credits_lines: cleanList(r.credits_lines),
    updated_at: cleanStr(r.updated_at) ?? new Date().toISOString(),
  };
}

/** 写入专栏的 publish-template.json；全部字段为空时移除文件。 */
export function writePublishTemplate(
  rootDir: string,
  id: string,
  input: PublishTemplateInput,
): SeriesPublishTemplate | null {
  const dir = seriesDir(rootDir, id);
  if (!fs.existsSync(path.join(dir, ConfigFile))) throw new Error(`找不到专栏：${id}`);
  const file = path.join(dir, PublishTemplateFile);
  const next: SeriesPublishTemplate = {
    schema: 1,
    title_pattern: cleanStr(input.title_pattern),
    default_hashtags: cleanList(input.default_hashtags),
    description_footer: cleanStr(input.description_footer),
    cover_guidelines: cleanList(input.credits_lines) ? cleanStr(input.cover_guidelines) : cleanStr(input.cover_guidelines),
    credits_lines: cleanList(input.credits_lines),
    updated_at: new Date().toISOString(),
  };
  const empty =
    !next.title_pattern &&
    !next.default_hashtags &&
    !next.description_footer &&
    !next.cover_guidelines &&
    !next.credits_lines;
  if (empty) {
    fs.rmSync(file, { force: true });
    return null;
  }
  atomicWrite(file, marshalIndent(next) + '\n', 0o644);
  return next;
}

/** 计算发布模板的内容摘要（不含 updated_at，避免空保存触发伪变更）。 */
export function publishTemplateDigest(tpl: SeriesPublishTemplate): string {
  const { updated_at: _ts, ...stable } = tpl;
  return crypto.createHash('sha256').update(marshalIndent(stable), 'utf8').digest('hex');
}
