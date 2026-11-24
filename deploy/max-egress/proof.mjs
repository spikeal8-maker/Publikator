// Read-only real-network proof, run ONLY inside isolated app-side container.
// Set MAX_EGRESS_PROXY_URL=http://max-egress:3128; no credentials or mounted production data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { maxFetch } from '../../dist/platforms/max-transport.js';
const allowed = ['platform-api2.max.ru', 'iu.oneme.ru', 'omub.okcdn.ru'];
assert.equal(process.env.MAX_EGRESS_PROXY_URL, 'http://max-egress:3128');
function connectStatus(authority) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'max-egress', port: 3128, method: 'CONNECT', path: authority,
      timeout: 5000
    });
    req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}
for (const host of allowed) {
  const r = await maxFetch('https://' + host + (host === allowed[0] ? '/me' : '/'),
    { signal: AbortSignal.timeout(15000) });
  console.log('ALLOWED_TLS', host, r.status);
  assert.ok(host === allowed[0] ? r.status === 401 : r.status >= 200 && r.status < 500);
  await r.body?.cancel();
}
for (const authority of ['sheets.googleapis.com:443', 'api.telegram.org:443', 'api.vk.com:443',
  '127.0.0.1:443', '169.254.169.254:443', 'platform-api2.max.ru:444', 'evil.example:443']) {
  assert.equal(await connectStatus(authority), 403);
  console.log('DENIED_CONNECT', authority);
}
for (const url of ['http://platform-api2.max.ru/', 'https://sheets.googleapis.com/',
  'https://127.0.0.1/', 'https://platform-api2.max.ru:444/']) {
  await assert.rejects(maxFetch(url));
}
await assert.rejects(fetch('https://sheets.googleapis.com/', { signal: AbortSignal.timeout(5000) }));
console.log('DENIED_DIRECT sheets.googleapis.com');
const routes = fs.readFileSync('/proc/net/route','utf8');
assert.ok(!routes.split('\n').slice(1).some(line => line.trim().split(/\s+/)[1] === '00000000'));
console.log('NO_DEFAULT_ROUTE PASS');
console.log('MAX-ONLY EGRESS PROOF PASS');
