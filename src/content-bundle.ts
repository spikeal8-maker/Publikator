import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { config } from './config.js';
import { db, event, id, nowIso } from './db.js';
import {
  DEFAULT_BUNDLE_LIMITS,
  sniffMediaMime,
  validateBundleEntries,
  type BundleEntryKind,
  type BundleEntryMeta,
  type SniffedMime
} from './ingestion-security.js';
import {
  applyContentPlanV3,
  parseContentPlanV3,
  validateContentPlanV3,
  type V3Classification,
  type V3Validation
} from './content-plan-v3.js';
import { commitContentEdit } from './content-versioning.js';
import { listMedia, type MediaRow } from './media.js';
import { prepareVideoUpload, type PreparedVideoUpload } from './video-media.js';

const SOURCE_TYPE='content-bundle';
const MAX_IMAGE_DIMENSION=7680;
const BUNDLE_LIMITS = {
  ...DEFAULT_BUNDLE_LIMITS,
  maxEntries: config.maxBundleMediaFiles + 8,
  maxCompressedBytes: config.maxBundleUploadBytes,
  maxExpandedBytes: config.maxBundleExpandedBytes,
  maxEntryExpandedBytes: Math.min(
    config.maxBundleExpandedBytes,
    Math.max(config.maxVideoBytes, config.maxImageBytes, 20 * 1024 * 1024)
  )
};
const EOCD_SIGNATURE=0x06054b50;
const CENTRAL_SIGNATURE=0x02014b50;
const LOCAL_SIGNATURE=0x04034b50;

type ZipEntry={
  path:string;
  kind:BundleEntryKind;
  method:number;
  flags:number;
  crc32:number;
  compressedSize:number;
  expandedSize:number;
  localOffset:number;
  data:Buffer;
};

export type BundleMediaPreview={
  path:string;
  externalId:string;
  order:number;
  mimeType:SniffedMime;
  sizeBytes:number;
  sha256:string;
};

export type ContentBundlePreview=V3Validation & {
  sourceKey:string;
  bundleSha256:string;
  contentFile:string;
  media:BundleMediaPreview[];
  manifest:Record<string,unknown>|null;
};

type InternalBundle={
  preview:ContentBundlePreview;
  mediaByExternalId:Map<string,Array<BundleMediaPreview & {data:Buffer;originalName:string}>>;
};

type PreparedMediaRow={
  id:string;
  originalName:string;
  relativePath:string;
  absolutePath:string;
  mimeType:string;
  sizeBytes:number;
  width:number|null;
  height:number|null;
  sha256:string;
  sortOrder:number;
  durationMs:number|null;
  fps:number|null;
  videoCodec:string|null;
  audioCodec:string|null;
  container:string|null;
  posterAssetId:string|null;
  role:'primary'|'carousel_item'|'story_item'|'video'|'poster';
};

type BundleMediaPlan={
  externalId:string;
  postId:string;
  rows:PreparedMediaRow[];
  previous:MediaRow[];
  newPaths:string[];
  cleanupPreparations:Array<()=>Promise<void>>;
};

function sourceKey(sourceIdRaw:string):string{
  const sourceId=sourceIdRaw.trim();
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(sourceId))throw new Error('sourceId: 1-128 chars A-Z a-z 0-9 . _ : -');
  return `bundle:${sourceId}`;
}

function sourceRef(sourceKeyValue:string,externalId:string):string{
  return JSON.stringify([sourceKeyValue,externalId]);
}

function sha256(value:Buffer|string):string{
  return crypto.createHash('sha256').update(value).digest('hex');
}

let crcTable:Uint32Array|null=null;
function crc32(buffer:Buffer):number{
  if(!crcTable){
    crcTable=new Uint32Array(256);
    for(let n=0;n<256;n+=1){
      let c=n;
      for(let k=0;k<8;k+=1)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);
      crcTable[n]=c>>>0;
    }
  }
  let crc=0xffffffff;
  for(const byte of buffer)crc=crcTable[(crc^byte)&0xff]!^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}

function findEocd(buffer:Buffer):number{
  const min=Math.max(0,buffer.length-22-0xffff);
  for(let offset=buffer.length-22;offset>=min;offset-=1){
    if(buffer.readUInt32LE(offset)===EOCD_SIGNATURE)return offset;
  }
  throw new Error('ZIP end-of-central-directory not found');
}

function zipKind(name:string,versionMadeBy:number,externalAttrs:number):BundleEntryKind{
  if(name.endsWith('/'))return 'directory';
  const host=(versionMadeBy>>>8)&0xff;
  if(host!==3)return 'file';
  const mode=(externalAttrs>>>16)&0xffff;
  const type=mode&0o170000;
  if(type===0o120000)return 'symlink';
  if(type===0o020000||type===0o060000)return 'device';
  if(type===0o010000)return 'fifo';
  if(type===0o040000)return 'directory';
  if(type===0||type===0o100000)return 'file';
  return 'other';
}

function extractEntry(buffer:Buffer,entry:Omit<ZipEntry,'data'>):Buffer{
  if(entry.localOffset<0||entry.localOffset+30>buffer.length||buffer.readUInt32LE(entry.localOffset)!==LOCAL_SIGNATURE){
    throw new Error(`ZIP local header is invalid: ${entry.path}`);
  }
  const localNameLength=buffer.readUInt16LE(entry.localOffset+26);
  const localExtraLength=buffer.readUInt16LE(entry.localOffset+28);
  const start=entry.localOffset+30+localNameLength+localExtraLength;
  const end=start+entry.compressedSize;
  if(start<0||end>buffer.length)throw new Error(`ZIP entry data is out of bounds: ${entry.path}`);
  const compressed=buffer.subarray(start,end);
  let data:Buffer;
  if(entry.kind==='directory')data=Buffer.alloc(0);
  else if(entry.method===0)data=Buffer.from(compressed);
  else if(entry.method===8){
    data=zlib.inflateRawSync(compressed,{maxOutputLength:Math.min(DEFAULT_BUNDLE_LIMITS.maxEntryExpandedBytes,entry.expandedSize+1)});
  }else throw new Error(`ZIP compression method ${entry.method} is not supported`);
  if(data.length!==entry.expandedSize)throw new Error(`ZIP expanded size mismatch: ${entry.path}`);
  if(entry.kind==='file'&&crc32(data)!==entry.crc32)throw new Error(`ZIP CRC mismatch: ${entry.path}`);
  return data;
}

function readZip(buffer:Buffer):ZipEntry[]{
  if(buffer.length<22)throw new Error('ZIP file is too small');
  if(buffer.length>config.maxBundleUploadBytes)throw new Error('Bundle exceeds configured upload-size limit');
  const eocd=findEocd(buffer);
  const disk=buffer.readUInt16LE(eocd+4);
  const centralDisk=buffer.readUInt16LE(eocd+6);
  const diskEntries=buffer.readUInt16LE(eocd+8);
  const totalEntries=buffer.readUInt16LE(eocd+10);
  const centralSize=buffer.readUInt32LE(eocd+12);
  const centralOffset=buffer.readUInt32LE(eocd+16);
  if(disk!==0||centralDisk!==0||diskEntries!==totalEntries)throw new Error('Multi-disk ZIP is not supported');
  if(totalEntries===0xffff||centralSize===0xffffffff||centralOffset===0xffffffff)throw new Error('ZIP64 bundle is not supported');
  if(centralOffset+centralSize>buffer.length)throw new Error('ZIP central directory is out of bounds');
  const entries:Array<Omit<ZipEntry,'data'>>=[];
  let offset=centralOffset;
  for(let index=0;index<totalEntries;index+=1){
    if(offset+46>buffer.length||buffer.readUInt32LE(offset)!==CENTRAL_SIGNATURE)throw new Error('ZIP central directory is malformed');
    const versionMadeBy=buffer.readUInt16LE(offset+4);
    const flags=buffer.readUInt16LE(offset+8);
    const method=buffer.readUInt16LE(offset+10);
    const crc=buffer.readUInt32LE(offset+16);
    const compressedSize=buffer.readUInt32LE(offset+20);
    const expandedSize=buffer.readUInt32LE(offset+24);
    const nameLength=buffer.readUInt16LE(offset+28);
    const extraLength=buffer.readUInt16LE(offset+30);
    const commentLength=buffer.readUInt16LE(offset+32);
    const diskStart=buffer.readUInt16LE(offset+34);
    const externalAttrs=buffer.readUInt32LE(offset+38);
    const localOffset=buffer.readUInt32LE(offset+42);
    const next=offset+46+nameLength+extraLength+commentLength;
    if(next>buffer.length)throw new Error('ZIP central directory entry is truncated');
    if(flags&0x1)throw new Error('Encrypted ZIP entries are forbidden');
    if(diskStart!==0)throw new Error('Multi-disk ZIP entry is forbidden');
    if([compressedSize,expandedSize,localOffset].some((value)=>value===0xffffffff))throw new Error('ZIP64 entry is not supported');
    const name=buffer.subarray(offset+46,offset+46+nameLength).toString('utf8');
    if(!name||name.includes('\uFFFD'))throw new Error('ZIP entry filename is invalid UTF-8');
    const kind=zipKind(name,versionMadeBy,externalAttrs);
    entries.push({
      path:kind==='directory'?name.replace(/\/+$/,''):name,
      kind,method,flags,crc32:crc,compressedSize,expandedSize,localOffset
    });
    offset=next;
  }
  const meta:BundleEntryMeta[]=entries.map((entry)=>({
    path:entry.path,kind:entry.kind,compressedSize:entry.compressedSize,expandedSize:entry.expandedSize
  }));
  validateBundleEntries(meta,BUNDLE_LIMITS);
  return entries.map((entry)=>({...entry,data:extractEntry(buffer,entry)}));
}

function mediaName(value:string):{externalId:string;order:number}|null{
  const match=value.match(/^media\/([A-Za-z0-9._-]{1,160})__(\d{2,4})\.[A-Za-z0-9]+$/);
  if(!match)return null;
  return {externalId:match[1]!,order:Number(match[2])};
}

function extensionAllowed(pathValue:string,mime:SniffedMime):boolean{
  const ext=path.extname(pathValue).toLowerCase();
  const allowed:Record<SniffedMime,string[]>={
    'image/jpeg':['.jpg','.jpeg'],
    'image/png':['.png'],
    'image/gif':['.gif'],
    'image/webp':['.webp'],
    'video/mp4':['.mp4']
  };
  return allowed[mime].includes(ext);
}

function rowCounts(rows:V3Validation['rows']):V3Validation['summary']{
  const count=(kind:V3Classification)=>rows.filter((row)=>row.classification===kind).length;
  return {
    totalRows:rows.length,newRows:count('NEW'),updateRows:count('UPDATE'),unchangedRows:count('UNCHANGED'),
    conflicts:count('CONFLICT'),requests:count('ARCHIVE_REQUEST')+count('TRASH_REQUEST'),errors:count('ERROR')
  };
}

function existingBundlePost(sourceKeyValue:string,externalId:string):any|undefined{
  return db.prepare(`SELECT id,content_version,imported_content_version,source_revision,source_payload_hash,status
    FROM posts WHERE source_type=? AND source_ref=?`).get(SOURCE_TYPE,sourceRef(sourceKeyValue,externalId)) as any;
}

function enrichBundleClassification(
  validation:V3Validation,
  sourceKeyValue:string,
  mediaByExternalId:Map<string,Array<BundleMediaPreview & {data:Buffer;originalName:string}>>
):V3Validation{
  const rows=validation.rows.map((input)=>{
    if(!input.normalized)return input;
    const normalized:any={...input.normalized};
    const media=(mediaByExternalId.get(normalized.externalId)||[]).map(({data:_,...item})=>item);
    normalized.payloadHash=sha256(JSON.stringify({base:normalized.payloadHash,media:media.map((item)=>({
      path:item.path,order:item.order,mimeType:item.mimeType,sizeBytes:item.sizeBytes,sha256:item.sha256
    }))}));
    const existing=existingBundlePost(sourceKeyValue,normalized.externalId);
    const errors=[...input.errors];
    let classification:V3Classification;
    if(!existing){
      classification='NEW';normalized.postId=null;normalized.importedContentVersion=null;
    }else{
      normalized.postId=existing.id;normalized.importedContentVersion=existing.imported_content_version;
      const editable=['DRAFT','READY','FAILED'].includes(existing.status);
      const diverged=existing.imported_content_version==null||existing.content_version!==existing.imported_content_version;
      if(existing.source_payload_hash===normalized.payloadHash)classification='UNCHANGED';
      else if(existing.source_revision===normalized.sourceRevision){
        classification='ERROR';errors.push('source_revision was reused with a different bundle payload');
      }else if(!editable){
        classification='ERROR';errors.push(`Post status=${existing.status} is immutable for Content Bundle sync`);
      }else if(diverged)classification='CONFLICT';
      else classification='UPDATE';
    }
    normalized.classification=classification;
    return {...input,classification,errors,normalized:errors.length?null:normalized};
  });
  const summary=rowCounts(rows);
  return {...validation,rows,summary,canApply:summary.errors===0&&summary.conflicts===0};
}

async function buildBundle(buffer:Buffer,sourceIdRaw:string):Promise<InternalBundle>{
  const key=sourceKey(sourceIdRaw);
  const entries=readZip(buffer);
  const files=entries.filter((entry)=>entry.kind==='file');
  const content=files.filter((entry)=>['content.csv','content.xlsx'].includes(entry.path.toLowerCase()));
  if(content.length!==1)throw new Error('Bundle must contain exactly one root content.csv or content.xlsx');
  const manifestEntry=files.find((entry)=>entry.path.toLowerCase()==='manifest.json');
  let manifest:Record<string,unknown>|null=null;
  if(manifestEntry){
    try{
      const parsed=JSON.parse(manifestEntry.data.toString('utf8'));
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('object required');
      manifest=parsed as Record<string,unknown>;
    }catch(error){throw new Error(`manifest.json is invalid: ${error instanceof Error?error.message:String(error)}`);}
  }

  const mediaByExternalId=new Map<string,Array<BundleMediaPreview & {data:Buffer;originalName:string}>>();
  const mediaPreview:BundleMediaPreview[]=[];
  const orderKeys=new Set<string>();
  const mediaFiles=files.filter((entry)=>entry.path.startsWith('media/'));
  if(mediaFiles.length>config.maxBundleMediaFiles)throw new Error(`Bundle has more than ${config.maxBundleMediaFiles} media files`);
  for(const entry of mediaFiles){
    const identity=mediaName(entry.path);
    if(!identity)throw new Error(`Bundle media filename must be media/<external_id>__NN.ext: ${entry.path}`);
    const mime=sniffMediaMime(entry.data);
    if(!mime)throw new Error(`Bundle media MIME is not recognized: ${entry.path}`);
    if(!extensionAllowed(entry.path,mime))throw new Error(`Bundle media extension does not match bytes: ${entry.path}`);
    const keyOrder=`${identity.externalId}\u0000${identity.order}`;
    if(orderKeys.has(keyOrder))throw new Error(`Duplicate media order for ${identity.externalId}: ${identity.order}`);
    orderKeys.add(keyOrder);
    const item={path:entry.path,externalId:identity.externalId,order:identity.order,mimeType:mime,sizeBytes:entry.data.length,sha256:sha256(entry.data)};
    mediaPreview.push(item);
    const rows=mediaByExternalId.get(identity.externalId)||[];
    rows.push({...item,data:entry.data,originalName:path.basename(entry.path)});
    mediaByExternalId.set(identity.externalId,rows);
  }
  for(const rows of mediaByExternalId.values())rows.sort((a,b)=>a.order-b.order||a.path.localeCompare(b.path));

  const parsed=await parseContentPlanV3(path.basename(content[0]!.path),content[0]!.data);
  let validation=await validateContentPlanV3(parsed,key);
  const externalIds=new Set(validation.rows.map((row)=>row.normalized?.externalId).filter((value):value is string=>Boolean(value)));
  for(const externalId of mediaByExternalId.keys()){
    if(!externalIds.has(externalId))throw new Error(`Bundle media has no content row for external_id=${externalId}`);
  }
  validation=enrichBundleClassification(validation,key,mediaByExternalId);
  const preview:ContentBundlePreview={
    ...validation,sourceKey:key,bundleSha256:sha256(buffer),contentFile:content[0]!.path,
    media:mediaPreview.sort((a,b)=>a.externalId.localeCompare(b.externalId)||a.order-b.order),manifest
  };
  return {preview,mediaByExternalId};
}

export async function previewContentBundle(buffer:Buffer,sourceId:string):Promise<ContentBundlePreview>{
  return (await buildBundle(buffer,sourceId)).preview;
}

async function prepareImage(data:Buffer):Promise<{data:Buffer;width:number;height:number;sha256:string}>{
  if(data.length>config.maxImageBytes)throw new Error(`Image exceeds ${config.maxImageBytes} bytes`);
  const source=sharp(data,{failOn:'error'}).rotate();
  const metadata=await source.metadata();
  if(!metadata.width||!metadata.height)throw new Error('Bundle image is invalid');
  if(metadata.width>MAX_IMAGE_DIMENSION||metadata.height>MAX_IMAGE_DIMENSION)throw new Error(`Bundle image exceeds ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}`);
  const out=await source.flatten({background:'#ffffff'}).jpeg({quality:92,mozjpeg:true}).toBuffer({resolveWithObject:true});
  if(out.data.length>config.maxImageBytes)throw new Error('Normalized bundle image exceeds image limit');
  return {data:out.data,width:out.info.width,height:out.info.height,sha256:sha256(out.data)};
}

async function oneBuffer(data:Buffer):Promise<AsyncGenerator<Buffer>>{
  async function* generator(){yield data;}
  return generator();
}

function roleFor(format:string,mime:string):PreparedMediaRow['role']{
  if(mime==='video/mp4')return format==='STORY_SEQUENCE'?'story_item':'video';
  if(format==='CAROUSEL')return 'carousel_item';
  if(format==='STORY_SEQUENCE')return 'story_item';
  return 'primary';
}

async function prepareMediaPlan(
  externalId:string,
  postId:string,
  contentFormat:string,
  items:Array<BundleMediaPreview & {data:Buffer;originalName:string}>
):Promise<BundleMediaPlan>{
  const previous=listMedia(postId);
  const rows:PreparedMediaRow[]=[];
  const newPaths:string[]=[];
  const cleanupPreparations:Array<()=>Promise<void>>=[];
  const postDir=path.join(config.mediaDir,postId);
  if(items.length)await fs.mkdir(postDir,{recursive:true});
  try{
    let sequence=0;
    for(const item of items){
      if(item.mimeType.startsWith('image/')){
        const image=await prepareImage(item.data);
        const mediaId=id('med');
        const relativePath=path.posix.join(postId,`${mediaId}.jpg`);
        const absolutePath=path.join(config.mediaDir,relativePath);
        await fs.writeFile(absolutePath,image.data,{flag:'wx'});
        newPaths.push(absolutePath);
        rows.push({
          id:mediaId,originalName:item.originalName,relativePath,absolutePath,mimeType:'image/jpeg',sizeBytes:image.data.length,
          width:image.width,height:image.height,sha256:image.sha256,sortOrder:sequence++,durationMs:null,fps:null,
          videoCodec:null,audioCodec:null,container:null,posterAssetId:null,role:roleFor(contentFormat,'image/jpeg')
        });
        continue;
      }
      const prepared:PreparedVideoUpload=await prepareVideoUpload(item.originalName,await oneBuffer(item.data));
      cleanupPreparations.push(prepared.cleanup);
      const videoId=id('med');
      const posterId=id('med');
      const videoRelative=path.posix.join(postId,`${videoId}.mp4`);
      const posterRelative=path.posix.join(postId,`${posterId}.jpg`);
      const videoAbsolute=path.join(config.mediaDir,videoRelative);
      const posterAbsolute=path.join(config.mediaDir,posterRelative);
      await fs.rename(prepared.tempVideoPath,videoAbsolute);
      newPaths.push(videoAbsolute);
      const poster=await prepareImage(prepared.posterData);
      await fs.writeFile(posterAbsolute,poster.data,{flag:'wx'});
      newPaths.push(posterAbsolute);
      const videoOrder=sequence++;
      rows.push({
        id:posterId,originalName:`${path.basename(item.originalName,path.extname(item.originalName))}.poster.jpg`,
        relativePath:posterRelative,absolutePath:posterAbsolute,mimeType:'image/jpeg',sizeBytes:poster.data.length,width:poster.width,height:poster.height,
        sha256:poster.sha256,sortOrder:videoOrder+10000,durationMs:null,fps:null,videoCodec:null,audioCodec:null,container:null,
        posterAssetId:null,role:'poster'
      });
      rows.push({
        id:videoId,originalName:item.originalName,relativePath:videoRelative,absolutePath:videoAbsolute,mimeType:'video/mp4',
        sizeBytes:prepared.sizeBytes,width:prepared.width,height:prepared.height,sha256:prepared.sha256,sortOrder:videoOrder,
        durationMs:prepared.durationMs,fps:prepared.fps,videoCodec:prepared.videoCodec,audioCodec:prepared.audioCodec,
        container:prepared.container,posterAssetId:posterId,role:roleFor(contentFormat,'video/mp4')
      });
    }
    return {externalId,postId,rows,previous,newPaths,cleanupPreparations};
  }catch(error){
    await Promise.all(newPaths.map((file)=>fs.rm(file,{force:true}))).catch(()=>undefined);
    await Promise.all(cleanupPreparations.map((cleanup)=>cleanup())).catch(()=>undefined);
    throw error;
  }
}

function applyMediaPlan(plan:BundleMediaPlan):number{
  const current=db.prepare('SELECT content_version FROM posts WHERE id=?').get(plan.postId) as {content_version:number}|undefined;
  if(!current)throw new Error(`Bundle post disappeared: ${plan.externalId}`);
  if(plan.rows.length===0&&plan.previous.length===0)return current.content_version;
  const committed=commitContentEdit(plan.postId,current.content_version,'content_plan',()=>{
    db.prepare('DELETE FROM media WHERE post_id=?').run(plan.postId);
    const now=nowIso();
    const insert=db.prepare(`INSERT INTO media
      (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order,
       duration_ms,fps,video_codec,audio_codec,container,poster_asset_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const posters=plan.rows.filter((row)=>row.role==='poster');
    const others=plan.rows.filter((row)=>row.role!=='poster');
    for(const row of [...posters,...others]){
      insert.run(row.id,plan.postId,row.originalName,row.relativePath,row.mimeType,row.sizeBytes,row.width,row.height,row.sha256,now,row.sortOrder,
        row.durationMs,row.fps,row.videoCodec,row.audioCodec,row.container,row.posterAssetId);
      if(row.role==='poster')db.prepare("UPDATE content_media SET role='poster' WHERE media_id=?").run(row.id);
      else db.prepare('UPDATE content_media SET role=?,sort_order=? WHERE media_id=?').run(row.role,row.sortOrder,row.id);
    }
  });
  return committed.contentVersion;
}

async function cleanupPrepared(plans:BundleMediaPlan[]):Promise<void>{
  await Promise.all(plans.flatMap((plan)=>plan.newPaths.map((file)=>fs.rm(file,{force:true})))).catch(()=>undefined);
  await Promise.all(plans.flatMap((plan)=>plan.cleanupPreparations.map((cleanup)=>cleanup()))).catch(()=>undefined);
}

async function finalizePrepared(plans:BundleMediaPlan[]):Promise<void>{
  await Promise.all(plans.flatMap((plan)=>plan.cleanupPreparations.map((cleanup)=>cleanup()))).catch(()=>undefined);
  for(const plan of plans){
    for(const media of plan.previous){
      await fs.rm(path.join(config.mediaDir,media.relative_path),{force:true}).catch(()=>undefined);
    }
  }
}

export async function applyContentBundle(
  buffer:Buffer,
  sourceId:string,
  expectedBundleSha256:string
):Promise<{created:number;updated:number;unchanged:number;archived:number;trashed:number;postIds:string[];bundleSha256:string;mediaFiles:number}>{
  if(!/^[a-f0-9]{64}$/i.test(expectedBundleSha256))throw new Error('A bundle SHA-256 from preview is required');
  const built=await buildBundle(buffer,sourceId);
  if(built.preview.bundleSha256!==expectedBundleSha256.toLowerCase())throw new Error('Content Bundle changed after preview; preview again');
  if(!built.preview.canApply)throw new Error('Content Bundle preview contains ERROR/CONFLICT');

  const newPostIds=new Map<string,string>();
  for(const row of built.preview.rows){
    if(row.classification==='NEW'&&row.normalized)newPostIds.set(row.normalized.externalId,id('post'));
  }

  const plans:BundleMediaPlan[]=[];
  try{
    for(const row of built.preview.rows){
      if(!row.normalized||!['NEW','UPDATE'].includes(row.classification))continue;
      const postId=row.normalized.postId||newPostIds.get(row.normalized.externalId);
      if(!postId)throw new Error(`Bundle lost post identity: ${row.normalized.externalId}`);
      const items=built.mediaByExternalId.get(row.normalized.externalId)||[];
      if(row.classification==='NEW'&&items.length===0)continue;
      plans.push(await prepareMediaPlan(row.normalized.externalId,postId,row.normalized.contentFormat,items));
    }
    const byExternal=new Map(plans.map((plan)=>[plan.externalId,plan]));
    const result=applyContentPlanV3(built.preview,{
      actorSource:'content_plan',
      sourceTypeOverride:SOURCE_TYPE,
      newPostIds,
      afterRow:({row,classification})=>{
        if(!['NEW','UPDATE'].includes(classification))return;
        const plan=byExternal.get(row.externalId);
        if(!plan)return;
        const version=applyMediaPlan(plan);
        db.prepare('UPDATE posts SET imported_content_version=? WHERE id=?').run(version,plan.postId);
      }
    });
    await finalizePrepared(plans);
    event({
      type:'import.applied',message:`Content Bundle applied: ${built.preview.rows.length} rows`,
      data:{sourceKey:built.preview.sourceKey,bundleSha256:built.preview.bundleSha256,mediaFiles:built.preview.media.length,...result}
    });
    return {...result,bundleSha256:built.preview.bundleSha256,mediaFiles:built.preview.media.length};
  }catch(error){
    await cleanupPrepared(plans);
    throw error;
  }
}
