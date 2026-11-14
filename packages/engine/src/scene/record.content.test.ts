// 渲染记录按内容比镜头的输入文件（record.ts 的 inputDigest）：写法变了、别的镜头的字幕变了都不算输入变了；
// 旧记录（按字节记）对不上时到客户端的快照里找渲染时的内容再按内容比。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedInputs, fingerprint, inputMatchesRecord, inputsMatchRecord, RecordSchemaBytes, type RenderRecord } from './record';
import { load } from './scene';
import { dataScene, tempDir } from './testsupport';

/** dataScene 搬进一个项目（有 article-to-motion.conf）的 scenes/ 下：快照按项目根找。 */
function projectScene(): { root: string; dir: string } {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'article-to-motion.conf'), '');
  const dir = path.join(root, 'scenes', 'scene-002');
  fs.cpSync(dataScene().directory, dir, { recursive: true });
  return { root, dir };
}

function edit(file: string, from: string, to: string): void {
  const body = fs.readFileSync(file, 'utf8');
  expect(body).toContain(from);
  fs.writeFileSync(file, body.replace(from, to));
}

function record(dir: string, schema?: number): RenderRecord {
  const inputs = fingerprint(load(dir), 'claude', null, schema);
  return { schema: schema ?? 2, output: 'out.mp4', output_size: 0, output_sha256: '', ...inputs };
}

describe('render record compares input files by content', () => {
  it('does not count rewriting scene.json in another layout', () => {
    const { dir } = projectScene();
    const before = record(dir);
    const file = path.join(dir, 'scene.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 键换个顺序、缩进、5.000000 写成 5：编排工具用脚本重写时的样子。
    fs.writeFileSync(file, JSON.stringify({ text: value.text, ...value }, null, 2) + '\n');
    expect(fs.readFileSync(file, 'utf8')).toContain('"duration_seconds": 5,');
    expect(fingerprint(load(dir), 'claude', null).fingerprint).toBe(before.fingerprint);
    // 真改了内容照样算。
    edit(file, '"text": "hello"', '"text": "bye"');
    expect(changedInputs(fingerprint(load(dir), 'claude', null), before)).toContain('file:scene.json');
  });

  it('only counts the subtitles and phrases inside the scene', () => {
    const { dir } = projectScene();
    const before = record(dir);
    // 镜头覆盖 5–10 秒；第 1 条字幕（3–4.5 秒）与短语 p-1 在上一镜里。
    edit(path.join(dir, 'transcript.srt'), '上一镜的字幕', '上一镜改过的字幕');
    edit(path.join(dir, 'phrase-timeline.json'), '"source_text":"上一镜"', '"source_text":"上一镜改过"');
    expect(fingerprint(load(dir), 'claude', null).fingerprint).toBe(before.fingerprint);
    edit(path.join(dir, 'transcript.srt'), '本镜头内', '本镜头内改过');
    edit(path.join(dir, 'phrase-timeline.json'), 'GPU 跑满了', 'GPU 闲着');
    // 提示词里也列着本镜头的字幕与短语，所以 prompt 一起变。
    expect(changedInputs(fingerprint(load(dir), 'claude', null), before)).toEqual(['file:phrase-timeline.json', 'file:transcript.srt', 'prompt']);
  });

  it('checks an old byte record against the studio snapshot of the rendered file', () => {
    const { root, dir } = projectScene();
    const old = record(dir, RecordSchemaBytes);
    const srt = path.join(dir, 'transcript.srt');
    const rendered = fs.readFileSync(srt);
    edit(srt, '上一镜的字幕', '上一镜改过的字幕');
    const s = load(dir);
    // 快照里没有渲染时那份字幕：说不清变没变，算变了。
    expect(inputMatchesRecord(s, 'transcript.srt', old)).toBe(false);
    const blobs = path.join(root, 'production', 'studio', 'blobs');
    fs.mkdirSync(blobs, { recursive: true });
    fs.writeFileSync(path.join(blobs, crypto.createHash('sha256').update(rendered).digest('hex')), rendered);
    // 找到了：改的是上一镜的字幕，本镜头拿到的没变。
    expect(inputMatchesRecord(s, 'transcript.srt', old)).toBe(true);
    expect(inputsMatchRecord(s, fingerprint(s, 'claude', null, RecordSchemaBytes), old)).toBe(true);
    // 改到本镜头里的字幕：照样算变了。
    edit(srt, '本镜头内', '本镜头内改过');
    expect(inputMatchesRecord(load(dir), 'transcript.srt', old)).toBe(false);
  });
});
