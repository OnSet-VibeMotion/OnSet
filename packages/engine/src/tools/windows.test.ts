import { expect, it } from 'vitest';
import { windowsPromptInput, windowsOrchestratorEffort } from './windows';

it('only accepts explicit supported Windows orchestrator effort settings', () => {
  expect(windowsOrchestratorEffort({}, 'win32')).toBeUndefined();
  for (const value of ['low', 'medium', 'high']) expect(windowsOrchestratorEffort({ ONSET_WINDOWS_ORCHESTRATOR_EFFORT: value }, 'win32')).toBe(value);
  for (const value of ['inherit', 'invalid', '']) expect(windowsOrchestratorEffort({ ONSET_WINDOWS_ORCHESTRATOR_EFFORT: value }, 'win32')).toBeUndefined();
  for (const platform of ['darwin', 'linux'] as const) expect(windowsOrchestratorEffort({ ONSET_WINDOWS_ORCHESTRATOR_EFFORT: 'medium' }, platform)).toBeUndefined();
});

it('sends long Windows prompts intact through stdin without changing flags or resume ids', () => {
  const prompt = '中文 "引号" \\ 路径\n'.repeat(4000);
  const claude = ['claude', '-p', '--resume', 'session-id', '--output-format', 'stream-json', prompt];
  expect(windowsPromptInput('claude', claude, prompt, 'win32')).toEqual({ argv: claude.slice(0, -1), stdin: prompt });
  const codex = ['codex', 'exec', '--json', 'resume', 'session-id', prompt];
  expect(windowsPromptInput('codex', codex, prompt, 'win32')).toEqual({ argv: [...codex.slice(0, -1), '-'], stdin: prompt });
  for (const platform of ['darwin', 'linux'] as const) expect(windowsPromptInput('claude', claude, prompt, platform).argv).toBe(claude);
  const short = ['claude', '-p', 'hello'];
  expect(windowsPromptInput('claude', short, 'hello', 'win32')).toEqual({ argv: short, stdin: '' });
  const mcode = ['mcode', 'exec', '--session', 'previous', prompt];
  expect(windowsPromptInput('mcode', mcode, prompt, 'win32')).toEqual({ argv: [...mcode.slice(0, -1), '--input', '-'], stdin: prompt });
  expect(windowsPromptInput('mcode', ['mcode', 'exec', 'hello'], 'hello', 'win32')).toEqual({ argv: ['mcode', 'exec', 'hello'], stdin: '' });
  const agy = ['agy', '-p', prompt, '--dangerously-skip-permissions', '--output-format', 'stream-json'];
  expect(windowsPromptInput('agy', agy, prompt, 'win32')).toEqual({
    argv: ['agy', '--input-format', 'stream-json', '--dangerously-skip-permissions', '--output-format', 'stream-json'],
    stdin: JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n',
  });
  expect(windowsPromptInput('agy', ['agy', '-p', 'hello', '--output-format', 'stream-json'], 'hello', 'win32')).toEqual({ argv: ['agy', '-p', 'hello', '--output-format', 'stream-json'], stdin: '' });
});
