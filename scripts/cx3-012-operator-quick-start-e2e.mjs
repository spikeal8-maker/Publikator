import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const index = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const quick = await fs.readFile(new URL('../public/quick-start-v3.js', import.meta.url), 'utf8');
const router = await fs.readFile(new URL('../public/quick-start-router-v3.js', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../public/quick-start-v3.css', import.meta.url), 'utf8');

assert.match(index, />Старт<\/button>/);
assert.match(index, />Соцсети<\/button>/);
assert.match(index, />Импорт таблицы<\/button>/);
assert.match(index, /nav-section">Система/);
assert.match(index, /release-nav" class="nav nav-system">Проверка выпуска/);
assert.match(index, /quick-start-v3\.css/);
assert.match(index, /quick-start-router-v3\.js/);
assert.match(index, /quick-start-v3\.js/);

assert.match(router, /data-view="dashboard"/);
assert.match(router, /textContent = 'Старт'/);

assert.match(quick, /Подключить Telegram \/ VK \/ MAX/);
assert.match(quick, /Выбрать CSV\/XLSX/);
assert.match(quick, /Скачать пустой шаблон CSV/);
assert.match(quick, /\/api\/content-plan\/import\/preview/);
assert.match(quick, /\/api\/content-plan\/import\/apply/);
assert.match(quick, /x-publikator-content-plan/);
assert.match(quick, /x-content-plan-sha256/);
assert.match(quick, /Импортировать черновики/);
assert.match(quick, /Импорт ничего не публикует автоматически/);
assert.match(quick, /\.nav\[data-view="accounts"\]/);
assert.match(quick, /\.nav\[data-view="posts"\]/);
assert.match(quick, /#calendar-nav/);
assert.match(css, /\.quick-drop/);
assert.match(css, /\.nav-system/);

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-012',
  primaryOperatorStart: true,
  inlineSpreadsheetImport: true,
  socialSetupVisible: true,
  technicalNavigationDemoted: true
}));
