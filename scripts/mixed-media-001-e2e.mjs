import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {execFileSync} from 'node:child_process';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-mixed-media-001-'));
Object.assign(process.env,{NODE_ENV:'test',DATA_DIR:dir,ADMIN_PASSWORD:'video-publish-ci-password',APP_MASTER_KEY:'video-publish-ci-master-key-longer-than-thirty-two-characters'});
const {db,migrate}=await import('../dist/db.js');
const {encryptJson,decryptJson}=await import('../dist/crypto.js');
const {buildApp}=await import('../dist/app.js');
migrate();const app=await buildApp();
const realFetch=globalThis.fetch;
const counts={tg:0,vk:0,max:0,reserve:0,upload:0},captions={};
let maxNotReady=true,maxUnknown=false,photoSerial=0,maxPhotoSerial=0,tgPartial=false;
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));
 if(url.hostname==='api.telegram.org'){
  if(url.pathname.endsWith('/getMe'))return json({ok:true,result:{id:42,username:'video_fixture_bot'}});
  if(url.pathname.endsWith('/getChat'))return json({ok:true,result:{id:-10042,type:'channel',title:'Video fixture'}});
  if(url.pathname.endsWith('/getChatMember'))return json({ok:true,result:{status:'administrator',can_post_messages:true}});
  if(url.pathname.endsWith('/sendMediaGroup')){
   counts.tg++;const media=JSON.parse(init.body.get('media'));
   assert.deepEqual(media.map(item=>item.type),['photo','video','photo']);
   for(const item of media)assert.ok(init.body.get(item.media.slice(9)) instanceof Blob);
   captions.telegram=media[0].caption;
   return json({ok:true,result:(tgPartial?media.slice(0,1):media).map((item,i)=>({message_id:111+i,media_group_id:'fixture-album',chat:{id:-10042,username:'video_fixture'}}))});
  }
 }
 if(url.hostname==='platform-api2.max.ru'){
  if(url.pathname==='/me')return json({user_id:42,name:'video bot',username:'video_bot'});
  if(url.pathname.endsWith('/members/me'))return json({is_admin:true,permissions:['write']});
  if(url.pathname.startsWith('/chats/'))return json({chat_id:-10042,type:'channel'});
  if(url.pathname==='/uploads'){if(url.searchParams.get('type')==='image')return json({url:'https://iu.oneme.ru/uploadImage'});counts.reserve++;return json({url:'https://omub.okcdn.ru/upload.do?sig=fixture',token:'fixture-video-token'});}
  if(url.pathname==='/messages'){
   counts.max++;const body=JSON.parse(init.body);assert.deepEqual(body.attachments.map(item=>item.type),['image','video','image']);assert.equal(body.attachments[1].payload.token,'fixture-video-token');
   captions.max=body.text;
   if(maxUnknown)return json({code:'internal.error'},500);
   if(maxNotReady){maxNotReady=false;return json({code:'attachment.not.ready'},400);}
   return json({message:{body:{mid:'max-video-111'},link:'https://max.ru/fixture/111'}});
  }
 }
 if(url.hostname==='iu.oneme.ru'){assert.ok(init.body.get('data') instanceof Blob);return json({photos:{fixture:{token:'photo-'+(++maxPhotoSerial)}}});}
 if(url.hostname==='omub.okcdn.ru'){counts.upload++;assert.ok(init.body.get('data') instanceof Blob);return new Response('<retval>1</retval>',{status:200});}
 if(url.pathname.startsWith('/method/')){
  const method=url.pathname.split('/').pop(),body=Object.fromEntries(init.body.entries()),token=body.access_token;
  if(method==='groups.getTokenPermissions')return token==='group-secret'?json({response:{permissions:[{name:'wall'}]}}):json({error:{error_code:27,error_msg:'USER credential'}});
  if(method==='account.getAppPermissions')return json({response:20});
  if(method==='users.get')return json({response:[{id:900,first_name:'Fixture'}]});
  if(method==='groups.getById')return json({response:{groups:[{id:77,name:'Video group',is_admin:token==='user-video-secret'?1:0}]}});
  if(method==='photos.getWallUploadServer')return json({response:{upload_url:'https://upload.vk.test/photo'}});
  if(method==='photos.saveWallPhoto')return json({response:[{owner_id:-77,id:++photoSerial}]});
  if(method==='video.save'){assert.equal(token,'user-video-secret');assert.equal(body.wallpost,'0');return json({response:{upload_url:'https://upload.vk.test/video',owner_id:-77,video_id:88}});}
  if(method==='wall.post'){assert.equal(token,'group-secret');assert.match(body.attachments,/^photo-77_\d+,video-77_88,photo-77_\d+$/);counts.vk++;captions.vk=body.message;return json({response:{post_id:222}});}
 }
 if(url.hostname==='upload.vk.test')return url.pathname==='/photo'?json({server:1,photo:'fixture',hash:'fixture'}):json({video_id:88,size:12000});
 throw Error('Unexpected provider request '+url.origin+url.pathname);
};
try{
 const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});assert.equal(login.statusCode,200);
 const headers={cookie:String(login.headers['set-cookie']).split(';')[0]};
 const request=async(method,url,payload,expected=200,extra={})=>{const r=await app.inject({method,url,headers:{...headers,...extra},payload});assert.equal(r.statusCode,expected,r.body);return r.json();};
 const now=new Date().toISOString();
 const credentials={telegram:{botToken:'telegram-secret',chatId:'-10042'},max:{accessToken:'max-secret',chatId:'-10042'},vk:{accessToken:'group-secret',groupId:'77',destinationKind:'COMMUNITY',authKind:'COMMUNITY',textPublishReady:true,tokenGroupId:'77'}};
 for(const [platform,creds] of Object.entries(credentials))db.prepare('INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').run('video_'+platform,platform,'Video '+platform,encryptJson(creds),now,now);
 const updated=await request('POST','/api/accounts/video_vk/vk-upload-key',{uploadAccessToken:'user-video-secret',expectedCredentialVersion:1});
 assert.equal(updated.capabilityProfile.semantic.publicationReadiness.VIDEO.state,'READY');
 assert.equal(updated.capabilityProfile.semantic.publicationReadiness.IMAGE.state,'READY');
 const vkRow=db.prepare("SELECT * FROM social_accounts WHERE id='video_vk'").get();
 const stored=decryptJson(vkRow.credentials_encrypted);assert.equal(stored.accessToken,'group-secret');assert.equal(stored.uploadAccessToken,'user-video-secret');assert.equal(stored.videoPublishReady,true);assert.equal(vkRow.enabled,1);
 assert.ok(!JSON.stringify(updated).includes('user-video-secret'));
 await request('POST','/api/accounts/video_vk/vk-upload-key',{uploadAccessToken:'another-key',expectedCredentialVersion:1},409);
 for(const platform of ['telegram','max']){const checked=await request('POST','/api/accounts/video_'+platform+'/recheck');assert.equal(checked.capabilityProfile.semantic.publicationReadiness.VIDEO.state,'READY');}
 const projectId=db.prepare('SELECT id FROM projects LIMIT 1').get().id;
 const file=path.join(dir,'control.mp4');execFileSync('ffmpeg',['-y','-f','lavfi','-i','color=c=blue:s=640x360:r=24','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-an',file],{stdio:'ignore'});
 const bytes=await fs.readFile(file);
 async function draft(accountIds,title,approve=true){
  const post=await request('POST','/api/posts',{projectId,title,body:'Контрольное видео 🤖',contentFormat:'MEDIA',scheduleMode:'MANUAL'},201);
  const boundary='videoFixtureBoundary',body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="control.mp4"\r\nContent-Type: video/mp4\r\n\r\n'),bytes,Buffer.from('\r\n--'+boundary+'--\r\n')]);
  const uploaded=await request('POST','/api/posts/'+post.id+'/video',body,201,{'content-type':'multipart/form-data; boundary='+boundary,'x-content-version':String(post.content_version)});
  let version=uploaded.contentVersion;const photoIds=[];
  for(const color of ['red','green']){
   const image=await sharp({create:{width:640,height:360,channels:3,background:color}}).png().toBuffer();
   const imageBody=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="'+color+'.png"\r\nContent-Type: image/png\r\n\r\n'),image,Buffer.from('\r\n--'+boundary+'--\r\n')]);
   const photo=await request('POST','/api/posts/'+post.id+'/media',imageBody,201,{'content-type':'multipart/form-data; boundary='+boundary,'x-content-version':String(version)});
   version=photo.contentVersion;photoIds.push(photo.id);
  }
  const reordered=await request('PUT','/api/posts/'+post.id+'/media-order',{mediaIds:[photoIds[0],uploaded.id,photoIds[1]],expectedContentVersion:version});
  assert.equal(db.prepare('SELECT content_format FROM posts WHERE id=?').get(post.id).content_format,'CAROUSEL');
  const targets=await request('PUT','/api/posts/'+post.id+'/targets',{accountIds,expectedContentVersion:reordered.contentVersion});
  if(!approve)return {id:post.id,version:targets.contentVersion,uploaded};
  const ready=await request('POST','/api/posts/'+post.id+'/ready',{expectedContentVersion:targets.contentVersion});
  return {id:post.id,ready};
 }
 const editable=await draft(['video_telegram'],'Generated cover stays separate',false);
 const cover=editable.uploaded.poster;
 const coverBytes=await fs.readFile(path.join(dir,'media',cover.relative_path));
 const coverBoundary='coverBoundary';
 const coverBody=Buffer.concat([Buffer.from('--'+coverBoundary+'\r\nContent-Disposition: form-data; name="file"; filename="explicit-cover.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),coverBytes,Buffer.from('\r\n--'+coverBoundary+'--\r\n')]);
 const explicitCover=await request('POST','/api/posts/'+editable.id+'/media',coverBody,201,{'content-type':'multipart/form-data; boundary='+coverBoundary,'x-content-version':String(editable.version)});
 assert.notEqual(explicitCover.id,cover.id,'an explicit photo must not deduplicate into an excluded video cover');
 assert.equal(db.prepare('SELECT role FROM content_media WHERE media_id=?').get(cover.id).role,'poster');
 const {vkPublisher}=await import('../dist/platforms/vk.js');
 const mixedInput={postId:editable.id,title:'permission guard',text:'fixture',media:db.prepare("SELECT m.* FROM media m JOIN content_media cm ON cm.media_id=m.id WHERE m.post_id=? AND cm.role<>'poster' ORDER BY m.sort_order").all(editable.id),publicMediaUrls:[],publicationKind:'FEED',contentFormat:'CAROUSEL',credentials:stored};
 assert.throws(()=>vkPublisher.validate({...mixedInput,credentials:{...stored,videoPublishReady:false}}),/video/);
 assert.throws(()=>vkPublisher.validate({...mixedInput,credentials:{...stored,photoPublishReady:false}}),/фото/);
 const post=await draft(['video_telegram','video_vk','video_max'],'All three video platforms');
 await request('POST','/api/posts/'+post.id+'/publish-now');
 const targets=db.prepare('SELECT state,external_id FROM post_targets WHERE post_id=?').all(post.id);
 assert.equal(targets.length,3);assert.ok(targets.every(row=>row.state==='PUBLISHED'),JSON.stringify(targets));
 assert.deepEqual({tg:counts.tg,vk:counts.vk,max:counts.max,reserve:counts.reserve,upload:counts.upload},{tg:1,vk:1,max:2,reserve:1,upload:1});
 assert.ok(Object.values(captions).every(value=>String(value).includes('Контрольное видео')));
 const uncertain=await draft(['video_max'],'Unknown MAX outcome');maxUnknown=true;
 const previous=counts.max;await request('POST','/api/posts/'+uncertain.id+'/publish-now');
 assert.equal(counts.max,previous+1,'Unknown public outcome must never auto-retry');
 assert.equal(db.prepare('SELECT state FROM post_targets WHERE post_id=?').get(uncertain.id).state,'RECOVERY_NEEDED');
 const partial=await draft(['video_telegram'],'Incomplete Telegram album receipt');tgPartial=true;
 const beforeTg=counts.tg;await request('POST','/api/posts/'+partial.id+'/publish-now');
 assert.equal(counts.tg,beforeTg+1);
 assert.equal(db.prepare('SELECT state FROM post_targets WHERE post_id=?').get(partial.id).state,'RECOVERY_NEEDED','partial album receipt never auto-retries');
 const accounts=await request('GET','/api/accounts');assert.ok(!JSON.stringify(accounts).includes('user-video-secret'));
 console.log(JSON.stringify({checkpoint:'MIXED-MEDIA-001',ok:true,orderedMixedThreePlatforms:true,maxXml:true,sameTokenProcessingRetry:true,unknownOutcomeNoRetry:true,vkIndependentUploader:true,secretSafe:true,protectedReady:true}));
}finally{globalThis.fetch=realFetch;await app.close();db.close();await fs.rm(dir,{recursive:true,force:true});}
