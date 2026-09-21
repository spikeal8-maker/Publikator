import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-rich-export-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='rich-export-password';
process.env.APP_MASTER_KEY='rich-export-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,id,migrate,nowIso}=await import('../dist/db.js');
const {createDraftPost}=await import('../dist/post-creation.js');
const {commitContentEdit}=await import('../dist/content-versioning.js');
const {
  normalizeRichText,parsePortableRichText,parseRichTextJson,richTextToPlain,richTextToPortable,serializeRichText
}=await import('../dist/rich-text.js');
const {exportContentPlanV3,parseContentPlanV3,validateContentPlanV3}=await import('../dist/content-plan-v3.js');

migrate();
const project=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
db.prepare('UPDATE projects SET slug=? WHERE id=?').run('main',project.id);
const now=nowIso();
const accountId=id('acc');
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run(accountId,'telegram','Rich Telegram','encrypted',now,now);

const rich=normalizeRichText({
  type:'doc',
  content:[
    {type:'paragraph',content:[
      {type:'text',text:'Bold',marks:[{type:'bold'}]},
      {type:'text',text:' + ',marks:[]},
      {type:'text',text:'italic',marks:[{type:'italic'}]},
      {type:'text',text:' + ',marks:[]},
      {type:'text',text:'underline',marks:[{type:'underline'}]},
      {type:'text',text:' + ',marks:[]},
      {type:'text',text:'strike',marks:[{type:'strike'}]},
      {type:'hard_break'},
      {type:'link',attrs:{href:'https://example.org/a_(b)'},content:[{type:'text',text:'link',marks:[{type:'bold'}]}]},
      {type:'text',text:' ',marks:[]},
      {type:'text',text:'inline code',marks:[{type:'code'}]}
    ]},
    {type:'blockquote',content:[
      {type:'paragraph',content:[{type:'text',text:'Quoted text',marks:[{type:'italic'}]}]}
    ]},
    {type:'bullet_list',content:[
      {type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'Bullet one',marks:[{type:'bold'}]}]}]},
      {type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'Bullet two',marks:[]}]}]}
    ]},
    {type:'ordered_list',content:[
      {type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'First',marks:[]}]}]},
      {type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'Second',marks:[{type:'underline'}]}]}]}
    ]},
    {type:'code_block',content:[
      {type:'text',text:'const x = `ok`;',marks:[]},
      {type:'hard_break'},
      {type:'text',text:'return x;',marks:[]}
    ]}
  ]
});
const portable=richTextToPortable(rich);
assert.deepEqual(parsePortableRichText(portable),rich,'portable serializer/parser must round-trip canonical editor AST');

const override=normalizeRichText({
  type:'doc',
  content:[
    {type:'paragraph',content:[
      {type:'text',text:'Telegram ',marks:[]},
      {type:'text',text:'override',marks:[{type:'bold'},{type:'underline'}]}
    ]},
    {type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'TG quote',marks:[]}]}]}
  ]
});
assert.deepEqual(parsePortableRichText(richTextToPortable(override)),override);

const post=createDraftPost({
  projectId:project.id,
  title:'Rich export post',
  body:richTextToPlain(rich),
  bodyRichJson:serializeRichText(rich),
  scheduleMode:'MANUAL',
  tags:['rich','roundtrip'],
  sourceNote:'Rich source note',
  targetAccountIds:[accountId]
});
const target=db.prepare('SELECT id FROM post_targets WHERE post_id=? AND account_id=?').get(post.id,accountId);
commitContentEdit(post.id,1,'manual',()=>{
  db.prepare(`INSERT INTO target_renditions
    (target_id,text_rich_json,text_plain,publication_kind,content_format,media_plan_json,options_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      target.id,serializeRichText(override),richTextToPlain(override),null,null,null,null,nowIso()
    );
});
const version=db.prepare('SELECT content_version FROM posts WHERE id=?').get(post.id).content_version;
db.prepare(`UPDATE posts SET source_type='content-plan-v3',source_ref=?,source_revision=?,imported_content_version=? WHERE id=?`)
  .run(JSON.stringify(['rich-export','rich-001']),'rev-1',version,post.id);

const exported=await exportContentPlanV3('rich-export');
assert.ok(exported.length>0);
const parsed=await parseContentPlanV3('rich-export.xlsx',exported);
const validation=await validateContentPlanV3(parsed,'rich-export');
assert.equal(validation.rows.length,1);
assert.equal(validation.rows[0].errors.length,0,JSON.stringify(validation.rows[0].errors));
assert.ok(validation.rows[0].normalized);
const normalized=validation.rows[0].normalized;
assert.deepEqual(parseRichTextJson(normalized.bodyRichJson),rich);
assert.deepEqual(normalized.tags,['rich','roundtrip']);
assert.equal(normalized.sourceNote,'Rich source note');
assert.equal(normalized.overrides.length,1);
assert.equal(normalized.overrides[0].platform,'telegram');
assert.deepEqual(parseRichTextJson(normalized.overrides[0].richJson),override);
assert.equal(validation.summary.unchangedRows,1,'exact exported semantics should validate as unchanged');

console.log(JSON.stringify({
  ok:true,
  checkpoint:'Content Plan v3 rich export round-trip',
  canonicalPortableRoundTrip:true,
  underline:true,
  lists:true,
  codeBlock:true,
  blockquote:true,
  links:true,
  platformOverride:true,
  tagsAndSourceNote:true,
  semanticUnchanged:true
},null,2));

db.close();
await fs.rm(dataDir,{recursive:true,force:true});
