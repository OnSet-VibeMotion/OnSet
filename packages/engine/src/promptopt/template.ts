import fs from 'node:fs';
import path from 'node:path';
import { assetsBase } from '../assets';

/** 优化器的提示词目录：assets/optimizer/，与制作提示词一样随客户端下发、现读。 */
export function templateDir(): string {
  return path.join(assetsBase(), 'assets', 'optimizer');
}

export function readTemplate(name: 'polish.md' | 'scene-check.md' | 'series-assist.md'): string {
  return fs.readFileSync(path.join(templateDir(), name), 'utf8');
}

/**
 * 把材料写进模板的 {{EVIDENCE}}。材料一律是 JSON：待改的文字装在字符串里交给模型，
 * 它就不会把其中的祈使句、标题和代码块当成给自己的指令。
 */
export function fillTemplate(template: string, evidence: unknown): string {
  const marker = '{{EVIDENCE}}';
  const at = template.indexOf(marker);
  if (at < 0) throw new Error('优化器提示词缺少 {{EVIDENCE}}');
  return template.slice(0, at) + JSON.stringify(evidence, null, 2) + template.slice(at + marker.length);
}
