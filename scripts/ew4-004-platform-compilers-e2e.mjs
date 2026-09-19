import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-ew4-004-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='ew4-004-ci-password';
process.env.APP_MASTER_KEY='ew4-004-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const sharp=(await import('sharp')).default;
const { db,migrate,id,nowIso }=await import('../dist/db.js');
const { encryptJson }=await import('../dist/crypto.js');
const { saveImageVersioned }=await import('../dist/media.js');
const { saveTargetRendition }=await import('../dist/delivery-foundation.js');
const { setPublisherForTests }=await import('../dist/platforms/index.js');
const { preflightRevision,publishPost }=await import('../dist/publisher.js');
const { PLATFORM_CAPABILITIES }=await import('../dist/platforms/capabilities.js');
const {
  compilePlatformText,
  resolveTargetRichText
}=await import('../dist/platform-text.js');
const {
  canonicalPlainRichJson,
  richTextToPlain,
  serializeRichText
}=await import('../dist/rich-text.js');
const { buildApp }=await import('../dist/app.js');

migrate();
assert.equal(Number(db.pragma('user_version',{simple:true})),11);

const richFixture={
  type:'doc',
  content:[
    {type:'paragraph',content:[
      {type:'text',text:'А🙂 ',marks:[]},
      {type:'text',text:'Ж🙂',marks:[{type:'italic'},{type:'bold'}]},
      {type:'text',text:' ',marks:[]},
      {type:'link',attrs:{href:'https://example.test/a?x=1&y=2'},content:[
        {type:'text',text:'ссылка',marks:[{type:'underline'}]}
      ]},
      {type:'hard_break'},
      {type:'text',text:'код',marks:[{type:'bold'},{type:'code'}]}
    ]},
    {type:'blockquote',content:[
      {type:'paragraph',content:[{type:'text',text:'Цитата',marks:[{type:'italic'}]}]}
    ]},
    {type:'bullet_list',content:[
      {type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'Пункт жирный',marks:[{type:'bold'}]}]}]}
    ]},
    {type:'ordered_list',content:[
      {type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'Первый',marks:[]}]}]},
      {type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'Второй',marks:[{type:'underline'}]}]}]}
    ]},
    {type:'code_block',content:[
      {type:'text',text:'const emoji = "🙂";',marks:[]},
      {type:'hard_break'},
      {type:'text',text:'return emoji;',marks:[]}
    ]}
  ]
};

assert.equal('🙂'.length,2,'JS string length must expose UTF-16 code units for Telegram offset regression');
assert.equal(Array.from('🙂').length,1,'emoji must remain one Unicode code point');

const telegram=compilePlatformText('telegram',richFixture,'media_caption');
assert.equal(telegram.transport.kind,'telegram_entities');
assert.equal(telegram.platform,'telegram');
const telegramAgain=compilePlatformText('telegram',richFixture,'media_caption');
assert.deepEqual(telegramAgain,telegram,'compiler must be deterministic');

const bold=telegram.transport.entities.find((item)=>item.type==='bold'&&telegram.transport.text.slice(item.offset,item.offset+item.length)==='Ж🙂');
const italic=telegram.transport.entities.find((item)=>item.type==='italic'&&telegram.transport.text.slice(item.offset,item.offset+item.length)==='Ж🙂');
assert.ok(bold);
assert.ok(italic);
assert.equal(bold.offset,'А🙂 '.length);
assert.equal(bold.length,'Ж🙂'.length);
assert.equal(italic.offset,bold.offset);
assert.equal(italic.length,bold.length);

const linkOffset=telegram.transport.text.indexOf('ссылка');
const link=telegram.transport.entities.find((item)=>item.type==='text_link');
assert.ok(link);
assert.equal(link.offset,linkOffset);
assert.equal(link.length,'ссылка'.length);
assert.equal(link.url,'https://example.test/a?x=1&y=2');
assert.ok(telegram.transport.entities.some((item)=>item.type==='blockquote'));
assert.ok(telegram.transport.entities.some((item)=>item.type==='pre'));
assert.ok(telegram.transport.entities.some((item)=>item.type==='code'));
assert.ok(telegram.diagnostics.some((item)=>item.code==='RICH_TELEGRAM_CODE_OVERLAP_DOWNGRADED'&&item.severity==='warning'));
assert.ok(telegram.diagnostics.some((item)=>item.code==='RICH_BULLET_LIST_TRANSFORMED'&&item.severity==='info'));
assert.ok(telegram.diagnostics.some((item)=>item.code==='RICH_ORDERED_LIST_TRANSFORMED'&&item.severity==='info'));
const entityKeys=telegram.transport.entities.map((item)=>JSON.stringify(item));
assert.equal(new Set(entityKeys).size,entityKeys.length,'Telegram entities must not duplicate');

const telegramStory=compilePlatformText('telegram',richFixture,'story_caption');
assert.equal(telegramStory.transport.kind,'telegram_entities');
assert.ok(telegramStory.transport.entities.some((item)=>item.type==='text_link'));
assert.ok(!telegramStory.diagnostics.some((item)=>item.code==='RICH_TELEGRAM_STORY_FORMATTING_DOWNGRADED'));

const htmlFixture={
  type:'doc',
  content:[
    {type:'paragraph',content:[
      {type:'text',text:'<user>& ',marks:[]},
      {type:'text',text:'bold',marks:[{type:'bold'}]},
      {type:'text',text:' ',marks:[]},
      {type:'link',attrs:{href:'https://example.test/?a=1&b=2'},content:[{type:'text',text:'go',marks:[{type:'italic'}]}]}
    ]},
    {type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'quote',marks:[]}]}]},
    {type:'bullet_list',content:[{type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'item',marks:[]}]}]}]},
    {type:'code_block',content:[{type:'text',text:'<unsafe>&',marks:[]}]}
  ]
};
const max=compilePlatformText('max',htmlFixture,'media_caption');
assert.equal(max.transport.kind,'max_html');
assert.equal(max.transport.format,'html');
assert.ok(max.transport.text.includes('&lt;user&gt;&amp;'));
assert.ok(max.transport.text.includes('<strong>bold</strong>'));
assert.ok(max.transport.text.includes('<em>go</em>'));
assert.ok(max.transport.text.includes('href="https://example.test/?a=1&amp;b=2"'));
assert.ok(max.transport.text.includes('<blockquote>quote</blockquote>'));
assert.ok(max.transport.text.includes('<pre>&lt;unsafe&gt;&amp;</pre>'));
assert.ok(max.transport.text.includes('• item'));
assert.ok(max.diagnostics.some((item)=>item.code==='RICH_BULLET_LIST_TRANSFORMED'&&item.severity==='info'));
assert.equal(max.transport.text.includes('<user>'),false,'raw user HTML must be escaped');

for(const platform of ['vk','instagram']){
  const compiled=compilePlatformText(platform,richFixture,'media_caption');
  assert.equal(compiled.transport.kind,'plain');
  assert.equal(compiled.transport.text,richTextToPlain(richFixture));
  assert.ok(compiled.diagnostics.some((item)=>item.code==='RICH_BOLD_DOWNGRADED'&&item.severity==='warning'));
  assert.ok(compiled.diagnostics.some((item)=>item.code==='RICH_UNDERLINE_DOWNGRADED'&&item.severity==='warning'));
  assert.ok(compiled.diagnostics.some((item)=>item.code==='RICH_LINK_TRANSFORMED'&&item.severity==='info'));
  assert.ok(compiled.diagnostics.some((item)=>item.code==='RICH_BLOCKQUOTE_TRANSFORMED'&&item.severity==='info'));
  assert.equal(compiled.transport.text.includes('**'),false);
  assert.equal(compiled.transport.text.includes('<strong>'),false);
  assert.match(compiled.transport.text,/ссылка \(https:\/\/example\.test\/a\?x=1&y=2\)/);
}

const mismatch=resolveTargetRichText({
  baseRichJson:serializeRichText(richFixture),
  basePlain:richTextToPlain(richFixture),
  renditionRichJson:serializeRichText({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'rich truth',marks:[]}]}]}),
  renditionPlain:'wrong plain',
  legacyOverride:'legacy must lose'
});
assert.equal(mismatch.source,'platform_override');
assert.equal(mismatch.plainText,'rich truth');
assert.ok(mismatch.diagnostics.some((item)=>item.code==='RICH_TEXT_PLAIN_MISMATCH'&&item.severity==='error'));

const legacy=resolveTargetRichText({
  baseRichJson:serializeRichText(richFixture),
  basePlain:richTextToPlain(richFixture),
  legacyOverride:'**literal legacy**'
});
assert.equal(legacy.source,'legacy_override');
assert.equal(legacy.plainText,'**literal legacy**');
assert.equal(legacy.document.content[0].content[0].text,'**literal legacy**');

assert.deepEqual(PLATFORM_CAPABILITIES.telegram.richText,{
  bold:'native',italic:'native',underline:'native',strike:'native',
  inlineCode:'native',codeBlock:'native',link:'native',quote:'native',
  bulletList:'transform',orderedList:'transform'
});
assert.equal(PLATFORM_CAPABILITIES.max.richText.quote,'native');
assert.equal(PLATFORM_CAPABILITIES.vk.richText.bold,'drop');
assert.equal(PLATFORM_CAPABILITIES.instagram.richText.link,'transform');

const platforms=['telegram','max','vk','instagram'];
const credentials={
  telegram:{botToken:'mock',chatId:'@channel'},
  max:{accessToken:'mock',chatId:'chat'},
  vk:{accessToken:'mock',groupId:'123'},
  instagram:{accessToken:'mock',igUserId:'456',graphVersion:'v24.0'}
};
const accountIds={};
for(const platform of platforms){
  const accountId=id('acc');
  accountIds[platform]=accountId;
  const ts=nowIso();
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`).run(accountId,platform,`EW4-004 ${platform}`,encryptJson(credentials[platform]),ts,ts);
}

const captures={};
for(const platform of platforms){
  setPublisherForTests(platform,{
    platform,
    validate(input){assert.ok(input.textCompilation,`${platform} mock must receive compiler output`);},
    async publish(input){
      captures[platform]=input;
      return {externalId:`${platform}-published`,externalUrl:`https://example.test/${platform}`};
    }
  });
}

const app=await buildApp();
await app.ready();
const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});
assert.equal(login.statusCode,200,login.body);
const cookie=String(login.headers['set-cookie']).split(';')[0];
const projectId=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;

async function api(method,url,payload,expected=200){
  const response=await app.inject({method,url,headers:{cookie},...(payload===undefined?{}:{payload})});
  assert.equal(response.statusCode,expected,`${method} ${url}: ${response.body}`);
  return response.json();
}

const created=await api('POST','/api/posts',{
  projectId,
  title:'EW4-004 immutable rich source',
  bodyRich:richFixture,
  scheduleMode:'MANUAL'
},201);
assert.equal(created.content_version,1);

const image=await sharp({create:{width:64,height:64,channels:3,background:{r:90,g:110,b:130}}}).jpeg().toBuffer();
const media=await saveImageVersioned(created.id,'ew4-004.jpg',image,1);
assert.equal(media.contentVersion,2);

const revision2=db.prepare('SELECT id FROM content_revisions WHERE post_id=? AND content_version=2').get(created.id);
const warningPreflight=preflightRevision(revision2.id);
assert.equal(warningPreflight.ok,true,JSON.stringify(warningPreflight.issues));
assert.ok(warningPreflight.issues.some((item)=>item.platform==='vk'&&item.severity==='warning'&&item.code==='RICH_BOLD_DOWNGRADED'));
assert.ok(warningPreflight.issues.some((item)=>item.platform==='instagram'&&item.severity==='warning'&&item.code==='RICH_UNDERLINE_DOWNGRADED'));
assert.ok(!warningPreflight.issues.some((item)=>item.severity==='error'));

const hardPost=await api('POST','/api/posts',{
  projectId,
  title:'EW4-004 hard error',
  bodyRich:richFixture,
  scheduleMode:'MANUAL'
},201);
const hardRevision=db.prepare('SELECT id FROM content_revisions WHERE post_id=? AND content_version=1').get(hardPost.id);
const hardPreflight=preflightRevision(hardRevision.id);
assert.equal(hardPreflight.ok,false);
assert.ok(hardPreflight.issues.some((item)=>item.severity==='error'&&item.code==='IMAGE_MEDIA_COUNT'));
await api('POST',`/api/posts/${hardPost.id}/ready`,{expectedContentVersion:1},409);

let postView=await api('GET',`/api/posts/${created.id}`);
const targetByPlatform=Object.fromEntries(postView.targets.map((target)=>[target.platform,target]));
assert.deepEqual(Object.keys(targetByPlatform).sort(),platforms.slice().sort());

let version=2;
const telegramTarget=targetByPlatform.telegram;
const nonText=saveTargetRendition(telegramTarget.id,{
  publicationKind:'FEED',
  contentFormat:'IMAGE',
  optionsJson:JSON.stringify({preserve:'telegram-options'})
},version);
version=nonText.contentVersion;

const telegramOverride={
  type:'doc',
  content:[{type:'paragraph',content:[
    {type:'text',text:'Telegram ',marks:[]},
    {type:'text',text:'override🙂',marks:[{type:'bold'},{type:'underline'}]},
    {type:'text',text:' ',marks:[]},
    {type:'link',attrs:{href:'https://example.test/tg'},content:[{type:'text',text:'TG link',marks:[]}]}
  ]}]
};
const tgSaved=await api('PATCH',`/api/posts/${created.id}/targets/${telegramTarget.id}/text`,{
  text:'plain must be ignored',
  textRich:telegramOverride,
  expectedContentVersion:version
});
version=tgSaved.contentVersion;
assert.equal(tgSaved.target.overrideText,null);
assert.deepEqual(tgSaved.target.textRich,telegramOverride);
const tgDb=db.prepare('SELECT pt.override_text,tr.text_rich_json,tr.text_plain,tr.options_json FROM post_targets pt JOIN target_renditions tr ON tr.target_id=pt.id WHERE pt.id=?').get(telegramTarget.id);
assert.equal(tgDb.override_text,null);
assert.equal(tgDb.text_rich_json,serializeRichText(telegramOverride));
assert.equal(tgDb.text_plain,richTextToPlain(telegramOverride));
assert.equal(tgDb.options_json,JSON.stringify({preserve:'telegram-options'}));

const vkTarget=targetByPlatform.vk;
const vkOverride={
  type:'doc',
  content:[{type:'paragraph',content:[{type:'text',text:'VK own **literal** override',marks:[]}]}]
};
const vkSaved=await api('PATCH',`/api/posts/${created.id}/targets/${vkTarget.id}/text`,{
  textRich:vkOverride,
  expectedContentVersion:version
});
version=vkSaved.contentVersion;
assert.equal(vkSaved.target.textPlain,'VK own **literal** override');

const maxTarget=targetByPlatform.max;
const maxNonText=saveTargetRendition(maxTarget.id,{optionsJson:JSON.stringify({keep:true})},version);
version=maxNonText.contentVersion;
const maxOverride={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'temporary max',marks:[{type:'italic'}]}]}]};
const maxSaved=await api('PATCH',`/api/posts/${created.id}/targets/${maxTarget.id}/text`,{
  textRich:maxOverride,
  expectedContentVersion:version
});
version=maxSaved.contentVersion;
const maxReset=await api('PATCH',`/api/posts/${created.id}/targets/${maxTarget.id}/text`,{
  textRich:null,
  expectedContentVersion:version
});
version=maxReset.contentVersion;
const maxDb=db.prepare('SELECT text_rich_json,text_plain,options_json FROM target_renditions WHERE target_id=?').get(maxTarget.id);
assert.deepEqual(maxDb,{text_rich_json:null,text_plain:null,options_json:JSON.stringify({keep:true})});

const currentRevision=db.prepare('SELECT id FROM content_revisions WHERE post_id=? AND content_version=?').get(created.id,version);
const currentPreflight=preflightRevision(currentRevision.id);
assert.equal(currentPreflight.ok,true,JSON.stringify(currentPreflight.issues));
assert.ok(currentPreflight.issues.some((item)=>item.platform==='instagram'&&item.severity==='warning'));
assert.ok(!currentPreflight.issues.some((item)=>item.severity==='error'));

const ready=await api('POST',`/api/posts/${created.id}/ready`,{expectedContentVersion:version});
assert.equal(ready.contentVersion,version);
const readyRevision=db.prepare('SELECT * FROM content_revisions WHERE id=?').get(ready.revisionId);
assert.equal(readyRevision.content_version,version);
const readyTargets=JSON.parse(readyRevision.targets_json);
const readyTelegram=readyTargets.find((target)=>target.accountId===accountIds.telegram);
const readyVk=readyTargets.find((target)=>target.accountId===accountIds.vk);
assert.equal(readyTelegram.rendition.textRichJson,serializeRichText(telegramOverride));
assert.equal(readyVk.rendition.textRichJson,serializeRichText(vkOverride));

db.prepare('UPDATE posts SET body=?,body_rich_json=? WHERE id=?')
  .run('MUTATED WORKING BODY',canonicalPlainRichJson('MUTATED WORKING BODY'),created.id);
db.prepare('UPDATE target_renditions SET text_rich_json=?,text_plain=? WHERE target_id=?')
  .run(canonicalPlainRichJson('MUTATED TELEGRAM TARGET'),'MUTATED TELEGRAM TARGET',telegramTarget.id);

await publishPost(created.id);
assert.deepEqual(Object.keys(captures).sort(),platforms.slice().sort());

const expectedTelegram=compilePlatformText('telegram',telegramOverride,'media_caption');
assert.deepEqual(captures.telegram.textCompilation,expectedTelegram);
assert.equal(captures.telegram.text,richTextToPlain(telegramOverride));
assert.ok(!JSON.stringify(captures.telegram).includes('MUTATED TELEGRAM TARGET'));

const expectedVk=compilePlatformText('vk',vkOverride,'media_caption');
assert.deepEqual(captures.vk.textCompilation,expectedVk);
assert.equal(captures.vk.text,'VK own **literal** override');

const expectedMax=compilePlatformText('max',richFixture,'media_caption');
const expectedInstagram=compilePlatformText('instagram',richFixture,'media_caption');
assert.deepEqual(captures.max.textCompilation,expectedMax);
assert.deepEqual(captures.instagram.textCompilation,expectedInstagram);
assert.ok(!JSON.stringify(captures.max).includes('MUTATED WORKING BODY'));
assert.ok(!JSON.stringify(captures.instagram).includes('MUTATED WORKING BODY'));

const finalState=db.prepare('SELECT status FROM posts WHERE id=?').get(created.id);
assert.equal(finalState.status,'PUBLISHED');

console.log(JSON.stringify({
  ok:true,
  checkpoint:'EW4-004',
  schemaVersion:Number(db.pragma('user_version',{simple:true})),
  telegramUtf16Entities:true,
  telegramStoryEntities:true,
  telegramOverlapDowngrade:true,
  maxHtmlEscaping:true,
  maxFormatHtml:true,
  vkPlainDowngrade:true,
  instagramPlainDowngrade:true,
  deterministicCompilation:true,
  stableDiagnostics:true,
  warningPreflightNonBlocking:true,
  hardErrorsRemainBlocking:true,
  targetRenditionRichOwnership:true,
  targetTextResetPreservesNonTextRendition:true,
  immutableReadyCompilerSource:true,
  compilerPublisherParity:true,
  schemaChange:false
},null,2));

for(const platform of platforms)setPublisherForTests(platform,null);
await app.close();
db.close();
await fs.rm(dataDir,{recursive:true,force:true});
