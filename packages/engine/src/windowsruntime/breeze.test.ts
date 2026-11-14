import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { designStatus } from '../voice';
import { BreezeModelBytes, BreezeModelSHA256, windowsBreezePaths, windowsBreezeStatus, writeWindowsBreezeAdapter } from './breeze';

describe('Windows Breeze readiness', () => {
  it('does not treat a dropdown choice or command shim as a prepared model', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-breeze-'));
    onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = { ONSET_WINDOWS_RESOURCES_DIR: home };
    writeWindowsBreezeAdapter(env);
    expect(windowsBreezeStatus(env, 'win32').ok).toBe(false);
    expect(designStatus(env, 'win32', 'x64')).toMatchObject({ supported: true, ready: false });
    expect(windowsBreezeStatus(env, 'darwin').ok).toBe(false);
  });
  it('invalidates a verified install when model metadata or required CUDA files change', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-breeze-'));
    onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = { ONSET_WINDOWS_RESOURCES_DIR: home };
    const p = windowsBreezePaths(env);
    writeWindowsBreezeAdapter(env);
    fs.mkdirSync(path.dirname(p.binary), { recursive: true });
    fs.mkdirSync(path.dirname(p.marker), { recursive: true });
    const names = ['audiocpp_cli.exe', 'ggml.dll', 'ggml-base.dll', 'ggml-cuda.dll', 'cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll'];
    const files = Object.fromEntries(names.map(name => { const file = path.join(path.dirname(p.binary), name); fs.writeFileSync(file, 'fixture'); const stat = fs.statSync(file); return [name, { size: stat.size, mtime_ms: stat.mtimeMs }]; }));
    let modelSize = BreezeModelBytes;
    const stat = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike) => file === p.model ? { size: modelSize, mtimeMs: 123 } : stat(file)) as typeof fs.statSync);
    onTestFinished(() => spy.mockRestore());
    fs.writeFileSync(p.marker, JSON.stringify({ runtime_version: '0.9.4', model_sha256: BreezeModelSHA256, model_mtime_ms: 123, synthesis_verified: true, backend: 'cuda', runtime_files: files }));
    expect(windowsBreezeStatus(env, 'win32').ok).toBe(true);
    modelSize--;
    expect(windowsBreezeStatus(env, 'win32').ok).toBe(false);
    modelSize++;
    fs.unlinkSync(path.join(path.dirname(p.binary), 'cublas64_12.dll'));
    expect(windowsBreezeStatus(env, 'win32').ok).toBe(false);
  });
  it('preserves existing WAVs and requires reference text before launching synthesis', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-breeze-'));
    onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = { ONSET_WINDOWS_RESOURCES_DIR: home };
    const p = windowsBreezePaths(env);
    writeWindowsBreezeAdapter(env);
    const entry = path.join(path.dirname(p.bin), 'breeze-tts.cjs');
    const model = path.join(home, 'fixture.gguf');
    fs.writeFileSync(model, 'model');
    const wav = path.join(home, 'approved.wav');
    fs.writeFileSync(wav, 'approved audio');
    expect(() => execFileSync(process.execPath, [entry, '--model', model, '--text', '测试', '--output', wav], { stdio: 'pipe', windowsHide: true })).toThrow();
    expect(fs.readFileSync(wav, 'utf8')).toBe('approved audio');
    expect(() => execFileSync(process.execPath, [entry, '--model', model, '--text', '测试', '--ref_audio', wav], { stdio: 'pipe', windowsHide: true })).toThrow();
  });
});
