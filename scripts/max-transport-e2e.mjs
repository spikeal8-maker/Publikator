import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMaxDispatcher } from '../dist/platforms/max-transport.js';

// Real sockets and Node's built-in fetch: a provider-response mock cannot detect
// an incompatible Undici dispatch-handler contract (8.x vs Node 22's 6.x).
const dispatcher = createMaxDispatcher();
const plain = http.createServer((_request, response) => response.end('dispatcher-compatible'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-max-tls-'));
let secure;
try {
  await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
  const reply = await fetch('http://127.0.0.1:' + plain.address().port, { dispatcher, signal: AbortSignal.timeout(5000) });
  assert.equal(await reply.text(), 'dispatcher-compatible');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', path.join(temp, 'key.pem'), '-out', path.join(temp, 'cert.pem')], { stdio: 'ignore' });
  secure = https.createServer({ key: await fs.readFile(path.join(temp, 'key.pem')),
    cert: await fs.readFile(path.join(temp, 'cert.pem')) }, (_request, response) => response.end('must-not-trust'));
  await new Promise(resolve => secure.listen(0, '127.0.0.1', resolve));
  let failure;
  try {
    await fetch('https://127.0.0.1:' + secure.address().port, { dispatcher, signal: AbortSignal.timeout(5000) });
  } catch (error) { failure = error; }
  assert.ok(failure, 'MAX dispatcher must reject a certificate outside its trust roots');
  assert.equal(failure.cause?.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  console.log('MAX real dispatcher compatibility and TLS verification: PASS');
} finally {
  await dispatcher.close();
  await new Promise(resolve => plain.close(resolve));
  if (secure) await new Promise(resolve => secure.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
