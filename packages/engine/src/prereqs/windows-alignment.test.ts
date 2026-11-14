import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FunASRTimestampModel } from '../config/providers';
import { modelDir } from '../toolinstall';
import { check } from './index';

it.skipIf(process.platform !== 'win32')('requires the timestamp model as well as funasr-python before Windows alignment is ready', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-windows-align-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'funasr-python.cmd'), '@echo off\r\n');
  const env = { XDG_DATA_HOME: root, ONSET_BIN_DIR: bin, PATH: '' };
  const status = () => check(env, { tts: 'edge', align: 'funasr' }).find((item) => item.id === 'align:funasr');
  const model = modelDir(FunASRTimestampModel, env);
  expect(status()).toMatchObject({ ready: false, location: model });
  fs.mkdirSync(model, { recursive: true });
  for (const file of FunASRTimestampModel.files) {
    const target = path.join(model, file.path);
    fs.writeFileSync(target, '');
    fs.truncateSync(target, file.size);
  }
  expect(status()?.ready).toBe(true);
  fs.truncateSync(path.join(model, 'model.pt'), 1);
  expect(status()?.ready).toBe(false);
});
