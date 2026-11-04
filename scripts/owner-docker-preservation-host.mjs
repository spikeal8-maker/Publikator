import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const image=process.env.OWNER_CANDIDATE_IMAGE;
const archive=process.env.OWNER_BACKUP_ARCHIVE;
if(!image||!archive||!fs.existsSync(archive))throw new Error('OWNER_CANDIDATE_IMAGE and existing OWNER_BACKUP_ARCHIVE are required');
const source=JSON.parse(execFileSync('docker',['inspect','publikator'],{encoding:'utf8'}))[0];
const stored=Object.fromEntries(source.Config.Env.map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)];}));
if(!stored.APP_MASTER_KEY)throw new Error('Existing runtime encryption configuration is missing');
const suffix=Date.now().toString(36);const name='publikator-owner-preservation-'+suffix,volume=name+'-data';
const env={...process.env,APP_MASTER_KEY:stored.APP_MASTER_KEY};
function docker(args,options={}){return execFileSync('docker',args,{encoding:'utf8',maxBuffer:8*1024*1024,...options});}
function node(code){const output=docker(['exec','-i',name,'node','--input-type=module'],{input:code});const lines=output.trim().split(/\r?\n/);const last=lines.at(-1);const value=JSON.parse(last);console.log(JSON.stringify(value));return value;}
let created=false;
try{
  docker(['volume','create',volume]);
  const args=['run','-d','--name',name,'--network','none','--mount','type=volume,source='+volume+',target=/app/data','--env','APP_MASTER_KEY','--env','NODE_ENV=production','--env','PUBLIC_BASE_URL=http://127.0.0.1:8080','--env','DATA_DIR=/app/data',image,'node','-e','setInterval(()=>{},3600000)'];
  docker(args,{env});created=true;docker(['cp',archive,name+':/tmp/owner-source.tgz']);
  const staged=node(`const {db,migrate}=await import('./dist/db.js');migrate();const {stageRestoreBundle}=await import('./dist/backups.js');const stage=await stageRestoreBundle('/tmp/owner-source.tgz');db.close();const {applyPendingRestore}=await import('./dist/restore-bootstrap.js');const result=await applyPendingRestore();if(!result.applied)throw new Error('Restore not applied');console.log(JSON.stringify({stage:'canonical_preupgrade_restore',schema:stage.manifest.schemaVersion,applied:result.applied}));`);
  const checked=node(`import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
function stable(x){if(Array.isArray(x))return '['+x.map(stable).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';return JSON.stringify(x);}
function hashRows(database,tables){return Object.fromEntries(tables.map(t=>{const rows=database.prepare('SELECT * FROM "'+t.replaceAll('"','""')+'"').all().map(stable).sort();return[t,{rows:rows.length,sha256:crypto.createHash('sha256').update(rows.join('\\n')).digest('hex')}];}));}
function media(root){const out={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile())out[path.relative(root,p)]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}walk(root);return out;}
const old=new Database('/app/data/publikator.sqlite',{readonly:true,fileMustExist:true});const beforeVersion=Number(old.pragma('user_version',{simple:true}));const tables=old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);const before=hashRows(old,tables);const files=media('/app/data/media');old.close();
const {db,migrate}=await import('./dist/db.js');migrate();const after=hashRows(db,tables);assert.deepEqual(after,before,'Existing rows changed during migration');assert.deepEqual(media('/app/data/media'),files,'Media changed');
const {decryptJson}=await import('./dist/crypto.js');let social=0,sources=0;for(const r of db.prepare('SELECT credentials_encrypted FROM social_accounts').all()){decryptJson(r.credentials_encrypted);social++;}for(const r of db.prepare('SELECT credentials_encrypted FROM ingestion_connectors').all()){decryptJson(r.credentials_encrypted);sources++;}
assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);const version=Number(db.pragma('user_version',{simple:true}));
const {createBackupBundle,resolveBackupBundle,stageRestoreBundle}=await import('./dist/backups.js');const b=await createBackupBundle('owner-mcp-upgraded-qa');await stageRestoreBundle(resolveBackupBundle(b.name));fs.writeFileSync('/tmp/owner-preservation.json',JSON.stringify({tables,before,files,version}));db.close();const {applyPendingRestore}=await import('./dist/restore-bootstrap.js');const restored=await applyPendingRestore();assert.equal(restored.applied,true);
const check=new Database('/app/data/publikator.sqlite',{readonly:true,fileMustExist:true});assert.deepEqual(hashRows(check,tables),before,'Post-upgrade canonical restore changed original rows');assert.deepEqual(media('/app/data/media'),files);assert.equal(Number(check.pragma('user_version',{simple:true})),version);check.close();
console.log(JSON.stringify({stage:'real_backup_migration_restore',beforeSchema:beforeVersion,afterSchema:version,unchangedTables:tables.length,unchangedMediaFiles:Object.keys(files).length,socialCredentialsDecrypt:social,sourceCredentialsDecrypt:sources,canonicalPostUpgradeRestore:true,network:'none',result:'PASS'}));`);
  assert.equal(checked.result,'PASS');
  const report={image,archiveName:path.basename(archive),staged,checked,productionContainerUnchanged:true,verifiedAt:new Date().toISOString()};
  const output=process.env.OWNER_PRESERVATION_REPORT||path.join(path.dirname(archive),'owner-mcp-preservation-report.json');fs.writeFileSync(output,JSON.stringify(report,null,2));
}finally{
  if(created)try{docker(['rm','-f',name]);}catch{}
  try{docker(['volume','rm',volume]);}catch{}
}
