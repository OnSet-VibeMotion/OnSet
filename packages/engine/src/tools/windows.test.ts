import { expect, it } from 'vitest';
import { windowsPromptInput } from './windows';

it('sends long Windows prompts intact through stdin without changing flags or resume ids', () => {
  const prompt = '中文 "引号" \\ 路径\n'.repeat(4000);
  const claude = ['claude', '-p', '--resume', 'session-id', '--output-format', 'stream-json', prompt];
  expect(windowsPromptInput('claude', claude, prompt, 'win32')).toEqual({ argv: claude.slice(0, -1), stdin: prompt });
  const codex = ['codex', 'exec', '--json', 'resume', 'session-id', prompt];
  expect(windowsPromptInput('codex', codex, prompt, 'win32')).toEqual({ argv: [...codex.slice(0, -1), '-'], stdin: prompt });
  for (const platform of ['darwin', 'linux'] as const) expect(windowsPromptInput('claude', claude, prompt, platform).argv).toBe(claude);
  const short = ['claude', '-p', 'hello'];
  expect(windowsPromptInput('claude', short, 'hello', 'win32')).toEqual({ argv: short, stdin: '' });
});
