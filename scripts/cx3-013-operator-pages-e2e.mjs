import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/operator-pages-v4.js', 'utf8');
const css = fs.readFileSync('public/operator-pages-v4.css', 'utf8');

const requiredNavigation = [
  ['Обзор', '/overview'],
  ['Календарь', '/calendar'],
  ['Контент', '/content'],
  ['Шаблоны', '/templates'],
  ['Проекты', '/projects'],
  ['Соцсети', '/socials'],
  ['Источники / Интеграции', '/sources'],
  ['Расписание', '/schedule'],
  ['Журнал', '/journal'],
  ['Резервные копии', '/backups'],
  ['Диагностика', '/diagnostics']
];

let lastIndex = -1;
for (const [label, route] of requiredNavigation) {
  const fragment = `data-route="${route}">${label}</button>`;
  const index = html.indexOf(fragment);
  assert.ok(index > lastIndex, `navigation missing/out of order: ${label}`);
  lastIndex = index;
}

assert.match(html, /operator-pages-v4\.css/);
assert.match(html, /operator-pages-v4\.js/);
assert.doesNotMatch(html, /quick-start-v3/);
assert.doesNotMatch(html, /quick-start-router-v3/);
assert.doesNotMatch(html, />Старт<\/button>/);
assert.doesNotMatch(html, />Release gate<\/button>/);
assert.match(html, /id="content-library-nav"[^>]*data-route="\/library"/);
assert.ok(js.includes("['/library', '#content-library-nav']"), 'library route is missing');

for (const endpoint of [
  '/api/accounts/test',
  '/api/accounts/${encodeURIComponent(row.dataset.accountId)}/test',
  '/api/content-plan/v3/schema',
  '/api/content-plan/v3/template.xlsx',
  '/api/content-plan/v3/import/preview?sourceId=',
  '/api/content-plan/v3/import/apply?sourceId='
]) assert.ok(js.includes(endpoint), `operator page is not wired to ${endpoint}`);

for (const text of [
  'Куда публиковать',
  'Проверить подключение',
  'Подключённые площадки',
  'Название набора',
  'Проверить таблицу',
  'Импортировать',
  'Скачать шаблон XLSX',
  'Источники / Интеграции'
]) assert.ok(js.includes(text), `required operator text missing: ${text}`);

assert.ok(js.includes("history.pushState({}, '', path)"), 'route navigation must have real browser paths');
assert.ok(js.includes("window.addEventListener('popstate'"), 'browser back/forward routing missing');
assert.ok(js.includes("type=\"password\""), 'credential fields must not be plain text inputs');
assert.ok(js.includes("verifiedFingerprint"), 'save must depend on the last verified credential payload');
assert.ok(js.includes("Preview ничего не публикует наружу"), 'source preview safety message missing');
assert.ok(js.includes("автоматической публикации наружу не будет"), 'source apply safety message missing');
assert.ok(css.includes('.operator-platform-grid'));
assert.ok(css.includes('.operator-source-layout'));
assert.ok(css.includes('.nav[data-route].active'));

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-013',
  routedPages: requiredNavigation.length,
  socialConnectionVerification: true,
  contentPlanV3SourceWorkflow: true,
  quickStartRemoved: true
}));
