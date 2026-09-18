import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [index, app, css, ui, polishCss, polish, operator, googleSheets, calendar, library, dashboard, presentation] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ui-v5.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ui-v5.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ui-page-polish-v5.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ui-page-polish-v5.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/operator-pages-v4.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/google-sheets-v1.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/calendar-v3.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/content-library-v3.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/dashboard-v3.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/presentation-labels.js', import.meta.url), 'utf8')
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
for (const behavior of ['uiSetText', 'uiSetLabelText', 'uiPolishStatuses', 'uiPolishCalendar', 'uiPolishPostEditor']) {
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

const templatesDescription = 'Здесь будут храниться повторно используемые заготовки текста, структуры и настроек публикации.';
const templatesEmptyState = 'Шаблоны пока не включены. До их появления создавайте и дублируйте материалы через раздел «Контент».';
assert.ok(operator.includes(templatesDescription), 'final templates description must be owned by operator-pages-v4.js');
assert.ok(operator.includes(templatesEmptyState), 'final templates empty state must be owned by operator-pages-v4.js');
assert.ok(!polish.includes('uiPolishTemplates'), 'templates copy must no longer be owned by ui-page-polish-v5.js');
assert.ok(operator.includes("['/templates', renderTemplatesPage]"), '/templates must remain registered to renderTemplatesPage');

const socialsDescription = 'Подключите площадку, проверьте токен и укажите конкретный канал, группу или чат. Сохранить можно только проверенное подключение.';
const instagramNote = "instagram: { label: 'Instagram', note: 'Публикация в профессиональный аккаунт Instagram.' }";
assert.ok(operator.includes(socialsDescription), 'final socials description must be owned by operator-pages-v4.js');
assert.ok(operator.includes(instagramNote), 'final Instagram note must be owned by OPERATOR_PLATFORM');
assert.ok(operator.includes('class="operator-platform-card" data-platform="${key}"'), 'socials renderer must assign data-platform directly to each platform card');
assert.ok(!polish.includes('uiPolishSocials'), 'socials copy must no longer be owned by ui-page-polish-v5.js');
assert.ok(!polish.includes('uiPolishPlatformCards'), 'platform card identity must no longer be owned by ui-page-polish-v5.js');
assert.ok(operator.includes("['/socials', renderSocialsPage]"), '/socials must remain registered to renderSocialsPage');

const slotEditorStart = app.indexOf('function slotEditor()');
const slotEditorEnd = app.indexOf('async function events()', slotEditorStart);
assert.ok(slotEditorStart >= 0 && slotEditorEnd > slotEditorStart, 'slotEditor source boundary missing');
const slotEditorSource = app.slice(slotEditorStart, slotEditorEnd);
assert.ok(slotEditorSource.includes('<h2>Новое время публикации</h2>'), 'final schedule modal title must be owned by slotEditor');
assert.ok(slotEditorSource.includes('<label>Часовой пояс<input name="timezone" value="Europe/Moscow">'), 'final timezone label must be owned by slotEditor');
assert.ok(slotEditorSource.includes('<button class="primary">Добавить</button>'), 'final schedule modal primary action must be owned by slotEditor');
assert.ok(!polish.includes('uiPolishScheduleModal'), 'schedule modal copy must no longer be owned by ui-page-polish-v5.js');
assert.ok(slotEditorSource.includes('id="slot-form"'), '#slot-form must remain in slotEditor');
assert.ok(slotEditorSource.includes("api('/api/schedules',{method:'POST'"), 'schedule POST must remain in slotEditor');

const overviewProblemsNote = 'ошибки и публикации, требующие проверки';
assert.ok(dashboard.includes(`dashboardMetric('Проблемы', data.metrics.problems, '${overviewProblemsNote}'`), 'final Problems metric note must be owned by dashboard-v3.js');
assert.ok(dashboard.includes("import { publicationFormatLabel, statusLabel } from './presentation-labels.js';"), 'Dashboard must reuse shared presentation labels');
assert.ok(dashboard.includes('publicationFormatLabel(item.publication_kind, item.content_format)'), 'Dashboard item must use shared publication format formatter');
assert.ok(!dashboard.includes('DASHBOARD_FORMAT_LABEL'), 'Dashboard must not duplicate shared publication format mapping');
assert.ok(!dashboard.includes('function dashboardFormat('), 'Dashboard must not keep a parallel format helper');
assert.ok(!dashboard.includes('const STATUS_META'), 'Dashboard must not duplicate shared status labels');
assert.ok(dashboard.includes('dashboardEscape(statusLabel(key))'), 'Dashboard status copy must use shared status helper');
assert.ok(!polish.includes('uiPolishOverview'), 'overview copy and format must no longer be owned by ui-page-polish-v5.js');
assert.ok(index.includes('data-route="/overview"') && ui.includes("'/overview'"), '/overview must remain a registered route');

const libraryViewLabels = {
  all: 'Все',
  inbox: 'Входящие',
  draft: 'Черновики',
  ready: 'Готово',
  scheduled: 'Запланировано',
  published: 'Опубликовано',
  problems: 'Проблемы'
};
for (const [key, label] of Object.entries(libraryViewLabels)) {
  assert.ok(library.includes(`['${key}','${label}']`), `LIBRARY_VIEWS must own final label ${key} -> ${label}`);
}
const libraryFormatLabels = {
  all: 'Все форматы',
  image: 'Изображения',
  stories: 'Истории',
  shorts: 'Короткие видео',
  video: 'Видео'
};
for (const [key, label] of Object.entries(libraryFormatLabels)) {
  assert.ok(library.includes(`['${key}','${label}']`), `LIBRARY_FORMATS must own final label ${key} -> ${label}`);
}
const libraryToolbarStart = library.indexOf('function libraryToolbar(');
const libraryToolbarEnd = library.indexOf('function libraryPager(', libraryToolbarStart);
assert.ok(libraryToolbarStart >= 0 && libraryToolbarEnd > libraryToolbarStart, 'libraryToolbar source boundary missing');
const libraryToolbarSource = library.slice(libraryToolbarStart, libraryToolbarEnd);
assert.ok(libraryToolbarSource.includes('data-layout="grid" type="button">Карточки</button>'), 'libraryToolbar must own final grid label');
assert.ok(libraryToolbarSource.includes('data-layout="list" type="button">Таблица</button>'), 'libraryToolbar must own final list label');

assert.ok(presentation.includes('export const STATUS_LABELS'), 'shared status mapping must exist');
assert.ok(presentation.includes('export const PUBLICATION_FORMAT_LABELS'), 'shared publication format mapping must exist');
assert.ok(presentation.includes('export const SOURCE_LABELS'), 'shared source mapping must exist');
for (const forbidden of ['document.', 'window.', 'MutationObserver', 'setInterval(', 'querySelector(', 'addEventListener(']) {
  assert.ok(!presentation.includes(forbidden), `presentation-labels.js must stay pure: ${forbidden}`);
}
assert.ok(library.includes("import { publicationFormatLabel, sourceLabel, statusLabel } from './presentation-labels.js';"), 'Library must import shared presentation helpers');
assert.ok(library.includes('publicationFormatLabel(item.publication_kind, item.content_format)'), 'Library format must use shared formatter');
assert.ok(library.includes("sourceLabel(item.source_type||'manual')"), 'Library source must use shared formatter');
assert.ok(library.includes('data-presentation-owner="library"'), 'Library badge ownership marker missing');
assert.ok(library.includes('data-raw-status="${libEsc(raw)}"'), 'Library badge raw status marker missing');
assert.ok(library.includes("libBadge(item.editorial_stage,'Контент')"), 'Library must render content role status');
assert.ok(library.includes("libBadge(item.status,'Публикация')"), 'Library must render publication role status');
assert.ok(!polish.includes('function uiPolishLibrary('), 'uiPolishLibrary must be removed');
assert.ok(!polish.includes('function uiPolishLibraryRoles('), 'uiPolishLibraryRoles must be removed');
assert.ok(!polish.includes('UI_SOURCE_LABEL'), 'Library source mapping must be removed from polish');
assert.ok(!polish.includes('UI_FORMAT_LABEL'), 'Library format mapping must be removed from polish');
assert.ok(!polish.includes('.library-meta'), 'polish must not traverse Library meta');
assert.ok(!polish.includes('.library-badges'), 'polish must not traverse Library badges');
assert.ok(!polish.includes('.library-table'), 'polish must not traverse Library table');
assert.ok(polish.includes("import { STATUS_LABELS, statusLabel } from './presentation-labels.js';"), 'polish must import shared status contract');
assert.ok(!polish.includes('const UI_STATUS_LABEL'), 'polish must not duplicate status mapping');
assert.ok(polish.includes("badge.dataset.presentationOwner === 'library'"), 'global status polish must guard Library-owned badges');

assert.ok(operator.includes("'/api/accounts/test'"), 'social connection verification must remain real API-backed');
assert.ok(operator.includes('/api/content-plan/v3/import/preview?sourceId='), 'source preview must remain schema-v3 backed');
assert.ok(operator.includes('/api/content-plan/v3/import/apply?sourceId='), 'source apply must remain schema-v3 backed');
assert.ok(!polish.includes('uiPolishSources'), 'Sources copy must no longer be owned by MutationObserver polish');
assert.ok(!polish.includes('uiRefineSources'), 'Sources cards must no longer be rewritten by page polish');
assert.ok(!operator.includes('Connector в текущем backend ещё не реализован'), 'Sources renderer must not claim Google Sheets is unavailable');
assert.ok(!operator.includes('Cloud media connectors пока не включены'), 'Sources renderer must not claim cloud media is unavailable');
assert.ok(operator.includes('publikator:operator-route-rendered'), 'operator router must emit explicit route-rendered event');
assert.ok(googleSheets.includes("addEventListener('publikator:operator-route-rendered'"), 'Google Sheets must mount from explicit route event');
assert.ok(!googleSheets.includes('new MutationObserver'), 'Google Sheets must not scan the whole DOM with MutationObserver');
assert.ok(calendar.includes("['month','week','day','agenda']"), 'calendar modes were lost');
assert.ok(library.includes("['stories','Истории']"), 'story library filter was lost');
assert.ok(library.includes("['shorts','Короткие видео']"), 'shorts library filter was lost');
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
