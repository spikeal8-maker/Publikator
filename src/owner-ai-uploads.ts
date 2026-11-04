import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, id, nowIso } from './db.js';
import { config } from './config.js';
import { saveImageVersioned, saveVideoVersioned } from './media.js';
import { assertOwnerActor, boundedString, OwnerAutomationError, withOwnerReceipt, type OwnerActor } from './owner-automation.js';

const ROOT=path.join(config.dataDir,'.owner-ai-uploads');
const LIMIT=512*1024*1024;
export async function stageOwnerUpload(actor:OwnerActor,filename:string,mime:string,stream:Readable):Promise<any> {
  assertOwnerActor(actor);
  if(!/^image\/(?:jpeg|png|webp|gif)$/.test(mime)&&mime!=='video/mp4') {stream.resume();throw new OwnerAutomationError('UNSUPPORTED_MEDIA','Допускаются JPEG, PNG, WebP, GIF и MP4.',400);}
  const name=path.basename(filename.replace(/\\/g,'/')).replace(/[\u0000-\u001f]/g,'').slice(0,180)||'upload';
  const usage=(db.prepare("SELECT COALESCE(SUM(size_bytes),0) AS n FROM owner_ai_uploads WHERE owner_id=? AND expires_at>? AND state!='ABORTED'").get(actor.ownerId,nowIso()) as any).n;
  if(usage>=1024*1024*1024){stream.resume();throw new OwnerAutomationError('UPLOAD_QUOTA','Лимит временных вложений — 1 ГБ. Дождитесь удаления старых файлов.',413);}
  await fs.promises.mkdir(ROOT,{recursive:true,mode:0o700});
  const uploadId=id('aiup'),target=path.join(ROOT,uploadId);let bytes=0;const hash=crypto.createHash('sha256');
  const meter=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>LIMIT||usage+bytes>1024*1024*1024){callback(new Error('UPLOAD_SIZE'));return;}hash.update(chunk);callback(null,chunk);}});
  try{
    await pipeline(stream,meter,fs.createWriteStream(target,{flags:'wx',mode:0o600}));
    if(!bytes)throw new OwnerAutomationError('EMPTY_FILE','Пустой файл.',400);
    assertOwnerActor(actor);
    const expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
    db.prepare('INSERT INTO owner_ai_uploads(id,owner_id,name,mime_type,size_bytes,sha256,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(uploadId,actor.ownerId,name,mime,bytes,hash.digest('hex'),nowIso(),expiresAt);
    return {id:uploadId,name,mimeType:mime,sizeBytes:bytes,expiresAt};
  }catch(error){await fs.promises.rm(target,{force:true});if(error instanceof OwnerAutomationError)throw error;throw new OwnerAutomationError('UPLOAD_FAILED','Загрузка не завершена или превышен размер файла.',413);}
}
export function listOwnerUploads(ownerId:string):any[] {
  return db.prepare("SELECT id,name,mime_type,size_bytes,state,uploaded_bytes,created_at,expires_at FROM owner_ai_uploads WHERE owner_id=? AND expires_at>? AND state!='ABORTED' ORDER BY created_at DESC LIMIT 100").all(ownerId,nowIso());
}
export async function attachOwnerUpload(actor:OwnerActor,args:any):Promise<any> {
  const uploadId=boundedString(args.uploadId,'uploadId'),postId=boundedString(args.postId,'postId');
  if(!Number.isInteger(args.expectedContentVersion)||args.expectedContentVersion<1)throw new OwnerAutomationError('INVALID_VERSION','Нужна текущая версия публикации.');
  return withOwnerReceipt(actor,'attach_uploaded_media',args,args.idempotencyKey,async()=>{
    const file=db.prepare("SELECT * FROM owner_ai_uploads WHERE id=? AND owner_id=? AND expires_at>? AND state='READY'").get(uploadId,actor.ownerId,nowIso()) as any;
    if(!file)return {status:404,data:{error:'Вложение не найдено или срок хранения истёк.'}};
    if(!/^aiup_[A-Za-z0-9-]+$/.test(file.id))throw new OwnerAutomationError('INVALID_UPLOAD','Некорректный идентификатор вложения.');
    const location=path.join(ROOT,file.id);
    const stat=await fs.promises.stat(location);
    if(stat.size!==file.size_bytes)return {status:409,data:{error:'Размер вложения изменился. Загрузите файл заново.'}};
    const hash=crypto.createHash('sha256');for await(const part of fs.createReadStream(location))hash.update(part);
    if(hash.digest('hex')!==file.sha256)return {status:409,data:{error:'Контрольная сумма вложения изменилась.'}};
    assertOwnerActor(actor);
    const result=file.mime_type==='video/mp4'
      ?await saveVideoVersioned(postId,file.name,fs.createReadStream(location),args.expectedContentVersion)
      :await saveImageVersioned(postId,file.name,await fs.promises.readFile(location),args.expectedContentVersion);
    return {status:201,data:result};
  });
}
export async function cleanupOwnerUploads():Promise<void>{
  const expired=db.prepare('SELECT id FROM owner_ai_uploads WHERE expires_at<=?').all(nowIso()) as any[];
  for(const row of expired){if(/^aiup_[A-Za-z0-9-]+$/.test(row.id))await fs.promises.rm(path.join(ROOT,row.id),{force:true});db.prepare('DELETE FROM owner_ai_uploads WHERE id=?').run(row.id);}
}

/** Chunked MCP upload: bounded messages, durable offset and an explicit finalize. */
export async function beginOwnerUpload(actor:OwnerActor,args:any):Promise<any>{
  return withOwnerReceipt(actor,'begin_media_upload',args,args.idempotencyKey,async()=>{
    const bytes=Number(args.sizeBytes);if(!Number.isSafeInteger(bytes)||bytes<1||bytes>LIMIT)throw new OwnerAutomationError('INVALID_SIZE','Размер файла должен быть от 1 байта до 512 МБ.');
    if(!/^image\/(jpeg|png|webp|gif)$/.test(args.mimeType)&&args.mimeType!=='video/mp4')throw new OwnerAutomationError('UNSUPPORTED_MEDIA','Формат файла не поддерживается.');
    const used=(db.prepare("SELECT COALESCE(SUM(size_bytes),0) AS n FROM owner_ai_uploads WHERE owner_id=? AND expires_at>? AND state!='ABORTED'").get(actor.ownerId,nowIso()) as any).n;
    if(used+bytes>1024*1024*1024)throw new OwnerAutomationError('UPLOAD_QUOTA','Лимит временных вложений — 1 ГБ.',413);
    const name=path.basename(boundedString(args.filename,'filename',180).replace(/\\/g,'/'));
    if(args.sha256!==undefined&&!/^[a-f0-9]{64}$/i.test(args.sha256))throw new OwnerAutomationError('INVALID_HASH','Некорректная SHA-256.');
    const uploadId=id('aiup'),expiresAt=new Date(Date.now()+86400000).toISOString();
    await fs.promises.mkdir(ROOT,{recursive:true,mode:0o700});const file=await fs.promises.open(path.join(ROOT,uploadId),'wx',0o600);await file.close();
    try{db.prepare("INSERT INTO owner_ai_uploads(id,owner_id,name,mime_type,size_bytes,sha256,created_at,expires_at,state,uploaded_bytes,expected_sha256) VALUES(?,?,?,?,?,'',?,?,'UPLOADING',0,?)").run(uploadId,actor.ownerId,name,args.mimeType,bytes,nowIso(),expiresAt,args.sha256?.toLowerCase()||null);}
    catch(error){await fs.promises.rm(path.join(ROOT,uploadId),{force:true});throw error;}
    return {status:201,data:{uploadId,name,sizeBytes:bytes,uploadedBytes:0,chunkLimitBytes:1024*1024,state:'UPLOADING',expiresAt}};
  });
}
export async function appendOwnerUpload(actor:OwnerActor,args:any):Promise<any>{
  return withOwnerReceipt(actor,'append_media_chunk',args,args.idempotencyKey,async()=>{
    if(typeof args.dataBase64!=='string'||args.dataBase64.length>1400000||!args.dataBase64.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(args.dataBase64))throw new OwnerAutomationError('INVALID_BASE64','Некорректный блок base64.');
    const data=Buffer.from(args.dataBase64,'base64');if(!data.length||data.length>1024*1024)throw new OwnerAutomationError('CHUNK_LIMIT','Один блок — не больше 1 МБ.');
    const row=db.prepare("SELECT * FROM owner_ai_uploads WHERE id=? AND owner_id=? AND expires_at>? AND state='UPLOADING'").get(args.uploadId,actor.ownerId,nowIso()) as any;
    if(!row)throw new OwnerAutomationError('UPLOAD_UNAVAILABLE','Загрузка не найдена, занята или завершена.',409);
    if(args.offset!==row.uploaded_bytes||row.uploaded_bytes+data.length>row.size_bytes)throw new OwnerAutomationError('OFFSET_CONFLICT','Смещение блока или итоговый размер не совпадают с загрузкой.',409);
    const filePath=path.join(ROOT,row.id);if((await fs.promises.stat(filePath)).size!==row.uploaded_bytes)throw new OwnerAutomationError('RECOVERY_NEEDED','Размер временного файла не совпадает с квитанцией. Прервите загрузку и начните заново.',409);
    const claim=db.prepare("UPDATE owner_ai_uploads SET state='WRITING',expires_at=? WHERE id=? AND owner_id=? AND state='UPLOADING' AND uploaded_bytes=?").run(new Date(Date.now()+86400000).toISOString(),row.id,actor.ownerId,row.uploaded_bytes);
    if(!claim.changes)throw new OwnerAutomationError('UPLOAD_BUSY','Другой запрос уже записывает блок.',409);
    let file;
    try{
      assertOwnerActor(actor);file=await fs.promises.open(filePath,'r+');let written=0;
      while(written<data.length){const r=await file.write(data,written,data.length-written,row.uploaded_bytes+written);if(!r.bytesWritten)throw new Error('SHORT_WRITE');written+=r.bytesWritten;}
      await file.sync();await file.close();file=undefined;
      const updated=db.prepare("UPDATE owner_ai_uploads SET uploaded_bytes=?,state='UPLOADING' WHERE id=? AND state='WRITING' AND uploaded_bytes=?").run(row.uploaded_bytes+data.length,row.id,row.uploaded_bytes);
      if(!updated.changes)throw new Error('LOST_UPLOAD_CLAIM');
      return {status:200,data:{uploadId:row.id,uploadedBytes:row.uploaded_bytes+data.length,sizeBytes:row.size_bytes,state:'UPLOADING'}};
    }catch(error){db.prepare("UPDATE owner_ai_uploads SET state='BROKEN' WHERE id=? AND state='WRITING'").run(row.id);throw error;}
    finally{if(file)await file.close();}
  });
}
export async function finalizeOwnerUpload(actor:OwnerActor,args:any):Promise<any>{
  return withOwnerReceipt(actor,'finalize_media_upload',args,args.idempotencyKey,async()=>{
    const row=db.prepare("SELECT * FROM owner_ai_uploads WHERE id=? AND owner_id=? AND expires_at>? AND state='UPLOADING'").get(args.uploadId,actor.ownerId,nowIso()) as any;
    if(!row||row.uploaded_bytes!==row.size_bytes)throw new OwnerAutomationError('UPLOAD_INCOMPLETE','Не все блоки файла загружены.',409);
    const location=path.join(ROOT,row.id);if((await fs.promises.stat(location)).size!==row.size_bytes)throw new OwnerAutomationError('RECOVERY_NEEDED','Размер файла изменился.',409);
    const hash=crypto.createHash('sha256');for await(const part of fs.createReadStream(location))hash.update(part);const sha=hash.digest('hex');
    if(row.expected_sha256&&row.expected_sha256!==sha)throw new OwnerAutomationError('HASH_MISMATCH','Контрольная сумма не совпадает. Файл не принят.',409);
    assertOwnerActor(actor);
    const update=db.prepare("UPDATE owner_ai_uploads SET state='READY',sha256=? WHERE id=? AND state='UPLOADING' AND uploaded_bytes=size_bytes").run(sha,row.id);
    if(!update.changes)throw new OwnerAutomationError('UPLOAD_CHANGED','Состояние загрузки изменилось.',409);
    return {status:200,data:{uploadId:row.id,name:row.name,sizeBytes:row.size_bytes,sha256:sha,state:'READY'}};
  });
}
export async function abortOwnerUpload(actor:OwnerActor,args:any):Promise<any>{
  return withOwnerReceipt(actor,'abort_media_upload',args,args.idempotencyKey,async()=>{
    const row=db.prepare('SELECT * FROM owner_ai_uploads WHERE id=? AND owner_id=?').get(args.uploadId,actor.ownerId) as any;
    if(!row)throw new OwnerAutomationError('UPLOAD_NOT_FOUND','Загрузка не найдена.',404);
    if(row.state==='WRITING')throw new OwnerAutomationError('UPLOAD_BUSY','Дождитесь окончания записи текущего блока.',409);
    db.prepare("UPDATE owner_ai_uploads SET state='ABORTED' WHERE id=?").run(row.id);
    await fs.promises.rm(path.join(ROOT,row.id),{force:true});return {status:200,data:{uploadId:row.id,state:'ABORTED'}};
  });
}
