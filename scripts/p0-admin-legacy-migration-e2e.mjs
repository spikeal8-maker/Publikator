import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-legacy-auth-'));
process.env.DATA_DIR=dir;
process.env.NODE_ENV='test';
process.env.ADMIN_PASSWORD='legacy-test-password-2026';
process.env.APP_MASTER_KEY='legacy-test-encryption-key-with-over-thirty-two-characters';
process.env.PUBLIC_BASE_URL='http://127.0.0.1:18099';
const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {buildApp}=await import('../dist/app.js');
const {encryptJson,decryptJson,verifySessionToken}=await import('../dist/crypto.js');
migrate();
const project=db.prepare('SELECT id FROM projects LIMIT 1').get().id;
const account=id('acc'), post=id('post'), stamp=nowIso();
const encrypted=encryptJson({botToken:'test-telegram-credential',chatId:'@Alikin_SA'});
db.prepare('INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)')
  .run(account,'telegram','Existing channel',encrypted,stamp,stamp);
db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at) VALUES (?,?,?,?,'READY','APPROVED','MANUAL',?,?)")
  .run(post,project,'Existing READY','Existing body',stamp,stamp);
db.prepare("INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,1,'PENDING',0,?)")
  .run(id('target'),post,account,stamp);
const before={
  social:db.prepare('SELECT * FROM social_accounts').all(),
  posts:db.prepare('SELECT * FROM posts').all(),
  targets:db.prepare('SELECT * FROM post_targets').all()
};
let app=await buildApp();
try{
 const state=(await app.inject({method:'GET',url:'/api/auth/state'})).json();
 assert.equal(state.mode,'legacy');
 const old=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});
 assert.equal(old.statusCode,200,old.body);
 const oldCookie=String(old.headers['set-cookie']).split(';')[0];
 const oldToken=oldCookie.slice(oldCookie.indexOf('=')+1);
 assert.equal(verifySessionToken(oldToken),true);
 const segments=oldToken.split('.');
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
 const lastIndex=alphabet.indexOf(segments[2].slice(-1));
 assert.equal(lastIndex%4,0,'canonical SHA256 signature ends with a multiple-of-four sextet');
 const noncanonicalSignature=segments[2].slice(0,-1)+alphabet[lastIndex+1];
 const noncanonicalToken=segments[0]+'.'+segments[1]+'.'+noncanonicalSignature;
 assert.ok(Buffer.from(noncanonicalSignature,'base64url').equals(Buffer.from(segments[2],'base64url')));
 assert.equal(verifySessionToken(oldToken+'='),false,'padded signature must be denied');
 assert.equal(verifySessionToken(noncanonicalToken),false,'noncanonical signature bits must be denied');
 assert.equal((await app.inject({method:'GET',url:'/api/dashboard',headers:{cookie:oldCookie}})).statusCode,200);
 const second=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});
 assert.equal(second.statusCode,200,second.body);
 const secondCookie=String(second.headers['set-cookie']).split(';')[0];
 const loggedOut=await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:oldCookie}});
 assert.equal(loggedOut.statusCode,200,loggedOut.body);
 assert.equal((await app.inject({method:'GET',url:'/api/dashboard',headers:{cookie:oldCookie}})).statusCode,401,
   'legacy logout must reject a replayed cookie');
 assert.equal((await app.inject({method:'GET',url:'/api/dashboard',headers:{cookie:oldCookie+'='}})).statusCode,401);
 assert.equal((await app.inject({method:'GET',url:'/api/dashboard',
   headers:{cookie:'publikator_session='+noncanonicalToken}})).statusCode,401);
 assert.equal((await app.inject({method:'GET',url:'/api/dashboard',headers:{cookie:secondCookie}})).statusCode,200,
   'another legacy operator session must remain usable');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_legacy_session_revocations').get().n,1);
 await app.close();
 app=await buildApp();
 assert.equal((await app.inject({method:'GET',url:'/api/dashboard',headers:{cookie:oldCookie}})).statusCode,401,
   'revocation must survive an application restart');
 assert.equal((await app.inject({method:'GET',url:'/api/dashboard',headers:{cookie:secondCookie}})).statusCode,200);
 const changed=await app.inject({method:'POST',url:'/api/auth/migrate',headers:{cookie:secondCookie},
   payload:{username:'admin_new',password:'proper-new-password-2026',confirmPassword:'proper-new-password-2026'}});
 assert.equal(changed.statusCode,200,changed.body);
 const cookie=String(changed.headers['set-cookie']).split(';')[0];
 assert.equal((await app.inject({method:'GET',url:'/api/dashboard',headers:{cookie:oldCookie}})).statusCode,401);
 assert.equal((await app.inject({method:'GET',url:'/api/dashboard',headers:{cookie:secondCookie}})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'admin_new',password:process.env.ADMIN_PASSWORD}})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'admin_new',password:'proper-new-password-2026'}})).statusCode,200);
 assert.equal((await app.inject({method:'GET',url:'/api/dashboard',headers:{cookie}})).statusCode,200);
 assert.deepEqual(db.prepare('SELECT * FROM social_accounts').all(),before.social);
 assert.deepEqual(db.prepare('SELECT * FROM posts').all(),before.posts);
 assert.deepEqual(db.prepare('SELECT * FROM post_targets').all(),before.targets);
 assert.deepEqual(decryptJson(encrypted),{botToken:'test-telegram-credential',chatId:'@Alikin_SA'});
 console.log(JSON.stringify({ok:true,legacyLoginWorks:true,migrated:true,oldPasswordBlocked:true,legacyLogoutRevokesPersistently:true,canonicalLegacyTokensOnly:true,readyPreserved:true}));
}finally{
 await app.close();
 db.close();
 await fs.rm(dir,{recursive:true,force:true});
}
