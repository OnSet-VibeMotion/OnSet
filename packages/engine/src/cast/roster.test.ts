import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { goodSVG, goodYAML, tempDir } from './fixtures';
import { PackFile } from './pack';
import { RosterFile, hasRoster, loadPacks, loadRoster } from './roster';

function writeRosterProject(roster: string, ...packIDs: string[]): string {
  const root = tempDir();
  if (roster !== '') fs.writeFileSync(path.join(root, RosterFile), roster);
  for (const id of packIDs) {
    const dir = path.join(root, 'cast', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PackFile), goodYAML.replace('id: heiwa', 'id: ' + id));
    fs.writeFileSync(path.join(dir, 'rig.svg'), goodSVG);
  }
  return root;
}

const goodRoster = `schema: cast/v1
packs: [cast/heiwa, cast/zhaocai]
defaults:
  ground_y: 0.78
  gap_ms: { turn: 240, interject: 100 }
`;

const rosterWithPacks = (packs: string) => `schema: cast/v1
packs: ${packs}
defaults:
  ground_y: 0.78
  gap_ms: { turn: 240, interject: 100 }
`;

describe('roster', () => {
  it('hasRoster', () => {
    // 没有 cast.yaml 时应判为单口播模式，有则为多角色模式。
    expect(hasRoster(writeRosterProject(''))).toBe(false);
    expect(hasRoster(writeRosterProject(goodRoster, 'heiwa', 'zhaocai'))).toBe(true);
  });

  it('loadPacks keyed by id', () => {
    const root = writeRosterProject(goodRoster, 'heiwa', 'zhaocai');
    const roster = loadRoster(root);
    expect(roster.defaults.ground_y).toBe(0.78);
    expect(roster.defaults.gap_ms.interject).toBe(100);
    const packs = loadPacks(roster, root);
    expect(Object.keys(packs)).toHaveLength(2);
    expect(packs.zhaocai.id).toBe('zhaocai');
  });

  it('loadPacks reports missing dir', () => {
    const root = writeRosterProject(goodRoster, 'heiwa');
    expect(() => loadPacks(loadRoster(root), root)).toThrow('zhaocai');
  });

  // packs: [../outside] 这样的相对路径逃逸被拒。
  it('loadPacks rejects path escape with dot-dot', () => {
    const root = writeRosterProject('', 'heiwa');
    fs.writeFileSync(path.join(root, RosterFile), rosterWithPacks('[../outside]'));
    expect(() => loadPacks(loadRoster(root), root)).toThrow('cast.yaml 的 packs 不得逃出项目目录：../outside');
  });

  // 指向项目外目录的软链被拒。
  it('loadPacks rejects symlink outside project', () => {
    const root = writeRosterProject('', 'heiwa');
    const dir = path.join(tempDir(), 'outside-pack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PackFile), goodYAML.replace('id: heiwa', 'id: outside'));
    fs.writeFileSync(path.join(dir, 'rig.svg'), goodSVG);
    const castDir = path.join(root, 'cast');
    fs.mkdirSync(castDir, { recursive: true });
    fs.symlinkSync(dir, path.join(castDir, 'outside'));
    fs.writeFileSync(path.join(root, RosterFile), rosterWithPacks('[cast/outside]'));
    expect(() => loadPacks(loadRoster(root), root)).toThrow('不得逃出');
  });

  it('loadPacks accepts normal path', () => {
    const root = writeRosterProject(goodRoster, 'heiwa', 'zhaocai');
    const packs = loadPacks(loadRoster(root), root);
    expect(Object.keys(packs)).toHaveLength(2);
    expect(packs.heiwa.id).toBe('heiwa');
  });

  // 允许空 packs 列表：am init --narration cast 刚建的项目还没引入任何角色包，
  // 需要通过后续 am cast add 来添加。"班底为空"的检查由项目级校验负责。
  it('loadRoster allows empty packs', () => {
    const root = writeRosterProject('');
    fs.writeFileSync(path.join(root, RosterFile), rosterWithPacks('[]'));
    const roster = loadRoster(root);
    expect(roster.packs).toEqual([]);
    expect(loadPacks(roster, root)).toEqual({});
  });

  // cast.yaml 是目录时被判为不存在。
  it('hasRoster rejects directory', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, RosterFile), { recursive: true });
    expect(hasRoster(root)).toBe(false);
  });
});
