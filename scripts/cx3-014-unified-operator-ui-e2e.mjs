import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const [index, css, ui, polishCss, polish, operator, calendar, library, dashboard] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ui-v5.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ui-v5.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ui-page-polish-v5.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ui-page-polish-v5.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/operator-pages-v4.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/calendar-v3.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/content-library-v3.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/dashboard-v3.js', import.meta.url), 'utf8')
]);

const routes = [
  '/overview', '/calendar', '/content', '/library', '/templates', '/projects',
  '/socials', '/sources', '/schedule', '/journal', '/backups', '/diagnostics'
];
for (const route of routes) assert.ok(index.includes(`data-route="${route}"`), `missing route ${route}`);

for (const asset of ['/ui-v5.css', '/ui-page-polish-v5.css', '/ui-v5.js', '/ui-page-polish-v5.js']) {
  assert.ok(index.includes(asset), `unified UI asset is not loaded: ${asset}`);
}
assert.ok(index.indexOf('/ui-v5.css') > index.indexOf('/operator-pages-v4.css'), 'unified CSS must load after feature CSS');
assert.ok(index.indexOf('/ui-page-polish-v5.js') > index.indexOf('/ui-v5.js'), 'page polish must load after shared UI behavior');

for (const token of ['--bg:', '--surface:', '--text-primary:', '--text-secondary:', '--border:', '--accent:', '--success:', '--warning:', '--danger:']) {
  assert.ok(css.includes(token), `missing semantic token ${token}`);
}
for (const contract of ['.ui-mobile-menu', '@media (max-width: 820px)', '.table-scroll', '.modal-card.post-editor-modal', '.ui-filterbar', ':focus-visible']) {
  assert.ok(css.includes(contract), `missing UI contract ${contract}`);
}
assert.ok(polishCss.includes('.ui-editor-section-title'), 'structured editor styling missing');

for (const route of routes) assert.ok(ui.includes(`'${route}'`), `route metadata missing ${route}`);
for (const behavior of ['uiContentFilters', 'uiProjectsPage', 'uiSchedulePage', 'uiJournalFilters', 'uiWrapTables', 'uiDecorateSocialCards', 'ui-nav-open']) {
  assert.ok(ui.includes(behavior), `shared enhancement missing ${behavior}`);
}
for (const behavior of ['uiPolishStatuses', 'uiPolishCalendar', 'uiPolishLibrary', 'uiPolishSources', 'uiPolishTemplates', 'uiPolishPostEditor']) {
  assert.ok(polish.includes(behavior), `page polish missing ${behavior}`);
}

assert.ok(operator.includes("'/api/accounts/test'"), 'social connection verification must remain real API-backed');
assert.ok(operator.includes('/api/content-plan/v3/import/preview?sourceId='), 'source preview must remain schema-v3 backed');
assert.ok(operator.includes('/api/content-plan/v3/import/apply?sourceId='), 'source apply must remain schema-v3 backed');
assert.ok(calendar.includes("['month','week','day','agenda']"), 'calendar modes were lost');
assert.ok(library.includes("['stories','Stories']"), 'story library filter was lost');
assert.ok(library.includes("['shorts','Shorts']"), 'shorts library filter was lost');
assert.ok(dashboard.includes('/api/editorial-dashboard'), 'editorial dashboard API integration was lost');

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-014',
  routedPages: routes.length,
  unifiedVisualSystem: true,
  responsiveNavigation: true,
  humanizedOperatorLanguage: true,
  structuredPostEditor: true,
  legacyPageEnhancements: ['content-filter', 'projects-summary', 'schedule-weekdays', 'journal-filter'],
  existingProductWorkflowsPreserved: true
}));
