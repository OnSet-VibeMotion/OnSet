/**
 * voice_*：音色库（@am/engine/voice）的四条操作。
 *
 * 删除不是操作：音色库是用户积累下来的声音，编排工具一句话删掉就找不回来，只在客户端的音色页里删。
 */
import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '@am/engine/envutil';
import * as voice from '@am/engine/voice';
import { bool, str } from './ops/common';
import { defineGroup } from './ops/cli';
import { ParamError, defineOp } from './ops/op';

function libraryDir(): string {
  const dir = voice.defaultDir(envMap());
  if (dir === '') throw new Error('无法确定音色库目录：环境里没有 HOME');
  return dir;
}

function voiceJSON(v: voice.VoiceEntry): Record<string, unknown> {
  return {
    name: v.name,
    audio: v.audio,
    text: v.text,
    source: v.source,
    ...(v.instruction ? { instruction: v.instruction } : {}),
    duration_seconds: v.duration_seconds,
    created: v.created,
    is_default: v.is_default,
  };
}

defineGroup({
  path: ['voice'],
  summary: '音色库：所有项目共用的参考音色，Breeze 从它克隆，保持同一个声音',
  description: `音色库放在用户级目录（AM_VOICES_DIR 可覆盖），所有项目共用。每个音色是一段确认过的参考音频
（转成 24kHz 单声道 WAV）加逐字一致的文字稿，用 Breeze 配音时从它克隆。

只靠一句描述设计音色每次生成都会漂，同一个账号的片子之间听起来像换了人；克隆出来的始终是同一个声音。

  voice_list()      看库里有哪些音色、默认是哪个
  voice_get()       取默认音色（或指定音色）的参考音频与文字稿，用来克隆
  voice_save()      把用户确认过的一段声音存进来
  voice_default()   换默认音色

删除只能在客户端的音色页里做。`,
});

defineOp({
  name: 'voice_list',
  cli: ['voice', 'list'],
  summary: '列出音色库里的音色（所有项目共用），标出默认音色',
  description: `音色库放在用户级目录，所有项目共用：每个音色是一段确认过的参考音频加逐字一致的文字稿，
Breeze TTS 2 从它克隆，同一个账号的每部片子都是同一个声音。

只靠一句描述设计音色每次生成都会漂；要长期保持同一个声音，就把确认过的那段存进来（voice_save()），
以后用 voice_get() 取出参考音频与文字稿克隆。`,
  examples: ['voice_list()'],
  params: {},
  run: (_p, { out }) => {
    const voices = voice.list(libraryDir());
    if (voices.length === 0) out.write('音色库还是空的：用户确认了一个声音后，用 voice_save() 存进来。\n');
    for (const v of voices) {
      out.write(`${v.is_default ? '★ ' : '  '}${v.name}（${v.duration_seconds.toFixed(1)} 秒）：${v.text}\n`);
    }
    return { data: { voices: voices.map(voiceJSON) } };
  },
});

defineOp({
  name: 'voice_get',
  cli: ['voice', 'get'],
  summary: '取一个音色的参考音频路径与文字稿（不给名字取默认音色），用来克隆',
  description: `返回参考音频的绝对路径（24kHz 单声道 WAV）与逐字一致的文字稿，分别交给 Breeze 的
--ref_audio 与 --ref_text。不给 name 时取默认音色；还没有默认音色时报错。`,
  examples: ['voice_get()', 'voice_get({"name": "老周"})'],
  params: {
    name: { type: 'string', description: '音色名；不填取默认音色', positional: 0 },
  },
  run: (p, { out }) => {
    const dir = libraryDir();
    let name = str(p.name);
    if (name === '') {
      name = voice.defaultName(dir);
      if (name === '') throw new ParamError('音色库里还没有默认音色：先按制作提示词试听、确认一个声音，再用 voice_save() 存进来');
    }
    const v = voice.get(dir, name);
    out.write(`音色：${v.name}${v.is_default ? '（默认）' : ''}\n参考音频：${v.audio}\n文字稿：${v.text}\n`);
    return { data: voiceJSON(v) };
  },
});

defineOp({
  name: 'voice_save',
  cli: ['voice', 'save'],
  summary: '把用户确认过的一段声音存进音色库，以后的片子都从它克隆',
  description: `audio 是项目里的一段音频（试听文件或用户上传的录音），text 是这段音频里说的话，必须逐字一致——
克隆时它就是 --ref_text，对不上会让克隆出来的声音含糊、吞字。音频转成 24kHz 单声道 WAV 存进
用户级的音色库，时长要在 ${voice.MinReferenceSeconds} 到 ${voice.MaxReferenceSeconds} 秒之间（一两句话）。

只存用户本人或已经取得授权的声音。同名音色已存在时报错，确实要替换加 overwrite。
库里还没有默认音色时，存进来的就是默认音色；make_default 让它成为默认。`,
  examples: [
    '# 用户试听后说「就这个声音，以后都用它」',
    'voice_save({"name": "沉稳男声", "audio": "production/audio/try-2.wav", "text_file": "production/audio/try-text.txt", "source": "designed", "instruction": "一位三十多岁的男性，声音沉稳清晰，语气平静、真诚", "make_default": true})',
    '',
    '# 用户上传了一段自己的录音',
    'voice_save({"name": "我的声音", "audio": "assets/voice/me.m4a", "text": "大家好，欢迎来到今天的节目。", "source": "recorded"})',
  ],
  params: {
    name: { type: 'string', description: '音色名：中文、字母、数字、- 和 _，最长 40 字', required: true, positional: 0 },
    audio: { type: 'string', description: '音频文件，相对项目根', required: true },
    text: { type: 'string', description: '音频里说的话，逐字一致；与 text_file 二选一' },
    text_file: { type: 'string', description: '存着文字稿的文本文件，相对项目根；与 text 二选一' },
    source: { type: 'string', description: '来源：designed（描述设计后确认的）、recorded（用户本人的录音）、uploaded（其他）', default: 'designed' },
    instruction: { type: 'string', description: '设计这个音色时用的描述（只作记录）' },
    make_default: { type: 'boolean', description: '设为默认音色' },
    overwrite: { type: 'boolean', description: '替换同名音色' },
  },
  run: async (p, { out, signal }) => {
    const text = str(p.text);
    const textFile = str(p.text_file);
    if ((text === '') === (textFile === '')) throw new ParamError('text 与 text_file 要给且只给一个');
    const source = str(p.source) as voice.Source;
    if (!voice.Sources.includes(source)) throw new ParamError(`source 只能是 ${voice.Sources.join('、')}`);
    const transcript = textFile === '' ? text : fs.readFileSync(path.resolve(textFile), 'utf8');
    const saved = await voice.save(libraryDir(), {
      name: str(p.name),
      audio: path.resolve(str(p.audio)),
      text: transcript,
      source,
      instruction: str(p.instruction),
      overwrite: bool(p.overwrite),
      makeDefault: bool(p.make_default),
      env: envMap(),
      signal,
    });
    out.write(`已存进音色库：${saved.name}（${saved.duration_seconds.toFixed(1)} 秒）${saved.is_default ? '，是默认音色' : ''}\n`);
    return { data: voiceJSON(saved) };
  },
});

defineOp({
  name: 'voice_default',
  cli: ['voice', 'default'],
  summary: '把音色库里的一个音色设为默认：新项目用 Breeze 配音时直接克隆它',
  description: `默认音色是用 Breeze 配音时不指定名字就克隆的那一个（voice_get() 不给 name 时取它）。
只在用户明确说「以后都用这个声音」时才改默认：它对所有项目生效，不只是这一部片子。`,
  examples: ['voice_default({"name": "沉稳男声"})'],
  params: {
    name: { type: 'string', description: '音色名', required: true, positional: 0 },
  },
  run: (p, { out }) => {
    const dir = libraryDir();
    voice.setDefault(dir, str(p.name));
    out.write(`默认音色：${str(p.name)}\n`);
    return { data: voiceJSON(voice.get(dir, str(p.name))) };
  },
});
