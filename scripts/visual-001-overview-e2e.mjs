import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { overviewChartRange, aggregateOverviewChart } from '../public/overview-chart.js';
const anchor=new Date(2026,10,1,12);
const range=overviewChartRange(anchor,14);
assert.equal(range.bins.length,14);
assert.equal(range.start.getDate(),26);
const fixture=[
 {scheduled_at_utc:new Date(2026,10,1,12).toISOString(),platforms:['telegram','telegram','max']},
 {scheduled_at_utc:new Date(2026,9,31,12).toISOString(),platforms:['vk']},
 {scheduled_at_utc:new Date(2026,10,2,12).toISOString(),platforms:[]},
 {scheduled_at_utc:new Date(2027,0,1).toISOString(),platforms:['telegram']}
];
const aggregated=aggregateOverviewChart(fixture,range,14);
assert.equal(aggregated.posts,3);
assert.deepEqual(aggregated.totals,{telegram:1,max:1,vk:1,unassigned:1});
assert.equal(aggregated.bins.reduce((n,b)=>n+b.total,0),4);
assert.equal(overviewChartRange(anchor,1).bins.length,24);
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-visual-001-'));
Object.assign(process.env,{NODE_ENV:'test',DATA_DIR:dataDir,ADMIN_PASSWORD:'visual-001-password',APP_MASTER_KEY:'visual-001-master-key-longer-than-thirty-two-characters',PUBLIC_BASE_URL:'http://127.0.0.1:18216'});
const {migrate,db}=await import('../dist/db.js');
const {encryptJson}=await import('../dist/crypto.js');
const {buildApp}=await import('../dist/app.js');
migrate(); const app=await buildApp(); let browser;
try {
 await app.listen({host:'127.0.0.1',port:18216});
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
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:18216/overview');
 await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
 await page.locator('#login-form button[type="submit"]').click();
 await page.locator('.overview-chart-plot[data-chart-length="14"]').waitFor();
 assert.equal(await page.locator('.overview-chart-bar').count(),14);
 assert.equal(await page.locator('.overview-chart-bar[data-total="2"]').count(),1);
 assert.equal(await page.locator('.overview-platform-row').count(),3);
 assert.equal(await page.locator('.dashboard-v3-metric').count(),4);
 assert.equal(await page.locator('.dashboard-v3-events').count(),0);
 await page.locator('.overview-help summary').first().click();
 assert.match(await page.locator('.overview-help[open]').innerText(),/точной датой/);
 await page.locator('.overview-help summary').first().click();
 await page.locator('.overview-chart-bar[data-total="2"]').click();
 assert.match(await page.locator('.overview-chart-detail').innerText(),/Telegram — 1/);
 assert.match(await page.locator('.overview-chart-detail').innerText(),/MAX — 1/);
 for(const [days,bins]of [[1,24],[7,7],[30,30],[14,14]]){
  await page.locator('[data-chart-days="'+days+'"]').click();
  await page.locator('.overview-chart-plot[data-chart-length="'+bins+'"]').waitFor();
  assert.equal(await page.locator('.overview-chart-bar').count(),bins);
 }
 await page.locator('[data-dashboard-section="today"]').click();
 await page.waitForURL('**/calendar');
 await page.locator('.nav[data-view="dashboard"]').click();
 await page.locator('.overview-chart-plot').waitFor();
 await page.locator('.overview-create').click();
 await page.locator('#qc-text').waitFor();
 await page.locator('#qc-close').click();
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('.overview-heading').count(),0,'No separate page introduction');
 assert.equal(await page.locator('.ui-header-kicker').isVisible(),false);
 assert.equal(await page.locator('.ui-page-subtitle').isVisible(),false);
 assert.equal(await page.locator('.ui-overview-date').isVisible(),true);
 const header=await page.locator('main > header').boundingBox();
 assert.ok(header.height<=48,'Only a thin title/date row is allowed');
 const plot=await page.locator('.overview-chart-plot').boundingBox();
 assert.ok(plot.y<=170,'Actual chart must be visible at the top of a phone: '+JSON.stringify({plot,header}));
 assert.ok(plot.height>=140,'Chart must be readable');
 await page.locator('.overview-chart .overview-help summary').click();
 const mobileHelp=await page.locator('.overview-chart .overview-help[open] > div').boundingBox();
 assert.ok(mobileHelp.x>=0&&mobileHelp.x+mobileHelp.width<=390,'Detailed help must fit the phone');
 await page.locator('.overview-chart .overview-help summary').click();
 await page.locator('[data-dashboard-section="review"]').click();
 assert.equal(await page.locator('#overview-review').getAttribute('tabindex'),'-1');
 await page.locator('.ui-mobile-menu').click();
 await page.locator('#calendar-nav').click();
 await page.waitForURL('**/calendar');
 await page.locator('.ui-overview-date').waitFor({state:'hidden'});
 assert.equal(await page.locator('.ui-overview-date').isVisible(),false,'Overview date must not leak into other pages');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checkpoint:'VISUAL-001',ok:true,aggregationAndDedup:true,realCalendarData:true,periodSwitches:true,chartDetails:true,thinMobileHeader:true,chartFirstScreen:true,mobileNoOverflow:true}));
}finally{await browser?.close();await app.close();db.close();await fs.rm(dataDir,{recursive:true,force:true});}
