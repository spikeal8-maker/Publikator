// Installation-only, TLS-preserving MAX CONNECT gateway. No generic HTTP proxy.
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { Resolver } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

const ALLOWED = new Set(['platform-api2.max.ru:443', 'iu.oneme.ru:443', 'omub.okcdn.ru:443']);
const MAX_HELLO_BYTES = 64 * 1024;
const MAX_HANDSHAKE_BYTES = 48 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;

export function publicIPv4(ip) {
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
function privateIPv4(ip) {
  if (net.isIP(ip || '') !== 4) return false;
  const [a,b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Only a well-formed plaintext ClientHello with exactly the requested DNS SNI
// is allowed. ECH/ESNI is refused: the effective hostname must be observable.
function matchesServerName(hello, expected) {
  try {
    let p = 0;
    const take = n => {
      if (!Number.isInteger(n) || n < 0 || p + n > hello.length) throw Error('truncated hello');
      const value = hello.subarray(p,p+n); p += n; return value;
    };
    const u8 = () => take(1)[0];
    const u16 = () => take(2).readUInt16BE();
    const version = u16();
    if (version < 0x0301 || version > 0x0303) return false;
    take(32);
    const sessionSize = u8();
    if (sessionSize > 32) return false;
    take(sessionSize);
    const cipherSize = u16();
    if (!cipherSize || cipherSize % 2) return false;
    take(cipherSize);
    const compressionSize = u8();
    if (!compressionSize) return false;
    take(compressionSize);
    const extensionSize = u16();
    if (extensionSize !== hello.length - p) return false;
    const seen = new Set();
    let nameMatches = false;
    while (p < hello.length) {
      const type = u16();
      const data = take(u16());
      if (seen.has(type) || type === 0xfe0d || type === 0xffce) return false;
      seen.add(type);
      if (type !== 0) continue;
      if (data.length < 5 || data.readUInt16BE(0) !== data.length - 2 || data[2] !== 0) return false;
      const nameLength = data.readUInt16BE(3);
      if (!nameLength || nameLength !== data.length - 5) return false;
      nameMatches = data.subarray(5).equals(Buffer.from(expected, 'ascii'));
      if (!nameMatches) return false;
    }
    return nameMatches;
  } catch { return false; }
}

// Return "need", "deny", or "allow". TLS records and the ClientHello may be
// fragmented. No bytes are forwarded before validation; the entire prefix is
// replayed unmodified once approved. TLS remains end-to-end.
export function inspectClientHello(prefix, expected) {
  if (prefix.length > MAX_HELLO_BYTES) return 'deny';
  let offset = 0;
  let records = 0;
  let handshake = Buffer.alloc(0);
  while (offset < prefix.length) {
    if (++records > 64) return 'deny';
    if (prefix[offset] !== 22) return 'deny';
    if (prefix.length - offset < 5) return 'need';
    const version = prefix.readUInt16BE(offset+1);
    const size = prefix.readUInt16BE(offset+3);
    if (version < 0x0301 || version > 0x0303 || !size || size > MAX_RECORD_BYTES) return 'deny';
    if (prefix.length - offset - 5 < size) return 'need';
    handshake = Buffer.concat([handshake, prefix.subarray(offset+5,offset+5+size)]);
    if (handshake[0] !== 1) return 'deny';
    if (handshake.length >= 4) {
      const length = handshake.readUIntBE(1,3);
      if (length > MAX_HANDSHAKE_BYTES || length < 40) return 'deny';
      if (handshake.length >= length + 4) {
        return matchesServerName(handshake.subarray(4,4+length),expected) ? 'allow' : 'deny';
      }
    }
    offset += 5 + size;
  }
  return 'need';
}

function reject(socket, status) {
  if (!socket.destroyed) socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
}

function readClientHello(socket, head, expected, timeoutMs) {
  return new Promise((resolve,rejectHello) => {
    let prefix = Buffer.alloc(0);
    let chunks = 0;
    let settled = false;
    const finish = (err,bytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('end', onClose);
      socket.pause();
      if (err) rejectHello(err); else resolve(bytes);
    };
    const onClose = () => finish(new Error('TLS hello closed'));
    const onData = chunk => {
      if (++chunks > 256 || prefix.length + chunk.length > MAX_HELLO_BYTES) return finish(new Error('TLS hello limit'));
      prefix = Buffer.concat([prefix,chunk]);
      const result = inspectClientHello(prefix,expected);
      if (result === 'deny') finish(new Error('TLS hello rejected'));
      else if (result === 'allow') finish(null,prefix);
    };
    const deadline = setTimeout(() => finish(new Error('TLS hello timeout')),timeoutMs);
    deadline.unref();
    socket.on('data',onData);
    socket.once('close',onClose);
    socket.once('end',onClose);
    if (socket.destroyed) onClose();
    else {
      if (head.length) onData(head);
      if (!settled) socket.resume();
    }
  });
}

// Resolver and dial injection are only for offline tests. The deployed entrypoint
// always constructs its own DNS resolver and numeric IPv4 TCP connection.
export function createMaxGateway({
  clientAddress, resolve4, dial = ip => net.connect({host:ip,port:443,family:4}),
  maxTunnels = 8, helloTimeoutMs = 5000, connectTimeoutMs = 10000, idleMs = 135000
}) {
  let active = 0;
  const server = http.createServer({connectionsCheckingInterval:1000,maxHeaderSize:8192}, (_req,res) => {res.writeHead(403);res.end();});
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.maxHeadersCount = 32;
  server.maxConnections = 24;
  server.timeout = idleMs;
  server.on('clientError',(_err,socket)=>socket.destroy());

  server.on('connect',async(req,socket,head)=>{
    socket.on('error',()=>socket.destroy());
    socket.setTimeout(idleMs,()=>socket.destroy());
    if (socket.remoteAddress?.replace(/^::ffff:/,'') !== clientAddress || !ALLOWED.has(req.url)) {
      reject(socket,'403 Forbidden'); return;
    }
    if (active >= maxTunnels) {reject(socket,'503 Service Unavailable');return;}
    active++;
    socket.once('close',()=>{active--;});
    socket.pause();
    const hostname = req.url.slice(0,-4);
    let addresses;
    try {addresses = await resolve4(hostname);}
    catch {reject(socket,'502 Bad Gateway');return;}
    if (socket.destroyed) return;
    if (!Array.isArray(addresses) || !addresses.length || !addresses.every(publicIPv4)) {
      reject(socket,'403 Forbidden');return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let prefix;
    try {prefix = await readClientHello(socket,head,hostname,helloTimeoutMs);}
    catch {socket.destroy();return;}
    if (socket.destroyed) return;
    // Connect only after SNI validation, using the already validated numeric
    // address (no DNS re-resolution and no application-level TLS interception).
    let upstream;
    try {upstream = dial(addresses[0]);}
    catch {socket.destroy();return;}
    const deadline = setTimeout(()=>upstream.destroy(),connectTimeoutMs);
    deadline.unref();
    upstream.on('error',()=>socket.destroy());
    socket.once('close',()=>upstream.destroy());
    upstream.once('close',()=>{clearTimeout(deadline);socket.destroy();});
    upstream.once('connect',()=>{
      clearTimeout(deadline);
      if (socket.destroyed) {upstream.destroy();return;}
      upstream.setTimeout(idleMs,()=>upstream.destroy());
      upstream.write(prefix);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bind = process.env.MAX_PROXY_BIND_ADDRESS;
  const client = process.env.MAX_PROXY_CLIENT_ADDRESS;
  const interfaces = Object.values(os.networkInterfaces()).flat();
  if (!privateIPv4(bind) || !privateIPv4(client) || bind === client
    || !interfaces.some(i=>i && !i.internal && i.address === bind)) {
    throw new Error('MAX gateway requires explicit private listener and client addresses');
  }
  const resolver = new Resolver({timeout:2500,tries:2});
  createMaxGateway({clientAddress:client,resolve4:host=>resolver.resolve4(host)})
    .listen(3128,bind,()=>console.log('MAX gateway ready on private interface'));
}
