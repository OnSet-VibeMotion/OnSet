import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DiagnosticBuffer, providerDiagnostic } from './diagnostic';
import { generate } from './generate';
import { Store } from './store';
import { Buf, cleanupTemps, fakeEnvironment, walkFiles } from './testsupport';

afterEach(cleanupTemps);

describe('provider diagnostic', () => {
  it('redacts secrets', () => {
    const raw =
      '{"error":{"code":4,"message":"quota exceeded; api_key=hidden123 Bearer token456 https://host/audio?token=secret sk-longsecretvalue1234567890 env-password","hint":"check quota"}}';
    let d = providerDiagnostic(Buffer.from(raw), { SERVICE_PASSWORD: 'env-password' });
    for (const secret of ['hidden123', 'token456', 'https://host', 'sk-longsecretvalue1234567890', 'env-password']) {
      expect(d.message.includes(secret), `leaked ${secret}`).toBe(false);
    }
    expect(d.code).toBe(4);
    expect(d.message).toContain('quota exceeded');
    d = providerDiagnostic(Buffer.from('opaque-secret-provider-output'), null);
    expect(d.message.includes('opaque-secret')).toBe(false);
  });

  it('bounded capture', () => {
    const b = new DiagnosticBuffer();
    const payload = Buffer.from('x'.repeat(100000));
    expect(b.write(payload)).toBe(payload.length);
    expect(b.data.length).toBe(65536);
  });

  it('generate retains redacted provider failure', async () => {
    const { root, env } = fakeEnvironment();
    const script = `#!/bin/sh
printf '%s' '{"error":{"code":1,"message":"Music API unavailable (HTTP 410); api_key=private-test-key"}}' >&2
exit 1
`;
    fs.writeFileSync(path.join(env.PATH, 'mmx'), script, { mode: 0o755 });
    const err = await generate(root, 1, 'diagnostic', env, new Buf()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain('HTTP 410');
    expect(err!.message.includes('private-test-key')).toBe(false);
    const files = walkFiles(path.join(root, Store, 'candidates')).filter((f) => path.basename(f) === 'provider-error.json');
    expect(files.length).toBe(1);
    const body = fs.readFileSync(files[0], 'utf8');
    expect(body).toContain('HTTP 410');
    expect(body.includes('private-test-key')).toBe(false);
  });
});
