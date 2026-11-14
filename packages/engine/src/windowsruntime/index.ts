import fs from 'node:fs';
import path from 'node:path';
import { assetsBase } from '../assets';

export * from './sources';
export * from './performance';
export * from './breeze';

/** 平台执行约束放在实际调用层，不改变 buildPrompt 的内容指纹或其他平台的提示词。 */
export function withWindowsInstructions(prompt: string, role: 'orchestrator' | 'renderer', platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return prompt;
  const instructions = fs.readFileSync(path.join(assetsBase(), 'assets', 'prompts', 'windows', `${role}.md`), 'utf8');
  return `${prompt}\n\n${instructions}`;
}
