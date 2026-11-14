import { onsetCommand } from '../envutil';
/**
 * 各家工具能选哪些模型：客户端的模型下拉框用。列表来自工具自己（登录账号、配置的服务商决定能用什么），
 * onset 不维护一份会过期的模型表；claude 没有列模型的命令，给它帮助里写的别名。
 *
 * 2026-11 实测：
 * - codex：`codex debug models` 打印 JSON 目录，visibility 为 list 的是选择器里列出的。
 * - qoder：`qoderclicn --list-models` 打印一列表格，首行是表头 MODEL。
 * - codebuddy：没有列模型的命令，`--help` 里 --model 的说明写着「Currently supported: (a, b, …)」。
 * - opencode：`opencode models` 每行一个「服务商/模型」。
 * - claude：`--model` 的说明只给别名（fable、opus、sonnet）或完整模型名。
 * - director（导演）：`onset studio agent --list-models` 打印填了 API key 的服务商下 pi 自带目录里的模型，
 *   每行一个「服务商/模型」，格式与 opencode 相同。
 */

export interface ModelOption {
  id: string;
  /** 显示名；与 id 相同时界面只显示一份。 */
  label: string;
  description?: string;
}

/** 列模型要跑的命令；null 表示不用跑（claude 用内置别名）。 */
export function modelListCommand(tool: string): string[] | null {
  switch (tool) {
    case 'codex':
      return ['codex', 'debug', 'models'];
    case 'qoder':
      return ['qoderclicn', '--list-models'];
    case 'codebuddy':
      return ['codebuddy', '--help'];
    case 'opencode':
      return ['opencode', 'models'];
    case 'claude':
      return null;
    case 'director': {
      // onset 不能按名字找（编排工具的 PATH 前面是只会报错的 onset），给绝对路径。
      const onset = onsetCommand();
      return [onset.command, ...onset.args, 'studio', 'agent', '--list-models'];
    }
    default:
      throw new Error(`未知工具：${tool}`);
  }
}

/** 列模型的命令要额外加的环境变量（Windows 上用 Electron 跑 onset.cjs 时的 ELECTRON_RUN_AS_NODE，见 envutil.onsetCommand）。 */
export function modelListEnv(tool: string): Record<string, string> {
  return tool === 'director' ? onsetCommand().env : {};
}

/** claude 的别名：总指向这一档最新的模型。 */
export const ClaudeAliases: readonly ModelOption[] = [
  { id: 'fable', label: 'Fable', description: '最新的 Fable' },
  { id: 'opus', label: 'Opus', description: '最新的 Opus' },
  { id: 'sonnet', label: 'Sonnet', description: '最新的 Sonnet' },
  { id: 'haiku', label: 'Haiku', description: '最新的 Haiku' },
];

/** 把列模型命令的输出解析成选项；认不出时返回空数组（界面仍可手填）。 */
export function parseModelList(tool: string, stdout: string): ModelOption[] {
  switch (tool) {
    case 'claude':
      return [...ClaudeAliases];
    case 'codex': {
      let catalog: unknown;
      try {
        catalog = JSON.parse(stdout);
      } catch {
        return [];
      }
      const models = catalog && typeof catalog === 'object' ? (catalog as Record<string, unknown>).models : undefined;
      if (!Array.isArray(models)) return [];
      const out: ModelOption[] = [];
      for (const m of models) {
        if (!m || typeof m !== 'object') continue;
        const r = m as Record<string, unknown>;
        if (typeof r.slug !== 'string' || r.slug === '') continue;
        if (r.visibility !== undefined && r.visibility !== 'list') continue;
        out.push({
          id: r.slug,
          label: typeof r.display_name === 'string' && r.display_name !== '' ? r.display_name : r.slug,
          ...(typeof r.description === 'string' && r.description !== '' ? { description: r.description } : {}),
        });
      }
      return out;
    }
    case 'qoder': {
      const out: ModelOption[] = [];
      for (const raw of stdout.split('\n')) {
        const id = raw.trim().split(/\s{2,}|\t/)[0] ?? '';
        if (id === '' || /^model$/i.test(id) || /^[-=─\s]+$/.test(id)) continue;
        out.push({ id, label: id });
      }
      return dedupe(out);
    }
    case 'codebuddy': {
      const match = /Currently supported:\s*\(([^)]*)\)/.exec(stdout.replace(/\s+/g, ' '));
      if (!match) return [];
      return dedupe(
        match[1]!
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
          .map((id) => ({ id, label: id })),
      );
    }
    case 'opencode':
    case 'director':
      return dedupe(
        stdout
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => /^[^\s/]+\/\S+$/.test(s))
          .map((id) => ({ id, label: id })),
      );
    default:
      throw new Error(`未知工具：${tool}`);
  }
}

function dedupe(options: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
}
