import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { createMaxGateway, inspectClientHello, publicIPv4 } from '../deploy/max-egress/proxy.mjs';

const host = 'platform-api2.max.ru';
const authority = host + ':443';
const u16 = n => { const b=Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u24 = n => { const b=Buffer.alloc(3); b.writeUIntBE(n,0,3); return b; };
const ext = (type,body) => Buffer.concat([u16(type),u16(body.length),body]);
const serverName = name => {
  const dns=Buffer.from(name);
  const entry=Buffer.concat([Buffer.from([0]),u16(dns.length),dns]);
  return ext(0,Buffer.concat([u16(entry.length),entry]));
};
const record = body => Buffer.concat([Buffer.from([22,3,1]),u16(body.length),body]);
const handshake = extensions => {
  const e=Buffer.concat(extensions);
  const hello=Buffer.concat([Buffer.from([3,3]),Buffer.alloc(32,1),Buffer.from([0]),
    u16(2),Buffer.from([0x13,1]),Buffer.from([1,0]),u16(e.length),e]);
  return Buffer.concat([Buffer.from([1]),u24(hello.length),hello]);
};
const hello = record(handshake([serverName(host)]));
const wrong = record(handshake([serverName('sheets.googleapis.com')]));
const noSni = record(handshake([]));
const ech = record(handshake([serverName(host),ext(0xfe0d,Buffer.from([1]))]));
const duplicate = record(handshake([serverName(host),serverName(host)]));
const h=handshake([serverName(host)]);
const fragmented=Buffer.concat([record(h.subarray(0,2)),record(h.subarray(2,20)),record(h.subarray(20))]);

for(const ip of ['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1',
  '192.168.0.1','192.0.0.8','192.0.2.1','192.88.99.1','198.18.1.2','198.51.100.1','203.0.113.1',
  '224.0.0.1','240.0.0.1','::1','::ffff:127.0.0.1','not-an-ip']) assert.equal(publicIPv4(ip),false,ip);
assert.equal(publicIPv4('1.1.1.1'),true);
for(let n=0;n<hello.length;n++) assert.equal(inspectClientHello(hello.subarray(0,n),host),'need',String(n));
for(const bytes of [hello,fragmented]) assert.equal(inspectClientHello(bytes,host),'allow');
for(const bytes of [wrong,noSni,ech,duplicate,Buffer.from('GET / HTTP/1.1\r\n\r\n'),
  Buffer.from([22,3,1,0,0]),Buffer.from([22,3,1,255,255]),Buffer.alloc(65537,22),
  Buffer.concat(Array.from({length:65},()=>record(Buffer.from([1]))))]) {
  assert.equal(inspectClientHello(bytes,host),'deny');
}
console.log('MAX DNS address policy and bounded TLS parser PASS');

// Capture a real Node/OpenSSL ClientHello, without a public network or a TLS bypass.
const capture = net.createServer();
capture.listen(0,'127.0.0.1');
await once(capture,'listening');
const accepted=once(capture,'connection');
const openssl=tls.connect({host:'127.0.0.1',port:capture.address().port,servername:host,rejectUnauthorized:true});
openssl.on('error',()=>{});
const [captureSocket]=await accepted;
let realHello=Buffer.alloc(0);
try {
  const timeout=setTimeout(()=>captureSocket.destroy(new Error('fixture capture timed out')),3000);
  try {
    for await(const data of captureSocket) {
      realHello=Buffer.concat([realHello,data]);
      const verdict=inspectClientHello(realHello,host);
      assert.notEqual(verdict,'deny');
      if(verdict==='allow') break;
    }
  } finally {clearTimeout(timeout);}
  assert.equal(inspectClientHello(realHello,host),'allow');
} finally {
  openssl.destroy();
  captureSocket.destroy();
  await new Promise(resolve=>capture.close(resolve));
}
console.log('MAX actual OpenSSL TLS ClientHello PASS');

const tracked=new Set();
function track(s){tracked.add(s);s.on('error',()=>{});s.once('close',()=>tracked.delete(s));return s;}
const incoming=[];
const upstream=net.createServer(s=>{
  track(s);
  s.on('data',chunk=>{incoming.push(Buffer.from(chunk));});
});
upstream.listen(0,'127.0.0.1');
await once(upstream,'listening');
let answers=['1.1.1.1'];
const dialed=[],resolved=[];
const gateway=createMaxGateway({
  clientAddress:'127.0.0.1',maxTunnels:2,helloTimeoutMs:750,
  resolve4:async name=>{resolved.push(name);if(answers instanceof Error) throw answers;return answers;},
  dial:ip=>{dialed.push(ip);return track(net.connect({host:'127.0.0.1',port:upstream.address().port}));}
});
gateway.on('connection',track);
gateway.listen(0,'127.0.0.1');
await once(gateway,'listening');
const port=gateway.address().port;
function connect(target=authority,localAddress='127.0.0.1'){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,method:'CONNECT',path:target,localAddress,timeout:3000});
    req.on('connect',(res,socket,head)=>{assert.equal(head.length,0);resolve({status:res.statusCode,socket:track(socket)});});
    req.on('error',reject);
    req.on('timeout',()=>req.destroy(new Error('CONNECT timeout')));
    req.end();
  });
}
async function closed(s){
  if(s.destroyed) return;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('socket did not close')),2500);
    s.once('close',()=>{clearTimeout(timer);resolve();});
  });
}
async function until(fn){
  const end=Date.now()+2500;
  while(!fn()){
    if(Date.now()>end) throw new Error('fixture condition timeout');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
async function denied(target,status,localAddress){
  const c=await connect(target,localAddress);
  try {assert.equal(c.status,status,target);}finally {c.socket.destroy();await closed(c.socket);}
}
async function rejectHello(bytes){
  const before=dialed.length;
  const c=await connect();
  assert.equal(c.status,200);
  if(bytes) c.socket.write(bytes);
  await closed(c.socket);
  assert.equal(dialed.length,before,'denied hello must not dial');
}
try {
  const bad=['sheets.googleapis.com:443','api.telegram.org:443','127.0.0.1:443',
    '169.254.169.254:443',host+':444',host.toUpperCase()+':443',host+'.:443','evil.example:443'];
  for(const target of bad) await denied(target,403);
  await denied(authority,403,'127.0.0.2');
  assert.equal(resolved.length,0);
  assert.equal(dialed.length,0);
  const plain=await fetch('http://127.0.0.1:'+port+'/');
  assert.equal(plain.status,403); await plain.body?.cancel();

  for(const a of [[],['127.0.0.1'],['1.1.1.1','10.0.0.1'],['::1']]){
    answers=a;await denied(authority,403);
  }
  answers=new Error('fixture DNS failure');
  await denied(authority,502);
  assert.equal(dialed.length,0);
  answers=['1.1.1.1','8.8.8.8'];

  for(const bytes of [wrong,noSni,ech,duplicate,Buffer.from('GET / HTTP/1.1\r\n\r\n')]) await rejectHello(bytes);
  await rejectHello(null);
  assert.equal(dialed.length,0);
  const c=await connect();
  assert.equal(c.status,200);
  assert.equal(dialed.length,0);
  for(const chunk of [fragmented.subarray(0,4),fragmented.subarray(4,12),fragmented.subarray(12)]){
    c.socket.write(chunk);
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  await until(()=>Buffer.concat(incoming).length>=fragmented.length);
  assert.equal(dialed.length,1);
  assert.equal(dialed[0],'1.1.1.1');
  assert.deepEqual(Buffer.concat(incoming),fragmented);
  c.socket.destroy();
  await until(()=>tracked.size===0 || tracked.size===1);

  const a=await connect(), b=await connect();
  assert.equal(a.status,200);assert.equal(b.status,200);
  await denied(authority,503);
  a.socket.destroy();b.socket.destroy();
  await until(()=>tracked.size===0 || tracked.size===1);
  const again=await connect();
  assert.equal(again.status,200,'slot must be released after disconnect');
  again.socket.destroy();
  console.log('MAX actual socket ACL, DNS fail-closed, SNI, tunnel limits and slot release PASS');
} finally {
  for(const s of tracked)s.destroy();
  await Promise.all([new Promise(resolve=>gateway.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);
}
