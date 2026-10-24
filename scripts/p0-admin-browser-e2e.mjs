import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-onboarding-browser-'));
process.env.DATA_DIR=dir;
process.env.NODE_ENV='test';
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='p0-browser-master-key-with-at-least-32-characters';
process.env.PUBLIC_BASE_URL='http://127.0.0.1:18898';
const {db,migrate}=await import('../dist/db.js');
const {createAdminSetupGrant}=await import('../dist/admin-auth.js');
const {buildApp}=await import('../dist/app.js');
migrate();
const grant=createAdminSetupGrant('INITIAL');
const app=await buildApp();
await app.listen({port:18898,host:'127.0.0.1'});
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const desktop=await browser.newContext({viewport:{width:1440,height:900}});
 const page=await desktop.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:18898/#admin-setup='+grant);
 await page.locator('#setup-form:not(.hidden)').waitFor();
 assert.equal(await page.locator('#login .auth-mark').count(),1,'one onboarding logo element');
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#login'),'::before').display),'none',
   'legacy center-card pseudo-logo must not duplicate the product logo');
 assert.match(await page.locator('#auth-heading').textContent(),/Добро пожаловать/);
 assert.equal(new URL(page.url()).hash,'','setup grant must not persist in browser address bar');
 await fs.mkdir('test-results',{recursive:true});
 await page.screenshot({path:'test-results/p0-auth-first-run-desktop.png',fullPage:true});
 await page.locator('#setup-username').fill('school_owner');
 await page.locator('#setup-password').fill('long-password-browser-2026');
 await page.locator('#setup-confirm').fill('long-password-browser-2026');
 await page.locator('#setup-form button[type="submit"]').click();
 await page.locator('#app:not(.hidden)').waitFor();
 assert.equal((await page.locator('#page-title').textContent())?.length>0,true);
 assert.equal(await page.locator('#login').isVisible(),false);
 await page.screenshot({path:'test-results/p0-auth-dashboard-desktop.png',fullPage:true});

 // Reproduce session expiry after reloading an already authenticated dashboard.
 const dashboardLoaded = page.waitForResponse(response =>
   new URL(response.url()).pathname === '/api/editorial-dashboard' && response.status() === 200);
 await page.reload();
 await dashboardLoaded;
 await page.locator('#app:not(.hidden)').waitFor();
 db.prepare('DELETE FROM admin_sessions').run();
 await page.locator('button[data-view="projects"]').click();
 await page.locator('#login-form:not(.hidden)').waitFor();
 assert.equal(await page.locator('#username').isVisible(),true);
 assert.equal(await page.locator('#setup-form').isVisible(),false,'spent setup must not reappear');
 await page.locator('#username').fill('school_owner');
 await page.locator('#password').fill('long-password-browser-2026');
 await page.locator('#login-form button[type="submit"]').click();
 await page.locator('#app:not(.hidden)').waitFor();

 await page.locator('#account-nav').click();
 await page.locator('#account-auth-form').waitFor();
 await page.locator('#account-auth-form input[name="currentPassword"]').fill('long-password-browser-2026');
 await page.locator('#account-auth-form input[name="password"]').fill('long-password-browser-updated-2026');
 await page.locator('#account-auth-form input[name="confirmPassword"]').fill('long-password-browser-updated-2026');
 await page.locator('#account-auth-form button[type="submit"]').click();
 await page.locator('.auth-success').waitFor();
 await page.locator('#logout').click();
 await page.locator('#login-form:not(.hidden)').waitFor();
 assert.match(await page.locator('#auth-heading').textContent(),/Вход/);
 await page.locator('#username').fill('school_owner');
 await page.locator('#password').fill('wrong-password');
 await page.locator('#login-form button[type="submit"]').click();
 await page.locator('#login-error').filter({hasText:'Неверный'}).waitFor();
 await page.locator('#password').fill('long-password-browser-updated-2026');
 await page.locator('#login-form button[type="submit"]').click();
 await page.locator('#app:not(.hidden)').waitFor();
 await page.locator('#logout').click();
 await page.locator('#login-form:not(.hidden)').waitFor();
 await page.screenshot({path:'test-results/p0-auth-login-desktop.png',fullPage:true});

 const mobile=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
 const m=await mobile.newPage();
 m.on('pageerror',e=>errors.push(String(e)));
 await m.goto('http://127.0.0.1:18898/');
 await m.locator('#login-form:not(.hidden)').waitFor();
 assert.equal(await m.locator('#login .auth-mark').count(),1);
 assert.equal(await m.evaluate(()=>getComputedStyle(document.querySelector('#login'),'::before').display),'none');
 assert.equal(await m.locator('#username').isVisible(),true);
 assert.equal(await m.locator('#password').isVisible(),true);
 assert.equal(await m.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true,'no mobile horizontal overflow');
 await m.screenshot({path:'test-results/p0-auth-login-mobile.png',fullPage:true});
 await m.locator('#username').fill('school_owner');
 await m.locator('#password').fill('long-password-browser-updated-2026');
 await m.locator('#login-form button[type="submit"]').click();
 await m.locator('#app:not(.hidden)').waitFor();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,chromeDesktop:true,chromeMobile:true,firstRun:true,passwordChange:true,invalidPassword:true,expiredSessionLoginRestored:true,logout:true,login:true,screenshots:'test-results/p0-auth-*'}));
 await mobile.close();
 await desktop.close();
} finally {
 if(browser)await browser.close();
 await app.close();
 db.close();
 await fs.rm(dir,{recursive:true,force:true});
}
