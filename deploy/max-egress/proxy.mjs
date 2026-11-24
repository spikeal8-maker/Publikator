// Dedicated MAX CONNECT gateway. No generic HTTP forwarding, no TLS interception.
// This installation-only service is intentionally NOT enabled in the default Compose.
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { Resolver } from 'node:dns/promises';

const allowed = new Set(['platform-api2.max.ru:443', 'iu.oneme.ru:443', 'omub.okcdn.ru:443']);
const bind = process.env.MAX_PROXY_BIND_ADDRESS;
const client = process.env.MAX_PROXY_CLIENT_ADDRESS;
const interfaces = Object.values(os.networkInterfaces()).flat();
if (net.isIP(bind || '') !== 4 || !interfaces.some(i => i && !i.internal && i.address === bind)
    || net.isIP(client || '') !== 4 || bind === client) {
  throw new Error('MAX gateway requires explicit private listener and client addresses');
}
const resolver = new Resolver({ timeout: 2500, tries: 2 });
const idleMs = 135_000;
const connectMs = 10_000;
let active = 0;

function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}
function reject(socket, status) {
  if (!socket.destroyed) socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}
const server = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
server.headersTimeout = 5_000;
server.requestTimeout = 10_000;
server.maxHeadersCount = 32;
server.maxConnections = 24;
server.on('clientError', (_err, socket) => socket.destroy());

server.on('connect', async (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  socket.setTimeout(idleMs, () => socket.destroy());
  if (socket.remoteAddress?.replace(/^::ffff:/, '') !== client || !allowed.has(req.url)) {
    reject(socket, '403 Forbidden');
    return;
  }
  if (active >= 8) {
    reject(socket, '503 Service Unavailable');
    return;
  }
  active++;
  socket.once('close', () => { active--; });
  let addresses;
  try { addresses = await resolver.resolve4(req.url.slice(0, -4)); }
  catch { reject(socket, '502 Bad Gateway'); return; }
  if (socket.destroyed) return;
  if (!addresses.length || !addresses.every(publicIPv4)) {
    reject(socket, '403 Forbidden');
    return;
  }
  // Connect to the already validated numeric address: no second DNS lookup.
  const upstream = net.connect({ host: addresses[0], port: 443 });
  let established = false;
  const deadline = setTimeout(() => upstream.destroy(new Error('connect timeout')), connectMs);
  deadline.unref();
  upstream.on('error', () => {
    if (!established) reject(socket, '502 Bad Gateway');
    else socket.destroy();
  });
  socket.once('close', () => upstream.destroy());
  upstream.once('close', () => {
    clearTimeout(deadline);
    if (established) socket.destroy();
  });
  upstream.once('connect', () => {
    clearTimeout(deadline);
    if (socket.destroyed) { upstream.destroy(); return; }
    established = true;
    upstream.setTimeout(idleMs, () => upstream.destroy());
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
});
server.listen(3128, bind, () => console.log('MAX gateway ready on private interface'));
