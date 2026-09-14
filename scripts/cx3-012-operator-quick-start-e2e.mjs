import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const pages = fs.readFileSync('public/operator-pages-v4.js', 'utf8');

assert.match(html, /operator-pages-v4\.css/);
assert.match(html, /operator-pages-v4\.js/);
assert.doesNotMatch(html, /quick-start-v3/);
assert.doesNotMatch(html, /quick-start-router-v3/);
assert.match(html, /data-route="\/socials"/);
assert.match(html, /data-route="\/sources"/);
assert.match(html, /id="content-library-nav"[^>]*data-route="\/library"/);

assert.ok(pages.includes('/api/accounts/test'));
assert.ok(pages.includes('/api/content-plan/v3/template.xlsx'));
assert.ok(pages.includes('/api/content-plan/v3/import/preview?sourceId='));
assert.ok(pages.includes('/api/content-plan/v3/import/apply?sourceId='));
assert.ok(pages.includes("['/library', '#content-library-nav']"));

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-012',
  supersededByOperatorPages: true,
  socialSetupVisible: true,
  spreadsheetImportVisible: true
}));
