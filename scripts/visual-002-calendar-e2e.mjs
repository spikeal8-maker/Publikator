import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-visual-002-'));
Object.assign(process.env,{NODE_ENV:'test',DATA_DIR:dataDir,ADMIN_PASSWORD:'visual-002-password',APP_MASTER_KEY:'visual-002-master-key-longer-than-thirty-two-characters',PUBLIC_BASE_URL:'http://127.0.0.1:18217'});
const {migrate,db}=await import('../dist/db.js');
const {encryptJson}=await import('../dist/crypto.js');
const {buildApp}=await import('../dist/app.js');
migrate(); const app=await buildApp(); let browser;
try {
 await app.listen({host:'127.0.0.1',port:18217});
 const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});
 const headers={cookie:String(login.headers['set-cookie']).split(';')[0]};
 const projectId=db.prepare('SELECT id FROM projects LIMIT 1').get().id;
 const now=new Date().toISOString();
 for(const platform of ['telegram','max','vk'])db.prepare('INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)')
  .run('chart_'+platform,platform,'Chart '+platform,encryptJson({accessToken:'fixture-no-provider-write'}),now,now);
 for(const [offset,platforms]of [[-1,['vk']],[0,['telegram','max']],[1,['telegram']]]){
  const date=new Date();date.setDate(date.getDate()+offset);date.setHours(12,0,0,0);
  const created=await app.inject({method:'POST',url:'/api/posts',headers,payload:{projectId,title:'Chart '+offset,body:'Chart fixture',scheduleMode:'AT',scheduledAt:date.toISOString(),contentFormat:'TEXT_ONLY'}});
  assert.equal(created.statusCode,201,created.body);
  const post=created.json();
  const version=db.prepare('SELECT content_version FROM posts WHERE id=?').get(post.id).content_version;
  const selected=await app.inject({method:'PUT',url:'/api/posts/'+post.id+'/targets',headers,payload:{accountIds:platforms.map(p=>'chart_'+p),expectedContentVersion:version}});
  assert.equal(selected.statusCode,200,selected.body);
 }

 const queued=await app.inject({method:'POST',url:'/api/posts',headers,payload:{projectId,title:'Queued calendar fixture',body:'Queue fixture',scheduleMode:'QUEUE'}});
 assert.equal(queued.statusCode,201,queued.body);
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:18217/calendar');
 await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
 await page.locator('#login-form button[type="submit"]').click();
 await page.locator('.calendar-day-cell').first().waitFor();
 assert.equal(await page.locator('.calendar-day-cell').count(),42);
 assert.equal(await page.locator('.calendar-weekday').count(),7);
 const today=new Date();const key=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
 await page.locator('[data-calendar-select="'+key+'"]').first().click();
 assert.match(await page.locator('.calendar-selected-items').innerText(),/Chart 0/);
 await page.locator('.calendar-selected-items .calendar-quick-edit').click();
 await page.locator('#calendar-quick-form').waitFor();
 await page.locator('#calendar-quick-cancel').click();
 await page.locator('.calendar-selected-items [data-calendar-selected-post]').click();
 await page.locator('.editorial-inspector-overlay').waitFor();
 await page.locator('.inspector-close').click();
 assert.equal(await page.locator('.calendar-queue-lane').getAttribute('open'),null);
 await page.locator('.calendar-queue-lane > summary').click();
 assert.match(await page.locator('.calendar-queue-items').innerText(),/Из очереди/);
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Month must fit phone '+width);
  const grid=await page.locator('.calendar-grid').boundingBox();
  assert.ok(grid.x>=0&&grid.x+grid.width<=width,'Seven columns must fit');
  const header=await page.locator('main > header').boundingBox();
  assert.ok(header.height<=48,'Thin calendar heading');
  assert.equal(await page.locator('.ui-header-kicker').isVisible(),false);
  assert.equal(await page.locator('.ui-page-subtitle').isVisible(),false);
  await page.locator('.calendar-help summary').click();
  const help=await page.locator('.calendar-help[open] > div').boundingBox();
  assert.ok(help.x>=0&&help.x+help.width<=width,'Help must fit');
  assert.match(await page.locator('.calendar-help[open]').innerText(),/Часовой пояс:/);
  await page.locator('.calendar-help summary').click();
 }
 for(const [mode,slots]of [['week',168],['day',24]]){
  await page.locator('[data-calendar-mode="'+mode+'"]').click();
  await page.locator('.calendar-time-slot').first().waitFor();
  assert.equal(await page.locator('.calendar-time-slot').count(),slots);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Time grid must scroll internally');
 }
 await page.locator('[data-calendar-mode="agenda"]').click();
 await page.locator('.calendar-list').waitFor();
 assert.match(await page.locator('.calendar-list').innerText(),/Chart 0/);
 await page.locator('[data-calendar-mode="month"]').click();
 await page.locator('.calendar-grid').waitFor();
 const prior=await page.locator('.calendar-range-title').innerText();
 await page.locator('#calendar-next').click();
 await page.waitForFunction(prior=>document.querySelector('.calendar-range-title').textContent!==prior,prior);
 await page.locator('#calendar-today').click();
 await page.locator('.calendar-grid').waitFor();
 await fs.mkdir('test-results',{recursive:true});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'test-results/visual-002-calendar-mobile.png'});
 await page.setViewportSize({width:1440,height:1000});
 await page.screenshot({path:'test-results/visual-002-calendar-desktop.png'});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checkpoint:'VISUAL-002',ok:true,phoneSevenColumns:true,selectionAndInspector:true,quickEdit:true,queue:true,allViews:true,help:true}));
}finally{await browser?.close();await app.close();db.close();await fs.rm(dataDir,{recursive:true,force:true});}
