import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION } from './current-schema-version.mjs';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-ew4-003-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='ew4-003-ci-password';
process.env.APP_MASTER_KEY='ew4-003-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const sharp=(await import('sharp')).default;
const { db,migrate,id,nowIso }=await import('../dist/db.js');
const { encryptJson }=await import('../dist/crypto.js');
const { saveImageVersioned }=await import('../dist/media.js');
const {
  RICH_TEXT_LIMITS,
  normalizeRichText,
  serializeRichText,
  parseRichTextJson,
  plainTextToRichText,
  richTextToPlain
}=await import('../dist/rich-text.js');
const { saveTargetRendition }=await import('../dist/delivery-foundation.js');
const {
  CONTENT_PLAN_V3_COLUMNS,
  parseContentPlanV3,
  validateContentPlanV3,
  applyContentPlanV3
}=await import('../dist/content-plan-v3.js');
const { setPublisherForTests }=await import('../dist/platforms/index.js');
const { publishPost }=await import('../dist/publisher.js');
const { buildApp }=await import('../dist/app.js');

migrate();
assert.equal(Number(db.pragma('user_version',{simple:true})),CURRENT_SCHEMA_VERSION);

const complexAst={
  type:'doc',
  content:[
    {type:'paragraph',content:[
      {type:'text',text:'Привет ',marks:[]},
      {type:'text',text:'формат',marks:[{type:'underline'},{type:'bold'},{type:'bold'},{type:'italic'},{type:'strike'},{type:'code'}]},
      {type:'hard_break'},
      {type:'link',attrs:{href:'https://example.test/docs',title:'Документация'},content:[
        {type:'text',text:'ссылка 🙂',marks:[{type:'italic'}]}
      ]}
    ]},
    {type:'blockquote',content:[
      {type:'paragraph',content:[{type:'text',text:'Цитата',marks:[]}]}
    ]},
    {type:'bullet_list',content:[
      {type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'Пункт',marks:[]}]}]}
    ]},
    {type:'ordered_list',content:[
      {type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'Номер',marks:[]}]}]}
    ]},
    {type:'code_block',content:[
      {type:'text',text:'const x = 1;',marks:[]},
      {type:'hard_break'},
      {type:'text',text:'console.log(x);',marks:[]}
    ]}
  ]
};

const normalized=normalizeRichText(complexAst);
assert.deepEqual(normalized.content[0].content[1].marks.map(mark=>mark.type),['bold','italic','underline','strike','code']);
assert.equal(serializeRichText(complexAst),serializeRichText(normalized));
assert.deepEqual(parseRichTextJson(serializeRichText(complexAst)),normalized);
const complexPlain=richTextToPlain(complexAst);
assert.match(complexPlain,/Привет формат/);
assert.match(complexPlain,/ссылка 🙂 \(https:\/\/example\.test\/docs\)/);
assert.match(complexPlain,/> Цитата/);
assert.match(complexPlain,/• Пункт/);
assert.match(complexPlain,/1\. Номер/);
assert.match(complexPlain,/const x = 1;\nconsole\.log\(x\);/);

const literal='**текст**\n\n🙂 Кириллица <not-html>';
const literalDoc=plainTextToRichText(literal);
assert.equal(richTextToPlain(literalDoc),literal);
assert.equal(literalDoc.content[0].content[0].text,literal);

assert.throws(()=>normalizeRichText({type:'doc',content:[{type:'script',content:[]}]}),/(forbidden|block nodes)/i);
assert.throws(()=>normalizeRichText({type:'doc',content:[{type:'paragraph',onclick:'alert(1)',content:[]}]}),/forbidden/i);
assert.throws(()=>normalizeRichText({type:'doc',content:[{type:'paragraph',innerHTML:'<script>',content:[]}]}),/forbidden/i);
for(const href of ['javascript:alert(1)','data:text/html,boom','file:///etc/passwd','https://user:pass@example.test/']){
  assert.throws(()=>normalizeRichText({type:'doc',content:[{type:'paragraph',content:[
    {type:'link',attrs:{href},content:[{type:'text',text:'x',marks:[]}]}
  ]}]}),/(protocol|credentials)/i);
}
assert.throws(()=>normalizeRichText({type:'doc',content:[{type:'paragraph',content:[
  {type:'text',text:'x',marks:[{type:'bold',style:'evil'}]}
]}]}),/forbidden/i);

let deep={type:'paragraph',content:[{type:'text',text:'deep',marks:[]}]};
for(let i=0;i<RICH_TEXT_LIMITS.maxDepth+2;i+=1) deep={type:'blockquote',content:[deep]};
assert.throws(()=>normalizeRichText({type:'doc',content:[deep]}),/depth/i);
const tooMany=Array.from({length:5001},()=>({type:'paragraph',content:[{type:'text',text:'x',marks:[]}]}));
assert.throws(()=>normalizeRichText({type:'doc',content:tooMany}),/nodes/i);
assert.throws(()=>normalizeRichText({type:'doc',content:[{type:'paragraph',content:[
  {type:'text',text:'x'.repeat(RICH_TEXT_LIMITS.maxTextBytes+1),marks:[]}
]}]}),/(text|size)/i);

const accountId=id('acc');
const accountTime='2000-01-01T00:00:00.000Z';
db.prepare(`INSERT INTO social_accounts
 (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
 VALUES (?,?,?,?,1,?,?)`).run(
  accountId,'telegram','EW4-003 target',encryptJson({botToken:'mock',chatId:'@ew4rich'}),accountTime,accountTime
);

let publishedInputs=[];
setPublisherForTests('telegram',{
  platform:'telegram',
  validate(input){ assert.ok(typeof input.text==='string'); },
  async publish(input){
    publishedInputs.push(input);
    return {externalId:`rich-${publishedInputs.length}`,externalUrl:`https://example.test/rich/${publishedInputs.length}`};
  }
});

const app=await buildApp();
await app.ready();
const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});
assert.equal(login.statusCode,200,login.body);
const cookie=String(login.headers['set-cookie']).split(';')[0];
const project=db.prepare('SELECT id,slug FROM projects ORDER BY created_at LIMIT 1').get();
db.prepare(`INSERT INTO project_default_targets (project_id,account_id,created_at) VALUES (?,?,?)`)
  .run(project.id,accountId,accountTime);

async function api(method,url,payload,expected=200,headers={}){
  const response=await app.inject({method,url,headers:{cookie,...headers},...(payload===undefined?{}:{payload})});
  assert.equal(response.statusCode,expected,`${method} ${url}: ${response.body}`);
  return response.json();
}

const legacyPost=await api('POST','/api/posts',{
  projectId:project.id,
  title:'Legacy literal',
  body:'**hello**',
  scheduleMode:'MANUAL'
},201);
assert.equal(legacyPost.body,'**hello**');
assert.equal(richTextToPlain(legacyPost.bodyRich),'**hello**');
assert.equal(legacyPost.bodyRich.content[0].content[0].text,'**hello**');
const legacyRevision=db.prepare('SELECT body,body_rich_json FROM content_revisions WHERE post_id=? AND content_version=1').get(legacyPost.id);
assert.equal(legacyRevision.body,'**hello**');
assert.equal(richTextToPlain(parseRichTextJson(legacyRevision.body_rich_json)),'**hello**');

const richV1={type:'doc',content:[{type:'paragraph',content:[
  {type:'text',text:'Версия ',marks:[]},
  {type:'text',text:'один',marks:[{type:'bold'}]}
]}]};
const richPost=await api('POST','/api/posts',{
  projectId:project.id,
  title:'Rich post',
  body:'MISMATCH MUST BE IGNORED',
  bodyRich:richV1,
  scheduleMode:'MANUAL'
},201);
const richV1Plain=richTextToPlain(richV1);
assert.equal(richPost.body,richV1Plain);
assert.notEqual(richPost.body,'MISMATCH MUST BE IGNORED');
assert.equal(serializeRichText(richPost.bodyRich),serializeRichText(richV1));
assert.equal(db.prepare('SELECT body_rich_json FROM content_revisions WHERE post_id=? AND content_version=1').get(richPost.id).body_rich_json,serializeRichText(richV1));

const image=await sharp({create:{width:32,height:32,channels:3,background:{r:80,g:120,b:160}}}).jpeg().toBuffer();
const media=await saveImageVersioned(richPost.id,'rich.jpg',image,1);
assert.equal(media.contentVersion,2);

const richV2={type:'doc',content:[
  {type:'paragraph',content:[
    {type:'text',text:'Версия два ',marks:[{type:'italic'}]},
    {type:'link',attrs:{href:'https://example.test/v2'},content:[{type:'text',text:'ссылка',marks:[{type:'underline'}]}]}
  ]},
  {type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'Цитата v2',marks:[]}]}]}
]};
const patched=await api('PATCH',`/api/posts/${richPost.id}`,{
  body:'STALE PLAIN MUST BE IGNORED',
  bodyRich:richV2,
  expectedContentVersion:2
});
assert.equal(patched.contentVersion,3);
assert.equal(patched.post.body,richTextToPlain(richV2));
assert.equal(serializeRichText(patched.post.bodyRich),serializeRichText(richV2));

const ready=await api('POST',`/api/posts/${richPost.id}/ready`,{expectedContentVersion:3});
assert.equal(ready.contentVersion,3);
const readyRevision=db.prepare('SELECT id,content_version,body,body_rich_json,editorial_stage FROM content_revisions WHERE id=?').get(ready.revisionId);
assert.equal(readyRevision.content_version,3);
assert.equal(readyRevision.editorial_stage,'APPROVED');
assert.equal(readyRevision.body,richTextToPlain(richV2));
assert.equal(readyRevision.body_rich_json,serializeRichText(richV2));

const richV3={type:'doc',content:[{type:'paragraph',content:[
  {type:'text',text:'Версия три после READY',marks:[{type:'strike'}]}
]}]};
const afterReadyEdit=await api('PATCH',`/api/posts/${richPost.id}`,{
  bodyRich:richV3,
  expectedContentVersion:3
});
assert.equal(afterReadyEdit.contentVersion,4);
assert.equal(afterReadyEdit.post.status,'DRAFT');
assert.equal(afterReadyEdit.post.ready_revision_id,null);

await api('PATCH',`/api/posts/${richPost.id}`,{bodyRich:richV1,expectedContentVersion:3},409);

const diff=await api('GET',`/api/posts/${richPost.id}/revisions/${ready.revisionId}/diff`);
assert.equal(diff.richText.changed,true);
assert.equal(serializeRichText(diff.richText.before),serializeRichText(richV2));
assert.equal(serializeRichText(diff.richText.after),serializeRichText(richV3));
assert.equal(serializeRichText(diff.revision.bodyRich),serializeRichText(richV2));

const restored=await api('POST',`/api/posts/${richPost.id}/revisions/${ready.revisionId}/restore`,{
  expectedContentVersion:4
});
assert.equal(restored.contentVersion,5);
const restoredPost=await api('GET',`/api/posts/${richPost.id}`);
assert.equal(restoredPost.status,'DRAFT');
assert.equal(restoredPost.editorial_stage,'DRAFT');
assert.equal(restoredPost.ready_revision_id,null);
assert.equal(restoredPost.body,richTextToPlain(richV2));
assert.equal(serializeRichText(restoredPost.bodyRich),serializeRichText(richV2));
const restoreRevision=db.prepare('SELECT content_version,body,body_rich_json,actor_source,restored_from_revision_id FROM content_revisions WHERE post_id=? ORDER BY content_version DESC LIMIT 1').get(richPost.id);
assert.equal(restoreRevision.content_version,5);
assert.equal(restoreRevision.actor_source,'manual_restore');
assert.equal(restoreRevision.restored_from_revision_id,ready.revisionId);
assert.equal(restoreRevision.body_rich_json,serializeRichText(richV2));

const richTarget=restoredPost.targets.find(target=>target.account_id===accountId);
assert.ok(richTarget);
const renditionAst={type:'doc',content:[{type:'paragraph',content:[
  {type:'text',text:'Target ',marks:[{type:'underline'},{type:'bold'}]},
  {type:'link',attrs:{href:'https://example.test/target'},content:[{type:'text',text:'link',marks:[]}]}
]}]};
const renditionSaved=saveTargetRendition(richTarget.id,{
  textRichJson:JSON.stringify(renditionAst),
  textPlain:'WRONG TARGET PLAIN'
},5);
assert.equal(renditionSaved.contentVersion,6);
const renditionRow=db.prepare('SELECT text_rich_json,text_plain FROM target_renditions WHERE target_id=?').get(richTarget.id);
assert.equal(renditionRow.text_rich_json,serializeRichText(renditionAst));
assert.equal(renditionRow.text_plain,richTextToPlain(renditionAst));

db.prepare("UPDATE posts SET status='PUBLISHED',editorial_stage='APPROVED' WHERE id=?").run(legacyPost.id);
await api('PATCH',`/api/posts/${legacyPost.id}`,{bodyRich:richV1,expectedContentVersion:1},409);

function csvCell(value){
  const text=String(value??'');
  return /[",\n\r]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;
}
function planCsv(externalId,title,body,sourceRevision){
  const values={
    schema_version:'3',external_id:externalId,action:'UPSERT',project:project.slug,template_key:'',
    internal_title:title,body,publication_kind:'FEED',content_format:'IMAGE',schedule_mode:'MANUAL',
    scheduled_at:'',timezone:'UTC',targets:'[]',telegram_body:'',vk_body:'',max_body:'',instagram_body:'',
    media:'',tags:'',source_note:'',source_revision:sourceRevision
  };
  return Buffer.from(
    CONTENT_PLAN_V3_COLUMNS.join(',')+'\n'+CONTENT_PLAN_V3_COLUMNS.map(column=>csvCell(values[column])).join(',')+'\n',
    'utf8'
  );
}

const importLiteral='**hello from sheet**';
const parsedPlan=await parseContentPlanV3('rich-plan.csv',planCsv('ew4-rich-cp','Content Plan literal',importLiteral,'r1'));
const validatedPlan=await validateContentPlanV3(parsedPlan,'ew4-rich-plan');
assert.equal(validatedPlan.canApply,true,JSON.stringify(validatedPlan.rows));
const appliedPlan=applyContentPlanV3(validatedPlan,{actorSource:'content_plan'});
assert.equal(appliedPlan.created,1);
const planPost=db.prepare('SELECT id,body,body_rich_json FROM posts WHERE id=?').get(appliedPlan.postIds[0]);
assert.equal(planPost.body,importLiteral);
assert.equal(richTextToPlain(parseRichTextJson(planPost.body_rich_json)),importLiteral);
assert.equal(parseRichTextJson(planPost.body_rich_json).content[0].content[0].text,importLiteral);
assert.equal(db.prepare('SELECT actor_source FROM content_revisions WHERE post_id=? AND content_version=1').get(planPost.id).actor_source,'content_plan');

const parsedSheet=await parseContentPlanV3('sheet.csv',planCsv('ew4-rich-sheet','Sheets literal',importLiteral,'s1'));
const validatedSheet=await validateContentPlanV3(parsedSheet,'ew4-rich-sheet-source');
assert.equal(validatedSheet.canApply,true,JSON.stringify(validatedSheet.rows));
const appliedSheet=applyContentPlanV3(validatedSheet,{actorSource:'google_sheets',sourceTypeOverride:'google_sheets'});
assert.equal(appliedSheet.created,1);
const sheetPost=db.prepare('SELECT id,body,body_rich_json FROM posts WHERE id=?').get(appliedSheet.postIds[0]);
assert.equal(sheetPost.body,importLiteral);
assert.equal(richTextToPlain(parseRichTextJson(sheetPost.body_rich_json)),importLiteral);
assert.equal(db.prepare('SELECT actor_source FROM content_revisions WHERE post_id=? AND content_version=1').get(sheetPost.id).actor_source,'google_sheets');

const publishAst={type:'doc',content:[{type:'paragraph',content:[
  {type:'text',text:'Publisher ',marks:[{type:'bold'},{type:'underline'}]},
  {type:'link',attrs:{href:'https://example.test/plain'},content:[{type:'text',text:'plain link',marks:[{type:'italic'}]}]}
]}]};
const publishPostView=await api('POST','/api/posts',{
  projectId:project.id,title:'Publisher plain fallback',bodyRich:publishAst,scheduleMode:'MANUAL'
},201);
const publishMedia=await saveImageVersioned(publishPostView.id,'publish.jpg',image,1);
assert.equal(publishMedia.contentVersion,2);
const publishReady=await api('POST',`/api/posts/${publishPostView.id}/ready`,{expectedContentVersion:2});
assert.equal(publishReady.contentVersion,2);
await publishPost(publishPostView.id);
assert.equal(publishedInputs.length,1);
assert.equal(publishedInputs[0].text,richTextToPlain(publishAst));
assert.ok(!publishedInputs[0].text.includes('**'));
assert.ok(!publishedInputs[0].text.includes('<b>'));
assert.ok(!publishedInputs[0].text.includes('MarkdownV2'));
const publishedRevision=db.prepare('SELECT body,body_rich_json FROM content_revisions WHERE id=?').get(publishReady.revisionId);
assert.equal(publishedRevision.body,richTextToPlain(publishAst));
assert.equal(publishedRevision.body_rich_json,serializeRichText(publishAst));

console.log(JSON.stringify({
  ok:true,
  checkpoint:'EW4-003',
  schemaVersion:CURRENT_SCHEMA_VERSION,
  canonicalGrammar:true,
  deterministicNormalization:true,
  deterministicPlainFallback:true,
  literalMarkdownPreserved:true,
  unicodeEmoji:true,
  adversarialSecurity:true,
  apiLegacyPlainCompatibility:true,
  richApiAuthoritative:true,
  optimisticConflict:true,
  immutablePublicationBlock:true,
  revisionRichSnapshots:true,
  readyExactRichRevision:true,
  readyInvalidation:true,
  revisionRestoreRichRoundtrip:true,
  targetRenditionCanonicalValidator:true,
  contentPlanPlainCanonical:true,
  googleSheetsPlainCanonical:true,
  plainPublisherFallback:true,
  platformMarkupGenerated:false
},null,2));

setPublisherForTests('telegram',null);
await app.close();
db.close();
await fs.rm(dataDir,{recursive:true,force:true});
