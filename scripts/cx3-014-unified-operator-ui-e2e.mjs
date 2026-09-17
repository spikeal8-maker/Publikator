import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [index, app, css, ui, polishCss, polish, operator, calendar, library, dashboard] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
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

assert.ok(!app.includes("await loadProjects(); await render('dashboard');"), 'bootstrap/login must not overwrite the routed page with dashboard');
assert.ok(operator.includes('operatorRouteWhenVisible'), 'operator router must own initial route rendering');

for (const token of ['--bg:', '--surface:', '--text-primary:', '--text-secondary:', '--border:', '--accent:', '--success:', '--warning:', '--danger:']) {
  assert.ok(css.includes(token), `missing semantic token ${token}`);
}
for (const contract of ['.ui-mobile-menu', '@media (max-width: 820px)', '.table-scroll', '.modal-card.post-editor-modal', '.ui-filterbar', ':focus-visible']) {
  assert.ok(css.includes(contract), `missing UI contract ${contract}`);
}
assert.ok(polishCss.includes('.ui-editor-section-title'), 'structured editor styling missing');
assert.ok(polishCss.includes('.ui-internal-status'), 'semantic status carrier styling missing');
assert.ok(polishCss.includes('.brand::after'), 'legacy compact-brand pseudo element must be suppressed');
assert.ok(polishCss.includes('grid-template-columns: repeat(7, minmax(0, 1fr))'), 'mobile calendar must fit seven columns');
assert.ok(polishCss.includes('overscroll-behavior-inline: contain'), 'mobile library tabs must scroll internally');
assert.ok(polishCss.includes('html[data-page="content"] .table tbody tr'), 'mobile content cards contract missing');

for (const route of routes) assert.ok(ui.includes(`'${route}'`), `route metadata missing ${route}`);
for (const behavior of ['uiContentFilters', 'uiProjectsPage', 'uiSchedulePage', 'uiJournalFilters', 'uiWrapTables', 'uiDecorateSocialCards', 'ui-nav-open']) {
  assert.ok(ui.includes(behavior), `shared enhancement missing ${behavior}`);
}
for (const behavior of ['uiSetText', 'uiSetLabelText', 'uiPolishStatuses', 'uiPolishCalendar', 'uiPolishLibrary', 'uiPolishTemplates', 'uiPolishPostEditor', 'uiPolishOverview', 'uiPolishSocials', 'uiPolishScheduleModal', 'uiPolishLibraryRoles']) {
  assert.ok(polish.includes(behavior), `page polish missing ${behavior}`);
}
assert.ok(polish.includes('node.textContent !== value'), 'DOM copy updates must be idempotent under MutationObserver');
assert.ok(polish.includes("preserveContentStatus = window.location.pathname === '/content'"), 'content filter must retain raw semantic status');
assert.ok(polish.includes("badge.classList.add('ui-internal-status')"), 'content rows must retain a hidden semantic badge');
assert.ok(polish.includes('ui-human-status'), 'content rows must expose a human status badge');
assert.ok(polish.includes('После сохранения'), 'new-post lifecycle explanation missing');
assert.ok(polish.includes('Дата и время публикации'), 'technical AT label must not be exposed');
assert.ok(polish.includes("modeSelect.value !== 'AT'"), 'scheduled datetime must hide outside timed mode');
assert.ok(ui.includes('Автоматические публикации'), 'schedule page must use operator language');
assert.ok(ui.includes('+ Добавить время'), 'schedule action must use operator language');

assert.ok(operator.includes("'/api/accounts/test'"), 'social connection verification must remain real API-backed');
assert.ok(operator.includes('/api/content-plan/v3/import/preview?sourceId='), 'source preview must remain schema-v3 backed');
assert.ok(operator.includes('/api/content-plan/v3/import/apply?sourceId='), 'source apply must remain schema-v3 backed');
assert.ok(!polish.includes('uiPolishSources'), 'Sources copy must no longer be owned by MutationObserver polish');
assert.ok(!polish.includes('uiRefineSources'), 'Sources cards must no longer be rewritten by page polish');
assert.ok(!operator.includes('Connector в текущем backend ещё не реализован'), 'Sources renderer must not claim Google Sheets is unavailable');
assert.ok(!operator.includes('Cloud media connectors пока не включены'), 'Sources renderer must not claim cloud media is unavailable');
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
  semanticStatusFiltering: true,
  idempotentDomPolish: true,
  legacyPageEnhancements: ['content-filter', 'projects-summary', 'schedule-weekdays', 'journal-filter'],
  existingProductWorkflowsPreserved: true
}));

const browserAcceptance = spawnSync(process.execPath, [fileURLToPath(new URL('./browser-operator-acceptance-e2e.mjs', import.meta.url))], {
  stdio: 'inherit'
});
assert.equal(browserAcceptance.status, 0, 'real browser operator acceptance failed');
