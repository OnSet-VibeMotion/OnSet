import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { envMap, windowsPython } from '../envutil';
import { start } from '../procgroup';
import installer from './breeze-install.py.tmpl';

const python = process.platform === 'win32' ? windowsPython(envMap()) : '';
it.skipIf(!python)('resumes a disconnected asset range and verifies the entire file before publishing', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-download-resume-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = Buffer.alloc(262144);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const starts: number[] = [];
  const server = http.createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')!;
    const first = Number(range[1]), last = Number(range[2]);
    starts.push(first);
    response.writeHead(206, { 'Content-Range': `bytes ${first}-${last}/${body.length}`, 'Content-Length': last - first + 1, Connection: 'close' });
    response.end(starts.length === 1 ? body.subarray(0, 65536) : body.subarray(first, last + 1));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as { port: number };
  const source = path.join(root, 'installer.py'); fs.writeFileSync(source, installer);
  const target = path.join(root, 'asset.bin');
  const harness = `import ast,pathlib,sys\ns=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8');t=ast.parse(s);ns={}\nexec(compile(ast.Module(body=[n for n in t.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef))],type_ignores=[]),'<asset downloader>','exec'),ns)\nns['parallel_fetch']((sys.argv[2],pathlib.Path(sys.argv[3]),sys.argv[4],int(sys.argv[5])))\n`;
  const process = await start(python, ['-c', harness, source, `http://127.0.0.1:${address.port}/asset`, target, digest, String(body.length)], { env: { ...envMap(), NO_PROXY: '127.0.0.1', PYTHONUTF8: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; process.child.stderr!.on('data', data => error += data.toString());
  try { await process.wait(); } catch { throw new Error(error); }
  expect(fs.readFileSync(target)).toEqual(body);
  expect(starts).toEqual([0, 65536]);
});
