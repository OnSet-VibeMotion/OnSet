import './testsupport';
import path from 'node:path';
import { expect, it } from 'vitest';
import { installStation, parseManifest, writeStationForTest } from '../flow';
import { rawGet, startStudio, studioRequest, tempDir } from './testsupport';

const alternate = {
  id: 'other-motion',
  name: '另一套动效',
  version: '1.2.3',
  motion_effects: [{ id: '005', name: '上浮', category: '入场', summary: '向上进入画面', renderer_skill: 'motion-kit' }],
  renderer_skills: [{ name: 'motion-kit', dir: 'skill', summary: '入场动画', scenes: 'opt-in' }],
};

it('lists bundled and installed effects under distinct source-qualified identifiers', async () => {
  const dir = writeStationForTest({
    'onset-station.json': JSON.stringify(alternate),
    'skill/SKILL.md': '# 动效',
  });
  installStation('link:' + dir);
  const studio = startStudio({ configPath: path.join(tempDir(), 'projects.json') });
  const response = await studioRequest(studio, 'GET', '/api/motion-effects');
  expect(response.status).toBe(200);
  expect(response.body.sources[0]).toMatchObject({
    id: 'motion-prompt',
    version: '683ecca0548a1754ada141d10dc3a009d4c59bef',
  });
  expect(response.body.sources[0].effects).toHaveLength(96);
  expect(response.body.sources[0].effects).toContainEqual(expect.objectContaining({
    id: '005', name: '遮罩显现', preview: '/preview/motion/005',
  }));
  expect(response.body.sources[1]).toMatchObject({
    id: 'other-motion', version: '1.2.3',
    effects: [{ id: '005', renderer_skill: 'motion-kit', name: '上浮' }],
  });
  expect((await studioRequest(studio, 'POST', '/api/motion-effects')).status).toBe(405);
  const preview = await rawGet(studio, '/preview/motion/005');
  expect(preview.status).toBe(200);
  expect(preview.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  expect(preview.text).toContain('<canvas');
  expect((await rawGet(studio, '/preview/motion/999')).status).toBe(404);
});

it('rejects duplicate effect identifiers, undeclared skills, unsafe example URLs and the bundled source identifier', () => {
  const effect = alternate.motion_effects[0];
  const parse = (motion_effects: unknown) => parseManifest(JSON.stringify({ ...alternate, motion_effects }));
  expect(() => parse([effect, effect])).toThrow(/重名/);
  expect(() => parse([{ ...effect, renderer_skill: 'missing' }])).toThrow(/renderer_skill/);
  expect(() => parse([{ ...effect, example_url: 'javascript:alert(1)' }])).toThrow(/HTTPS/);
  expect(() => parseManifest(JSON.stringify({ ...alternate, id: 'motion-prompt' }))).toThrow(/重名/);
});
