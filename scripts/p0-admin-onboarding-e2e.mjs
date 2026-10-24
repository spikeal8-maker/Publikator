import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'publikator-p0-auth-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='p0-admin-master-key-over-32-characters-keep-consistent';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';
process.env.TRUST_PROXY='127.0.0.1';
const {db,migrate} = await import('../dist/db.js');
const {buildApp} = await import('../dist/app.js');
const {adminMode,createAdminSetupGrant,hasAdmin,sessionAdmin} = await import('../dist/admin-auth.js');
migrate();
let app = await buildApp();
const origin = 'https://publisher.example.test';

function cookie(reply) {
  const value=String(reply.headers['set-cookie'] || '');
  assert.match(value,/HttpOnly/i);
  assert.match(value,/SameSite=Strict/i);
  assert.match(value,/Secure/i);
  return value.split(';')[0];
}
async function send(method,url,payload,headers={}){
  return app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
}
try {
  assert.equal(adminMode(),'setup');
  assert.equal(hasAdmin(),false);
  const state=await send('GET','/api/auth/state');
  assert.deepEqual(state.json(),{mode:'setup',authenticated:false,username:null});
  const localGuess=await send('POST','/api/auth/setup',{username:'thief',password:'strong-guess-12345',confirmPassword:'strong-guess-12345'},{
    host:'localhost:8080','x-forwarded-for':'127.0.0.1',origin
  });
  assert.equal(localGuess.statusCode,403,'loopback/bridge/proxy must not grant bootstrap');
  assert.equal(hasAdmin(),false);

  const grant=createAdminSetupGrant('INITIAL');
  const firstUser={grant,username:'publikator_admin',password:'unique-long-password-2026',confirmPassword:'unique-long-password-2026'};
  const evilOrigin=await send('POST','/api/auth/setup',firstUser,{origin:'https://attacker.example.org'});
  assert.equal(evilOrigin.statusCode,403);
  const invalid=await send('POST','/api/auth/setup',{...firstUser,grant:'a'.repeat(43)}, {origin});
  assert.equal(invalid.statusCode,403);
  const rejectedBeforeHash = await send('POST','/api/auth/setup',{
    grant:'z'.repeat(43),username:'!!not a username!!',
    password:'short',confirmPassword:'unrelated'
  }, {origin});
  assert.equal(rejectedBeforeHash.statusCode,403,'unauthorized setup must be rejected before password hashing');

  // Concurrent first-user claims cannot create multiple owners or reuse grant.
  const claimed=await Promise.all([
    send('POST','/api/auth/setup',firstUser,{origin}),
    send('POST','/api/auth/setup',firstUser,{origin})
  ]);
  assert.deepEqual(claimed.map(r=>r.statusCode).sort(),[201,403]);
  const signed=cookie(claimed.find(r=>r.statusCode===201));
  assert.equal(db.prepare('SELECT count(*) AS n FROM admin_users').get().n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM admin_setup_grants').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM admin_sessions').get().n,1);
  assert.equal(db.prepare("SELECT count(*) as n FROM sqlite_master WHERE name='admin_users'").get().n,1);
  const administrator=db.prepare('SELECT * FROM admin_users').get();
  assert.ok(!JSON.stringify(administrator).includes(firstUser.password));
  assert.notEqual(administrator.password_hash,firstUser.password);
  assert.equal(administrator.password_salt.length,48);
  assert.equal(administrator.password_hash.length,128);
  assert.equal((await send('GET','/api/dashboard',undefined,{cookie:signed})).statusCode,200);
  assert.equal((await send('GET','/api/auth/state',undefined,{cookie:signed})).json().username,'publikator_admin');
  assert.equal((await send('POST','/api/auth/login',{username:'publikator_admin',password:'bad-password'}, {origin})).statusCode,401);
  assert.equal((await send('POST','/api/auth/login',{password:'unique-long-password-2026'}, {origin})).statusCode,401,'login requires username');

  const good=await send('POST','/api/auth/login',{username:'publikator_admin',password:firstUser.password},{origin});
  assert.equal(good.statusCode,200,good.body);
  const another=cookie(good);
  assert.equal((await send('GET','/api/dashboard',undefined,{cookie:another})).statusCode,200);
  assert.equal((await send('POST','/api/auth/logout',undefined,{cookie:another,origin})).statusCode,200);
  assert.equal((await send('GET','/api/dashboard',undefined,{cookie:another})).statusCode,401);
  assert.equal((await send('GET','/api/dashboard',undefined,{cookie:signed})).statusCode,200);

  const changed=await send('POST','/api/auth/password',{
    currentPassword:firstUser.password,
    newPassword:'second-new-password-2026',
    confirmPassword:'second-new-password-2026'
  },{cookie:signed,origin});
  assert.equal(changed.statusCode,200,changed.body);
  const rotated=cookie(changed);
  assert.equal((await send('GET','/api/dashboard',undefined,{cookie:signed})).statusCode,401);
  assert.equal((await send('POST','/api/auth/login',{username:'publikator_admin',password:firstUser.password},{origin})).statusCode,401);
  assert.equal((await send('GET','/api/dashboard',undefined,{cookie:rotated})).statusCode,200);

  await app.close();
  app=await buildApp(); // Same persistent database, simulated application restart
  assert.equal((await send('GET','/api/dashboard',undefined,{cookie:rotated})).statusCode,200);
  const loginAgain=await send('POST','/api/auth/login',{username:'publikator_admin',password:'second-new-password-2026'},{origin});
  assert.equal(loginAgain.statusCode,200,loginAgain.body);

  const recoverGrant=createAdminSetupGrant('RECOVER');
  const denied=await send('POST','/api/auth/recover',{grant:'x'.repeat(43),username:'attacker',
    password:'new-attack-password-2026',confirmPassword:'new-attack-password-2026'}, {origin});
  assert.equal(denied.statusCode,403);
  const recovered=await send('POST','/api/auth/recover',{grant:recoverGrant,
    username:'owner_restored',password:'recovered-password-2026',confirmPassword:'recovered-password-2026'}, {origin});
  assert.equal(recovered.statusCode,200,recovered.body);
  assert.equal((await send('GET','/api/dashboard',undefined,{cookie:rotated})).statusCode,401);
  assert.equal((await send('GET','/api/dashboard',undefined,{cookie:cookie(recovered)})).statusCode,200);
  assert.equal((await send('POST','/api/auth/login',{username:'publikator_admin',password:'second-new-password-2026'},{origin})).statusCode,401);
  assert.equal((await send('POST','/api/auth/login',{username:'owner_restored',password:'recovered-password-2026'},{origin})).statusCode,200);
  assert.equal(sessionAdmin(cookie(recovered).split('=')[1])?.username,'owner_restored');
  console.log(JSON.stringify({ok:true,setupProtected:true,oneOwner:true,hash:'scrypt',sessionSurvivesRestart:true,passwordRotation:true,logoutRevokes:true,recoveryRequiresInstaller:true}));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
