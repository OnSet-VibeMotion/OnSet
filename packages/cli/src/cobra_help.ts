/**
 * cobra 帮助文案（Usage / Help）与 Did you mean 建议。
 */

import type { FlagSet } from './cobra_flags';

export const minNamePadding = 11;

export interface HelpCommand {
  short: string;
  long: string;
  example: string;
  aliases: string[];
  name(): string;
  commandPath(): string;
  useLine(): string;
  namePadding(): number;
  runnable(): boolean;
  isAvailableCommand(): boolean;
  hasAvailableSubCommands(): boolean;
  commands(): HelpCommand[];
}

/** cobra defaultUsageFunc。 */
export function formatUsage(cmd: HelpCommand, local: FlagSet, inherited: FlagSet): string {
  let w = 'Usage:';
  if (cmd.runnable()) w += `\n  ${cmd.useLine()}`;
  if (cmd.hasAvailableSubCommands()) w += `\n  ${cmd.commandPath()} [command]`;
  if (cmd.aliases.length > 0) w += `\n\nAliases:\n  ${[cmd.name(), ...cmd.aliases].join(', ')}`;
  if (cmd.example) w += `\n\nExamples:\n${cmd.example}`;
  if (cmd.hasAvailableSubCommands()) {
    w += '\n\nAvailable Commands:';
    for (const sub of cmd.commands()) {
      if (sub.isAvailableCommand() || sub.name() === 'help')
        w += `\n  ${sub.name().padEnd(sub.namePadding())} ${sub.short}`;
    }
  }
  if (local.hasAvailable()) w += '\n\nFlags:\n' + local.usages().trimEnd();
  if (inherited.hasAvailable()) w += '\n\nGlobal Flags:\n' + inherited.usages().trimEnd();
  if (cmd.hasAvailableSubCommands())
    w += `\n\nUse "${cmd.commandPath()} [command] --help" for more information about a command.`;
  return w + '\n';
}

/** cobra defaultHelpFunc。 */
export function formatHelp(cmd: HelpCommand, hasChildren: boolean, usage: () => string): string {
  const text = (cmd.long || cmd.short).trimEnd();
  let out = text ? text + '\n\n' : '';
  if (cmd.runnable() || hasChildren) out += usage();
  return out;
}

export function suggestionsFor(commands: HelpCommand[], typed: string): string {
  const suggestions: string[] = [];
  for (const cmd of commands) {
    if (!cmd.isAvailableCommand()) continue;
    const near = levenshtein(typed.toLowerCase(), cmd.name().toLowerCase()) <= 2;
    if (near || cmd.name().toLowerCase().startsWith(typed.toLowerCase())) suggestions.push(cmd.name());
  }
  return suggestions.length ? '\n\nDid you mean this?\n' + suggestions.map((s) => `\t${s}\n`).join('') : '';
}

function levenshtein(s: string, t: string): number {
  const d = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array(t.length).fill(0)]);
  for (let j = 0; j <= t.length; j++) d[0][j] = j;
  for (let j = 1; j <= t.length; j++) {
    for (let i = 1; i <= s.length; i++) {
      d[i][j] = s[i - 1] === t[j - 1] ? d[i - 1][j - 1] : Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]) + 1;
    }
  }
  return d[s.length][t.length];
}
