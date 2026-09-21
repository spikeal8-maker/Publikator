import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-content-bundle-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='content-bundle-password';
process.env.APP_MASTER_KEY='content-bundle-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

let crcTable=null;
function crc32(buffer){
  if(!crcTable){
    crcTable=new Uint32Array(256);
    for(let n=0;n<256;n+=1){let c=n;for(let k=0;k<8;k+=1)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);crcTable[n]=c>>>0;}
  }
  let crc=0xffffffff;
  for(const byte of buffer)crc=crcTable[(crc^byte)&0xff]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
function zip(entries){
  const locals=[];const centrals=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name,'utf8');
    const data=Buffer.isBuffer(entry.data)?entry.data:Buffer.from(entry.data||'');
    const crc=crc32(data);
    const local=Buffer.alloc(30+name.length+data.length);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(0,8);
    local.writeUInt16LE(0,10);local.writeUInt16LE(0,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);
    local.writeUInt16LE(name.length,26);local.writeUInt16LE(0,28);name.copy(local,30);data.copy(local,30+name.length);
    locals.push(local);
    const central=Buffer.alloc(46+name.length);
    const versionMadeBy=entry.symlink?((3<<8)|20):20;
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(versionMadeBy,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x0800,8);central.writeUInt16LE(0,10);
    central.writeUInt16LE(0,12);central.writeUInt16LE(0,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);
    central.writeUInt16LE(name.length,28);central.writeUInt16LE(0,30);central.writeUInt16LE(0,32);central.writeUInt16LE(0,34);central.writeUInt16LE(0,36);
    if(entry.symlink)central.writeUInt32LE((0o120777<<16)>>>0,38);
    central.writeUInt32LE(offset,42);name.copy(central,46);centrals.push(central);offset+=local.length;
  }
  const central=Buffer.concat(centrals);
  const eocd=Buffer.alloc(22);eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(0,4);eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(entries.length,8);eocd.writeUInt16LE(entries.length,10);eocd.writeUInt32LE(central.length,12);eocd.writeUInt32LE(offset,16);eocd.writeUInt16LE(0,20);
  return Buffer.concat([...locals,central,eocd]);
}

const header=[
  'schema_version','external_id','action','project','template_key','internal_title','body',
  'publication_kind','content_format','schedule_mode','scheduled_at','timezone','targets',
  'telegram_body','vk_body','max_body','instagram_body','media','tags','source_note','source_revision'
];
function csvRow({revision='1',body='Bundle body',title='Bundle post'}={}){
  return ['3','bundle-001','UPSERT','main','',title,body,'FEED','IMAGE','MANUAL','','','[]','','','','','','bundle; image','Bundle source',revision];
}
function csv(options={}){
  return Buffer.from([header.join(','),csvRow(options).join(',')].join('\n')+'\n','utf8');
}

const {db,migrate}=await import('../dist/db.js');
const {commitContentEdit}=await import('../dist/content-versioning.js');
const {buildApp}=await import('../dist/app.js');
migrate();
const project=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
db.prepare('UPDATE projects SET slug=? WHERE id=?').run('main',project.id);

const image1=await sharp({create:{width:4,height:4,channels:3,background:{r:10,g:20,b:30}}}).png().toBuffer();
const image2=await sharp({create:{width:4,height:4,channels:3,background:{r:90,g:80,b:70}}}).png().toBuffer();
const bundle1=zip([
  {name:'content.csv',data:csv({revision:'1',body:'Bundle body v1'})},
  {name:'media/bundle-001__01.png',data:image1},
  {name:'manifest.json',data:JSON.stringify({name:'test bundle'})}
]);

const app=await buildApp();await app.ready();
const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});
assert.equal(login.statusCode,200,login.body);
const cookie=String(login.headers['set-cookie']).split(';')[0];
const request=(method,url,payload,headers={})=>app.inject({method,url,headers:{cookie,...headers},...(payload===undefined?{}:{payload})});
const upload=(method,url,buffer,headers={})=>{
  const boundary='----publikatorbundle';
  const before=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="content-bundle.zip"\r\nContent-Type: application/zip\r\n\r\n`);
  const after=Buffer.from(`\r\n--${boundary}--\r\n`);
  return app.inject({method,url,headers:{cookie,'content-type':`multipart/form-data; boundary=${boundary}`,...headers},payload:Buffer.concat([before,buffer,after])});
};

const anonymous=await app.inject({method:'POST',url:'/api/content-bundle/v1/preview?sourceId=school-pack'});
assert.equal(anonymous.statusCode,401);

const preview1=await upload('POST','/api/content-bundle/v1/preview?sourceId=school-pack',bundle1);
assert.equal(preview1.statusCode,200,preview1.body);
const p1=preview1.json();
assert.equal(p1.canApply,true);
assert.equal(p1.summary.newRows,1);
assert.equal(p1.media.length,1);
assert.equal(p1.media[0].mimeType,'image/png');
assert.equal(p1.manifest.name,'test bundle');
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='content-bundle'").get().count,0,'preview must not mutate');

const wrongConfirm=await upload('POST','/api/content-bundle/v1/apply?sourceId=school-pack',bundle1,{
  'x-content-bundle-sha256':p1.bundleSha256
});
assert.equal(wrongConfirm.statusCode,400,wrongConfirm.body);

const applied1=await upload('POST','/api/content-bundle/v1/apply?sourceId=school-pack',bundle1,{
  'x-publikator-content-bundle':'IMPORT','x-content-bundle-sha256':p1.bundleSha256
});
assert.equal(applied1.statusCode,200,applied1.body);
assert.equal(applied1.json().created,1);
let post=db.prepare("SELECT * FROM posts WHERE source_type='content-bundle'").get();
assert.ok(post);
assert.equal(post.status,'DRAFT');
assert.equal(post.body,'Bundle body v1');
assert.deepEqual(JSON.parse(post.tags_json),['bundle','image']);
assert.equal(post.source_note,'Bundle source');
let media=db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order').all(post.id);
assert.equal(media.length,1);
assert.equal(media[0].mime_type,'image/jpeg');
assert.ok((await fs.stat(path.join(dataDir,'media',media[0].relative_path))).isFile());

const unchanged=await upload('POST','/api/content-bundle/v1/preview?sourceId=school-pack',bundle1);
assert.equal(unchanged.statusCode,200,unchanged.body);
assert.equal(unchanged.json().summary.unchangedRows,1);

const bundle2=zip([
  {name:'content.csv',data:csv({revision:'2',body:'Bundle body v2'})},
  {name:'media/bundle-001__01.png',data:image2}
]);
const updatePreview=await upload('POST','/api/content-bundle/v1/preview?sourceId=school-pack',bundle2);
assert.equal(updatePreview.statusCode,200,updatePreview.body);
assert.equal(updatePreview.json().summary.updateRows,1);
const stale=await upload('POST','/api/content-bundle/v1/apply?sourceId=school-pack',bundle2,{
  'x-publikator-content-bundle':'IMPORT','x-content-bundle-sha256':p1.bundleSha256
});
assert.equal(stale.statusCode,409,stale.body);
assert.match(stale.json().error,/changed after preview/i);

const applied2=await upload('POST','/api/content-bundle/v1/apply?sourceId=school-pack',bundle2,{
  'x-publikator-content-bundle':'IMPORT','x-content-bundle-sha256':updatePreview.json().bundleSha256
});
assert.equal(applied2.statusCode,200,applied2.body);
assert.equal(applied2.json().updated,1);
post=db.prepare('SELECT * FROM posts WHERE id=?').get(post.id);
assert.equal(post.body,'Bundle body v2');
media=db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order').all(post.id);
assert.equal(media.length,1);

commitContentEdit(post.id,post.content_version,'manual',()=>db.prepare('UPDATE posts SET body=? WHERE id=?').run('Local manual edit',post.id));
const bundle3=zip([
  {name:'content.csv',data:csv({revision:'3',body:'Bundle body v3'})},
  {name:'media/bundle-001__01.png',data:image2}
]);
const conflict=await upload('POST','/api/content-bundle/v1/preview?sourceId=school-pack',bundle3);
assert.equal(conflict.statusCode,200,conflict.body);
assert.equal(conflict.json().summary.conflicts,1);
assert.equal(conflict.json().canApply,false);

const traversal=zip([{name:'../content.csv',data:csv()}]);
const traversalPreview=await upload('POST','/api/content-bundle/v1/preview?sourceId=bad',traversal);
assert.equal(traversalPreview.statusCode,400,traversalPreview.body);
assert.match(traversalPreview.json().error,/traversal|relative|unsafe/i);

const badMime=zip([
  {name:'content.csv',data:csv()},
  {name:'media/bundle-001__01.jpg',data:Buffer.from('not an image')}
]);
const badMimePreview=await upload('POST','/api/content-bundle/v1/preview?sourceId=bad-mime',badMime);
assert.equal(badMimePreview.statusCode,400,badMimePreview.body);
assert.match(badMimePreview.json().error,/MIME|recognized/i);

const symlink=zip([
  {name:'content.csv',data:csv()},
  {name:'media/bundle-001__01.jpg',data:Buffer.from('target'),symlink:true}
]);
const symlinkPreview=await upload('POST','/api/content-bundle/v1/preview?sourceId=bad-link',symlink);
assert.equal(symlinkPreview.statusCode,400,symlinkPreview.body);
assert.match(symlinkPreview.json().error,/symlink|forbidden|entry type/i);

const ui=await fs.readFile(path.join(process.cwd(),'public','operator-pages-v4.js'),'utf8');
assert.match(ui,/ZIP Content Bundle/);
assert.match(ui,/content-bundle\.zip/);
assert.match(ui,/Проверить ZIP/);
assert.match(ui,/Импортировать bundle/);

await app.close();
console.log(JSON.stringify({
  ok:true,
  checkpoint:'Content Bundle v1',
  previewNoMutation:true,
  exactShaApply:true,
  newUpdateUnchangedConflict:true,
  mediaSnapshot:true,
  traversalRejected:true,
  mimeSniffing:true,
  symlinkRejected:true,
  ui:true
},null,2));

await fs.rm(dataDir,{recursive:true,force:true});
