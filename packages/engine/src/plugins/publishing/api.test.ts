/** /api/publish 给平台标题、平台话题里写到的平台附上中文名；两项都没写时不出这个字段（金样里的模板项目就是这样）。 */
import '../../studio/testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import * as assets from '../../assets';
import { newSessionFixture, studioRequest } from '../../studio/testsupport';

it('names the platforms used by per-platform titles and topics', async () => {
  const f = newSessionFixture();
  const template = fs.readFileSync(path.join(assets.assetsBase(), 'assets', 'shared', 'templates', 'publish.md'), 'utf8');
  const text = template.replace(
    '  hashtags: []\n',
    '  hashtags: ["片场"]\n  platform_titles:\n    douyin: "片场"\n  platform_hashtags:\n    xiaohongshu: ["片场", "活动"]\n',
  );
  expect(text).not.toBe(template);
  fs.writeFileSync(path.join(f.root, 'publish.md'), text);
  const r = await studioRequest(f.s, 'GET', '/api/publish');
  expect(r.status).toBe(200);
  const body = r.body as { platform_names?: Record<string, string>; data: { copy: { platform_hashtags: unknown } } };
  expect(body.platform_names).toEqual({ douyin: '抖音', xiaohongshu: '小红书' });
  expect(body.data.copy.platform_hashtags).toEqual({ xiaohongshu: ['片场', '活动'] });
});
