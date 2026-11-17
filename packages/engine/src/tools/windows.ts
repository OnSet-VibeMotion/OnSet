/** 只控制 Windows 编排；镜头渲染保持原有推理设置。inherit/未设置时沿用 CLI 默认。 */
export function windowsOrchestratorEffort(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined;
  const value = env.ONSET_WINDOWS_ORCHESTRATOR_EFFORT;
  return value && ['low', 'medium', 'high'].includes(value) ? value : undefined;
}

/** Windows 的 CreateProcess 命令行上限约 32K UTF-16；长提示词走 CLI 原有的标准输入接口。 */
export function windowsPromptInput(tool: string, argv: string[], prompt: string, platform: NodeJS.Platform = process.platform): { argv: string[]; stdin: string } {
  const unchanged = { argv, stdin: '' };
  if (platform !== 'win32' || (tool !== 'claude' && tool !== 'codex' && tool !== 'mcode')) return unchanged;
  const index = argv.lastIndexOf(prompt);
  // 对引号和反斜杠的转义留余量，也给绝对可执行路径留出空间。
  const estimated = argv.reduce((size, arg) => size + arg.length + (arg.match(/["\\]/g)?.length ?? 0) + 3, 0);
  if (index < 0 || estimated < 24000) return unchanged;
  const args = [...argv];
  if (tool === 'codex') args[index] = '-';
  // mcode exec 的 --input 只认 -（标准输入）。
  else if (tool === 'mcode') args.splice(index, 1, '--input', '-');
  else args.splice(index, 1);
  return { argv: args, stdin: prompt };
}
