import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [index, app, css, ui, operator, googleSheets, calendar, library, dashboard, presentation, editorial, postEditor] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ui-v5.css', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ui-v5.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/operator-pages-v4.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/google-sheets-v1.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/calendar-v3.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/content-library-v3.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/dashboard-v3.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/presentation-labels.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/editorial-v4.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/post-editor-v04.js', import.meta.url), 'utf8')
]);

for (const removed of ['../public/ui-page-polish-v5.js', '../public/ui-page-polish-v5.css']) {
  let missing = false;
  try {
    await fs.access(new URL(removed, import.meta.url));
  } catch (error) {
    missing = error?.code === 'ENOENT';
  }
  assert.ok(missing, `legacy page-polish asset must be absent: ${removed}`);
}

const routes = [
  '/overview', '/calendar', '/content', '/library', '/templates', '/projects',
  '/socials', '/sources', '/schedule', '/journal', '/backups', '/diagnostics'
];
for (const route of routes) assert.ok(index.includes(`data-route="${route}"`), `missing route ${route}`);

for (const asset of ['/ui-v5.css', '/ui-v5.js']) {
  assert.ok(index.includes(asset), `unified UI asset is not loaded: ${asset}`);
}
assert.ok(!index.includes('/ui-page-polish-v5.js'), 'legacy page-polish runtime must not be loaded');
assert.ok(!index.includes('/ui-page-polish-v5.css'), 'legacy page-polish stylesheet must not be loaded');
assert.ok(index.indexOf('/ui-v5.css') > index.indexOf('/operator-pages-v4.css'), 'unified CSS must load after feature CSS');

assert.ok(!app.includes("await loadProjects(); await render('dashboard');"), 'bootstrap/login must not overwrite the routed page with dashboard');
assert.ok(operator.includes('operatorRouteWhenVisible'), 'operator router must own initial route rendering');

for (const token of ['--bg:', '--surface:', '--text-primary:', '--text-secondary:', '--border:', '--accent:', '--success:', '--warning:', '--danger:']) {
  assert.ok(css.includes(token), `missing semantic token ${token}`);
}
for (const contract of ['.ui-mobile-menu', '@media (max-width: 820px)', '.table-scroll', '.modal-card.post-editor-modal', '.ui-filterbar', ':focus-visible', '.ui-editor-section-title']) {
  assert.ok(css.includes(contract), `missing UI contract ${contract}`);
}
assert.ok(css.includes('.brand::after'), 'legacy compact-brand pseudo element must be suppressed');
assert.ok(css.includes('grid-template-columns: repeat(7, minmax(0, 1fr))'), 'mobile calendar must fit seven columns');
assert.ok(css.includes('overscroll-behavior-inline: contain'), 'mobile library tabs must scroll internally');
assert.ok(css.includes('html[data-page="content"] .table tbody tr'), 'mobile content cards contract missing');
assert.ok(!css.includes('.ui-internal-status'), 'obsolete hidden raw status selector must be removed');
assert.ok(!css.includes('.ui-human-status'), 'obsolete duplicate human status selector must be removed');

for (const route of routes) assert.ok(ui.includes(`'${route}'`), `route metadata missing ${route}`);
for (const behavior of ['uiContentFilters', 'uiProjectsPage', 'uiSchedulePage', 'uiJournalFilters', 'uiWrapTables', 'uiDecorateSocialCards', 'ui-nav-open']) {
  assert.ok(ui.includes(behavior), `shared enhancement missing ${behavior}`);
}
assert.ok(ui.includes("row.querySelector('.badge')?.dataset.rawStatus"), 'Content filtering must use raw status semantics');
assert.ok(ui.includes("['FAILED','PARTIAL','RECOVERY_NEEDED','RETRY'].includes(rawStatus)"), 'PROBLEM filter must retain machine-state semantics');

assert.ok(presentation.includes('export const STATUS_LABELS'), 'shared status mapping must exist');
assert.ok(presentation.includes('export const PUBLICATION_FORMAT_LABELS'), 'shared publication format mapping must exist');
assert.ok(presentation.includes('export const SOURCE_LABELS'), 'shared source mapping must exist');
assert.ok(presentation.includes('export const SCHEDULE_MODE_LABELS'), 'shared schedule-mode mapping must exist');
assert.ok(presentation.includes('export function scheduleModeLabel(value)'), 'shared schedule-mode helper must exist');
for (const forbidden of ['document.', 'window.', 'MutationObserver', 'setInterval(', 'setTimeout(', 'querySelector(', 'addEventListener(']) {
  assert.ok(!presentation.includes(forbidden), `presentation-labels.js must stay pure: ${forbidden}`);
}

const runtimeSources = [app, ui, operator, googleSheets, calendar, library, dashboard, editorial, postEditor].join('\n');
for (const legacy of ['uiPolishStatuses', 'uiPolishCalendar', 'uiPolishContent', 'uiPolishPostEditor', 'uiPolishAll', 'uiQueuePolish']) {
  assert.ok(!runtimeSources.includes(legacy), `legacy page-polish function leaked into runtime: ${legacy}`);
}
assert.ok(!runtimeSources.includes('ui-internal-status'), 'hidden raw status runtime marker must be removed');
assert.ok(!runtimeSources.includes('ui-human-status'), 'duplicate human status runtime marker must be removed');

assert.ok(app.includes("import { scheduleModeLabel, statusLabel } from './presentation-labels.js';"), 'Content renderer must use shared presentation helpers');
assert.ok(app.includes('data-raw-status="${esc(raw)}"'), 'Content badge helper must preserve raw status');
assert.ok(app.includes("badge(p.status,'content')"), 'Content rows must declare presentation ownership');
assert.ok(app.includes('data-raw-schedule="${esc(p.schedule_mode)}"'), 'Content schedule cell must preserve raw mode');
assert.ok(app.includes('scheduleModeLabel(p.schedule_mode)'), 'Content schedule cell must render shared human label');

const postEditorStart = app.indexOf('async function postEditor(postId)');
const targetsStart = app.indexOf('function targetsHtml', postEditorStart);
assert.ok(postEditorStart >= 0 && targetsStart > postEditorStart, 'postEditor source boundary missing');
const postEditorSource = app.slice(postEditorStart, targetsStart);
for (const text of [
  'Новая публикация',
  'Основное',
  'Проект, режим публикации, заголовок и текст.',
  'Когда публиковать',
  'Дата и время публикации',
  'После сохранения',
  'Сначала сохраните черновик — затем появятся загрузка медиа и выбор площадок.',
  'Сохраните черновик. После этого можно загрузить медиа и выбрать площадки.',
  'Медиа',
  'Добавьте изображения или видео и проверьте порядок файлов.',
  'Площадки',
  'Выберите подключения, куда должна уйти публикация.'
]) {
  assert.ok(postEditorSource.includes(text), `post editor scaffold missing canonical text: ${text}`);
}
assert.ok(postEditorSource.includes('class="form-grid ui-post-form"'), 'post form must render final structural class');
assert.ok(app.includes("mode.value!=='AT'"), 'post editor scaffold must own datetime visibility');
assert.ok(postEditor.includes('function hydrateScheduledAt(form, post)'), 'existing AT posts must hydrate local datetime');
assert.ok(!postEditor.includes('function enhanceScheduleField'), 'post-editor enhancement must not own datetime visibility');
assert.ok(!postEditor.includes("mode.addEventListener('change'"), 'post-editor enhancement must not register duplicate schedule visibility listener');

assert.ok(calendar.includes("import { sourceLabel, statusLabel } from './presentation-labels.js';"), 'Calendar must use shared presentation helpers');
assert.ok(calendar.includes("agenda:'Список'"), 'Calendar agenda mode must render Список');
assert.ok(calendar.includes('Часовой пояс: ${calEsc(CALENDAR_DISPLAY_TIMEZONE)}'), 'Calendar toolbar must render human timezone label');
assert.ok(calendar.includes("sourceLabel(item.source_type||'manual')"), 'Calendar source must use shared source helper');
assert.ok(calendar.includes('data-raw-status="${calEsc(raw)}"'), 'Calendar statuses must preserve raw machine value');
assert.ok(calendar.includes('statusLabel(raw)'), 'Calendar statuses must render human labels');
for (const stale of ["agenda:'Agenda'", 'display: ${', ' · schedule ']) {
  assert.ok(!calendar.includes(stale), `Calendar technical presentation leaked: ${stale}`);
}

assert.ok(editorial.includes("import { statusLabel } from './presentation-labels.js';"), 'Editorial must use shared status helper');
assert.ok(editorial.includes('data-raw-status="${editorialEscape(raw)}"'), 'Editorial badges must preserve raw status');
assert.ok(editorial.includes('editorialEscape(statusLabel(raw))'), 'Editorial badges must render human status');

for (const [name, source, esc] of [
  ['Google Sheets', googleSheets, 'gsEsc'],
  ['Source Preview', operator, 'operatorEsc']
]) {
  assert.ok(source.includes("import { statusLabel } from './presentation-labels.js';"), `${name} must use shared classification labels`);
  assert.ok(source.includes('data-raw-classification='), `${name} must preserve raw classification`);
  assert.ok(source.includes(`${esc}(statusLabel(row.classification))`), `${name} must render human classification`);
}

const templatesDescription = 'Здесь будут храниться повторно используемые заготовки текста, структуры и настроек публикации.';
const templatesEmptyState = 'Шаблоны пока не включены. До их появления создавайте и дублируйте материалы через раздел «Контент».';
assert.ok(operator.includes(templatesDescription), 'final templates description must remain renderer-owned');
assert.ok(operator.includes(templatesEmptyState), 'final templates empty state must remain renderer-owned');
assert.ok(operator.includes("['/templates', renderTemplatesPage]"), '/templates must remain registered');

const socialsDescription = 'Подключите площадку, проверьте токен и укажите конкретный канал, группу или чат. Сохранить можно только проверенное подключение.';
assert.ok(operator.includes(socialsDescription), 'final socials description must remain renderer-owned');
assert.ok(operator.includes("['/socials', renderSocialsPage]"), '/socials must remain registered');

const slotEditorStart = app.indexOf('function slotEditor()');
const slotEditorEnd = app.indexOf('async function events()', slotEditorStart);
assert.ok(slotEditorStart >= 0 && slotEditorEnd > slotEditorStart, 'slotEditor source boundary missing');
const slotEditorSource = app.slice(slotEditorStart, slotEditorEnd);
assert.ok(slotEditorSource.includes('<h2>Новое время публикации</h2>'), 'schedule modal title must remain renderer-owned');
assert.ok(slotEditorSource.includes('<label>Часовой пояс<input name="timezone" value="Europe/Moscow">'), 'schedule timezone label must remain renderer-owned');
assert.ok(slotEditorSource.includes('<button class="primary">Добавить</button>'), 'schedule primary action must remain renderer-owned');

const overviewProblemsNote = 'ошибки и публикации, требующие проверки';
assert.ok(dashboard.includes(`dashboardMetric('Проблемы', data.metrics.problems, '${overviewProblemsNote}'`), 'Overview Problems note must remain renderer-owned');
assert.ok(dashboard.includes("import { publicationFormatLabel, statusLabel } from './presentation-labels.js';"), 'Dashboard must reuse shared presentation labels');

assert.ok(library.includes("import { publicationFormatLabel, sourceLabel, statusLabel } from './presentation-labels.js';"), 'Library must retain shared presentation ownership');
assert.ok(library.includes('data-presentation-owner="library"'), 'Library badge ownership marker missing');
assert.ok(library.includes('data-raw-status="${libEsc(raw)}"'), 'Library raw status marker missing');

assert.ok(operator.includes("'/api/accounts/test'"), 'social connection verification must remain real API-backed');
assert.ok(operator.includes('/api/content-plan/v3/import/preview?sourceId='), 'source preview must remain schema-v3 backed');
assert.ok(operator.includes('/api/content-plan/v3/import/apply?sourceId='), 'source apply must remain schema-v3 backed');
assert.ok(operator.includes('publikator:operator-route-rendered'), 'operator router must emit explicit route-rendered event');
assert.ok(googleSheets.includes("addEventListener('publikator:operator-route-rendered'"), 'Google Sheets must mount from explicit route event');
assert.ok(!googleSheets.includes('new MutationObserver'), 'Google Sheets must not scan the whole DOM with MutationObserver');
assert.ok(calendar.includes("['month','week','day','agenda']"), 'calendar modes were lost');
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
  directPresentationOwnership: true,
  legacyPagePolishRemoved: true,
  existingProductWorkflowsPreserved: true
}));

const browserAcceptance = spawnSync(process.execPath, [fileURLToPath(new URL('./browser-operator-acceptance-e2e.mjs', import.meta.url))], {
  stdio: 'inherit'
});
assert.equal(browserAcceptance.status, 0, 'real browser operator acceptance failed');
