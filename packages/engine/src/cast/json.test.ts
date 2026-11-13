import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { goodSVG, goodYAML, writePack } from './fixtures';
import { load, writePackJSON } from './pack';

// character.json 是驱动库 cast.js 在无头 Chrome 里读取角色包的唯一格式：
// 浏览器端 CSP 下引不进 YAML 解析库。它每次校验都从 character.yaml 重新生成，
// 键名必须和 yaml 的小驼峰一致，本机绝对路径 dir 不得泄漏。
it('writePackJSON produces lower-camel keys without Dir', () => {
  const dir = writePack(goodYAML);
  fs.writeFileSync(path.join(dir, 'rig.svg'), goodSVG);
  const pack = load(dir);
  writePackJSON(pack, dir);
  const body = fs.readFileSync(path.join(dir, 'character.json'), 'utf8');
  const generic = JSON.parse(body) as Record<string, any>;
  for (const want of ['schema', 'id', 'name', 'summary', 'voice', 'rig', 'scale', 'poses']) expect(generic).toHaveProperty(want);
  expect(generic).not.toHaveProperty('Dir');
  expect(generic).not.toHaveProperty('dir');
  expect(body).not.toContain('Dir');
  expect(body).not.toContain(dir);
  for (const want of ['file', 'viewBox', 'baselineY', 'joints']) expect(generic.rig).toHaveProperty(want);
  expect(generic.voice.minimax).toHaveProperty('voiceId');
  expect(generic.scale).toHaveProperty('heightRatio');

  // 与 Go 的 json.MarshalIndent 逐字节一致：map 按键排序、nil 的 map / 指针为 null、没有末尾换行。
  expect(body).toBe(`{
  "schema": "cast/v1",
  "id": "heiwa",
  "name": "黑娃",
  "summary": "面无表情，认真做一件荒诞但成立的事",
  "voice": {
    "bailian": {
      "voiceId": "v-2",
      "speed": null,
      "rate": 0.98,
      "pitch": null,
      "volume": null,
      "instruction": "平静、真诚的语气"
    },
    "minimax": {
      "voiceId": "v-1",
      "speed": 0.98,
      "rate": null,
      "pitch": 0,
      "volume": null,
      "instruction": ""
    }
  },
  "rig": {
    "file": "rig.svg",
    "viewBox": [
      0,
      0,
      400,
      520
    ],
    "baselineY": 512,
    "joints": {
      "frontLeg": {
        "pivot": [
          176,
          330
        ],
        "rotate": [
          -40,
          55
        ]
      },
      "head": {
        "pivot": [
          200,
          168
        ],
        "rotate": [
          -18,
          18
        ]
      }
    }
  },
  "views": null,
  "turns": null,
  "scale": {
    "heightRatio": [
      0.22,
      0.32
    ]
  },
  "poses": {
    "idle": {},
    "pointing": {
      "frontLeg": 48,
      "head": -6
    }
  }
}`);
});
