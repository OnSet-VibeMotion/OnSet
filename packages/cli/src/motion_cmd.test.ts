import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as flow from '@onset/engine/flow';
import { afterEach, describe, expect, it } from 'vitest';
import { execute } from './cli';
import { describeToolCatalog, describeTools } from './toolsmcp';

const temps: string[] = [];
const savedStationsDir = process.env[flow.StationsDirEnv];

afterEach(() => {
  if (savedStationsDir === undefined) delete process.env[flow.StationsDirEnv];
  else process.env[flow.StationsDirEnv] = savedStationsDir;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function runCLI(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await execute(
    args,
    {
      write: (chunk: string) => {
        stdout += chunk;
      },
    },
    {
      write: (chunk: string) => {
        stderr += chunk;
      },
    },
  );
  return { code, stdout, stderr };
}

describe('motion_effect_* operations', () => {
  it('exposes motion_effect_list and motion_effect_show as instant orchestrator tools', () => {
    const tools = describeToolCatalog('orchestrator').all;
    for (const name of ['motion_effect_list', 'motion_effect_show']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `缺少工具 ${name}`).toBeDefined();
      expect(tool!.inputSchema.properties).not.toHaveProperty('wait_seconds');
    }
    expect(describeTools('renderer').some((t) => t.name.startsWith('motion_effect_'))).toBe(false);
  });

  it('lists and filters bundled Motion Prompt effects and shows detailed specs', async () => {
    process.env[flow.StationsDirEnv] = makeTempDir('onset-stations-empty-');
    const listed = await runCLI(['motion-effect', 'list', '--query', '遮罩']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('motion-prompt:005');
    expect(listed.stdout).toContain('遮罩显现');

    const shown = await runCLI(['motion-effect', 'show', 'motion-prompt:005']);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('遮罩显现（motion-prompt:005');
    expect(shown.stdout).toContain('参考规范');
    expect(shown.stdout).toContain('clip');

    const byName = await runCLI(['motion-effect', 'show', '数字递增', '--json']);
    expect(byName.code, byName.stderr).toBe(0);
    const parsed = JSON.parse(byName.stdout) as { ref: string; name: string; spec: string[] };
    expect(parsed.ref).toBe('motion-prompt:007');
    expect(parsed.name).toBe('数字递增');
    expect(parsed.spec.length).toBeGreaterThan(0);
  });

  it('includes installed third-party station motion effects and disambiguates duplicate ids', async () => {
    const stationsRoot = makeTempDir('onset-stations-');
    process.env[flow.StationsDirEnv] = stationsRoot;
    const pluginDir = flow.writeStationForTest({
      'onset-station.json': JSON.stringify({
        id: 'other-motion',
        name: '自定义动效包',
        version: '1.0.0',
        motion_effects: [
          {
            id: '005',
            name: '卡片浮现',
            category: '入场',
            summary: '卡片轻柔缩放浮现',
            spec: ['Start at scale 0.95 and opacity 0'],
            renderer_skill: 'card-kit',
          },
        ],
        renderer_skills: [{ name: 'card-kit', dir: 'skill', summary: '卡片技能', scenes: 'opt-in' }],
      }),
      'skill/SKILL.md': '# card-kit\n',
    });
    flow.installStation(`link:${pluginDir}`);

    const listed = await runCLI(['motion-effect', 'list', '--source', 'other-motion']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('other-motion:005');
    expect(listed.stdout).toContain('[技能: other-motion/card-kit]');

    // 重名编号 005 须提示写完整标识。
    const ambiguous = await runCLI(['motion-effect', 'show', '005']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain('motion-prompt:005');
    expect(ambiguous.stderr).toContain('other-motion:005');

    const exact = await runCLI(['motion-effect', 'show', 'other-motion:005']);
    expect(exact.code, exact.stderr).toBe(0);
    expect(exact.stdout).toContain('配套渲染技能：other-motion/card-kit');
    expect(exact.stdout).toContain('Start at scale 0.95');
  });
});
