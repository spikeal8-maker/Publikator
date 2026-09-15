const UI_ROUTE_META = {
  '/overview': { key: 'overview', group: 'Работа', title: 'Обзор', subtitle: 'Редакционная картина: что выходит сегодня, что готово и где требуется внимание.' },
  '/calendar': { key: 'calendar', group: 'Работа', title: 'Календарь', subtitle: 'Визуальное расписание публикаций по датам и времени.' },
  '/content': { key: 'content', group: 'Работа', title: 'Контент', subtitle: 'Создание, редактирование и подготовка публикаций к отправке.' },
  '/library': { key: 'library', group: 'Работа', title: 'Библиотека', subtitle: 'Весь контент с поиском, фильтрами, статусами и визуальным просмотром.' },
  '/templates': { key: 'templates', group: 'Работа', title: 'Шаблоны', subtitle: 'Повторно используемые заготовки контента и оформления.' },
  '/projects': { key: 'projects', group: 'Работа', title: 'Проекты', subtitle: 'Разделение контента по брендам, продуктам и независимым очередям.' },
  '/socials': { key: 'socials', group: 'Работа', title: 'Соцсети', subtitle: 'Подключение площадок, проверка токенов и конкретных мест публикации.' },
  '/sources': { key: 'sources', group: 'Работа', title: 'Источники / Интеграции', subtitle: 'Массовый импорт и подключение внешних источников контента.' },
  '/schedule': { key: 'schedule', group: 'Работа', title: 'Расписание', subtitle: 'Технические QUEUE-слоты для автоматического выпуска готового контента.' },
  '/journal': { key: 'journal', group: 'Система', title: 'Журнал', subtitle: 'История действий, публикаций, ошибок и служебных событий.' },
  '/backups': { key: 'backups', group: 'Система', title: 'Резервные копии', subtitle: 'Создание и проверка резервных копий данных Publikator.' },
  '/diagnostics': { key: 'diagnostics', group: 'Система', title: 'Диагностика', subtitle: 'Состояние приложения, окружения и эксплуатационных проверок.' }
};

const UI_ICON = {
  overview: '<path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  content: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h6"/>',
  library: '<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/>',
  templates: '<path d="M5 3h11a3 3 0 0 1 3 3v15H8a3 3 0 0 1-3-3V3Z"/><path d="M8 7h7M8 11h7M8 15h5"/>',
  projects: '<path d="M3 7h7l2 2h9v11H3z"/><path d="M3 7V5h7l2 2"/>',
  socials: '<circle cx="7" cy="12" r="3"/><circle cx="17" cy="6" r="3"/><circle cx="17" cy="18" r="3"/><path d="m9.6 10.5 4.8-3M9.6 13.5l4.8 3"/>',
  sources: '<path d="M5 4h14v5H5zM5 15h14v5H5z"/><path d="M8 9v6M16 9v6"/>',
  schedule: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  journal: '<path d="M5 3h14v18H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  backups: '<path d="M4 7a8 8 0 1 1 1 11"/><path d="M4 3v5h5"/><path d="M12 8v5l3 2"/>',
  diagnostics: '<path d="M4 19h16M6 16V8M12 16V4M18 16v-5"/>',
  logout: '<path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9"/>'
};

const SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';
const MENU_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const BRAND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M7 5h8a4 4 0 0 1 0 8H7V5Z"/><path d="M7 13h7a3 3 0 0 1 0 6H7V13Z"/></svg>';

let uiEnhanceTimer = null;

function uiSvg(path) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function uiCurrentMeta() {
  const path = window.location.pathname;
  return UI_ROUTE_META[path] || UI_ROUTE_META['/overview'];
}

function uiDecorateBrand() {
  const brand = document.querySelector('.brand');
  if (!brand || brand.dataset.uiV5 === '1') return;
  brand.dataset.uiV5 = '1';
  brand.innerHTML = `<span class="ui-brand-mark">${BRAND_SVG}</span><span class="ui-brand-copy"><strong>Publikator</strong><span>Контент-центр</span></span>`;
}

function uiDecorateNav() {
  document.querySelectorAll('.nav').forEach((button) => {
    if (button.dataset.uiV5 === '1') return;
    button.dataset.uiV5 = '1';
    const label = button.textContent.trim();
    const meta = button.dataset.route ? UI_ROUTE_META[button.dataset.route] : null;
    const key = meta?.key || (button.id === 'logout' ? 'logout' : 'overview');
    button.innerHTML = `<span class="nav-icon">${uiSvg(UI_ICON[key] || UI_ICON.overview)}</span><span class="nav-label">${label}</span>`;
    button.title = label;
  });
}

function uiEnsureHeader() {
  const header = document.querySelector('main > header');
  const heading = document.querySelector('#page-title');
  if (!header || !heading) return;
  let copy = header.querySelector('.ui-header-copy');
  if (!copy) {
    copy = document.createElement('div');
    copy.className = 'ui-header-copy';
    const kicker = document.createElement('div');
    kicker.className = 'ui-header-kicker';
    const subtitle = document.createElement('div');
    subtitle.className = 'ui-page-subtitle';
    copy.append(kicker, heading, subtitle);
    header.insertBefore(copy, header.firstChild);
  }
  if (!header.querySelector('.ui-mobile-menu')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui-mobile-menu';
    button.setAttribute('aria-label', 'Открыть меню');
    button.innerHTML = MENU_SVG;
    button.addEventListener('click', () => document.body.classList.toggle('ui-nav-open'));
    header.insertBefore(button, copy);
  }
}

function uiUpdateHeader() {
  uiEnsureHeader();
  const meta = uiCurrentMeta();
  document.documentElement.dataset.page = meta.key;
  const kicker = document.querySelector('.ui-header-kicker');
  const subtitle = document.querySelector('.ui-page-subtitle');
  if (kicker) kicker.textContent = meta.group;
  if (subtitle) subtitle.textContent = meta.subtitle;
  document.querySelectorAll('.nav[data-route]').forEach((button) => button.setAttribute('aria-current', button.dataset.route === window.location.pathname ? 'page' : 'false'));
}

function uiWrapTables(root = document) {
  root.querySelectorAll('table.table').forEach((table) => {
    if (table.closest('.table-scroll, .library-table-wrap, .operator-preview-table')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    table.parentNode?.insertBefore(wrap, table);
    wrap.append(table);
  });
}

function uiDecorateSocialCards(root = document) {
  root.querySelectorAll('.operator-platform-card').forEach((card) => {
    const trigger = card.querySelector('[data-platform]');
    if (trigger?.dataset.platform) card.dataset.platform = trigger.dataset.platform;
  });
}

function uiToolbarCopy(toolbar, title, note) {
  if (!toolbar) return;
  const existing = [...toolbar.children].find((node) => node.classList?.contains('muted') || node.classList?.contains('ui-toolbar-copy'));
  if (!existing) return;
  existing.className = 'ui-toolbar-copy';
  existing.innerHTML = `<strong>${title}</strong><span>${note}</span>`;
}

function uiContentFilters() {
  const table = document.querySelector('#view table.table');
  const toolbar = document.querySelector('#view .toolbar');
  if (!table || !toolbar || document.querySelector('#ui-content-filter')) return;
  uiToolbarCopy(toolbar, 'Публикации', 'Черновики, готовые и опубликованные материалы в одном рабочем списке.');
  const newButton = document.querySelector('#new-post');
  if (newButton) newButton.textContent = '+ Создать публикацию';
  const filter = document.createElement('div');
  filter.id = 'ui-content-filter';
  filter.className = 'ui-filterbar';
  filter.innerHTML = `<label class="ui-filter-search">${SEARCH_SVG}<input type="search" placeholder="Поиск по заголовку, тексту или проекту" aria-label="Поиск контента"></label><div class="ui-filter-chips"><button type="button" class="ui-filter-chip active" data-status="ALL">Все</button><button type="button" class="ui-filter-chip" data-status="DRAFT">Черновики</button><button type="button" class="ui-filter-chip" data-status="READY">Готовы</button><button type="button" class="ui-filter-chip" data-status="PUBLISHED">Опубликовано</button><button type="button" class="ui-filter-chip" data-status="PROBLEM">Проблемы</button></div><span class="ui-count-pill"></span>`;
  toolbar.after(filter);
  let status = 'ALL';
  const search = filter.querySelector('input');
  const count = filter.querySelector('.ui-count-pill');
  const apply = () => {
    const query = search.value.trim().toLowerCase();
    const rows = [...table.querySelectorAll('tbody tr')];
    let visible = 0;
    for (const row of rows) {
      if (row.querySelector('td[colspan]')) continue;
      const badge = row.querySelector('.badge')?.textContent.trim().toUpperCase() || '';
      const matchStatus = status === 'ALL' || badge === status || (status === 'PROBLEM' && ['FAILED','PARTIAL','RECOVERY_NEEDED','RETRY'].includes(badge));
      const matchSearch = !query || row.textContent.toLowerCase().includes(query);
      row.hidden = !(matchStatus && matchSearch);
      if (!row.hidden) visible += 1;
    }
    count.textContent = `${visible} показано`;
  };
  search.addEventListener('input', apply);
  filter.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', () => {
    status = button.dataset.status;
    filter.querySelectorAll('[data-status]').forEach((item) => item.classList.toggle('active', item === button));
    apply();
  }));
  apply();
}

function uiProjectsPage() {
  const toolbar = document.querySelector('#view .toolbar');
  const table = document.querySelector('#view table.table');
  if (!toolbar || !table) return;
  uiToolbarCopy(toolbar, 'Рабочие проекты', 'Проект отделяет собственный контент и очередь публикаций от остальных направлений.');
  const button = document.querySelector('#new-project');
  if (button) button.textContent = '+ Новый проект';
  if (!toolbar.querySelector('.ui-count-pill')) {
    const count = [...table.querySelectorAll('tbody tr')].filter((row) => !row.querySelector('td[colspan]')).length;
    const pill = document.createElement('span');
    pill.className = 'ui-count-pill';
    pill.textContent = `${count} проектов`;
    toolbar.insertBefore(pill, button || null);
  }
}

function uiSchedulePage() {
  const toolbar = document.querySelector('#view .toolbar');
  const table = document.querySelector('#view table.table');
  if (!toolbar || !table) return;
  uiToolbarCopy(toolbar, 'Автоматические слоты', 'В каждый слот Publikator забирает следующий READY-материал проекта с режимом QUEUE.');
  const button = document.querySelector('#new-slot');
  if (button) button.textContent = '+ Добавить слот';
  const weekdays = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  table.querySelectorAll('tbody tr').forEach((row) => {
    const cell = row.children[1];
    if (!cell || cell.dataset.uiWeekday === '1') return;
    const value = Number(cell.textContent.trim());
    if (Number.isInteger(value) && value >= 0 && value <= 6) {
      cell.dataset.uiWeekday = '1';
      cell.innerHTML = `<strong>${weekdays[value]}</strong><div class="small muted">каждую неделю</div>`;
    }
  });
}

function uiJournalFilters() {
  const table = document.querySelector('#view table.table');
  if (!table || document.querySelector('#ui-journal-filter')) return;
  const filter = document.createElement('div');
  filter.id = 'ui-journal-filter';
  filter.className = 'ui-filterbar';
  filter.innerHTML = `<label class="ui-filter-search">${SEARCH_SVG}<input type="search" placeholder="Поиск по событию или сообщению" aria-label="Поиск по журналу"></label><div class="ui-filter-chips"><button type="button" class="ui-filter-chip active" data-level="ALL">Все события</button><button type="button" class="ui-filter-chip" data-level="ERROR">Только ошибки</button></div><span class="ui-count-pill"></span>`;
  const host = table.closest('.table-scroll') || table;
  host.before(filter);
  let level = 'ALL';
  const search = filter.querySelector('input');
  const count = filter.querySelector('.ui-count-pill');
  const apply = () => {
    const query = search.value.trim().toLowerCase();
    const rows = [...table.querySelectorAll('tbody tr')];
    let visible = 0;
    rows.forEach((row) => {
      if (row.querySelector('td[colspan]')) return;
      const isError = Boolean(row.querySelector('.event-error'));
      const matched = (!query || row.textContent.toLowerCase().includes(query)) && (level === 'ALL' || isError);
      row.hidden = !matched;
      if (matched) visible += 1;
    });
    count.textContent = `${visible} событий`;
  };
  search.addEventListener('input', apply);
  filter.querySelectorAll('[data-level]').forEach((button) => button.addEventListener('click', () => {
    level = button.dataset.level;
    filter.querySelectorAll('[data-level]').forEach((item) => item.classList.toggle('active', item === button));
    apply();
  }));
  apply();
}

function uiSystemPageClasses() {
  const meta = uiCurrentMeta();
  const view = document.querySelector('#view');
  if (!view) return;
  view.classList.toggle('ui-system-page', ['journal','backups','diagnostics'].includes(meta.key));
}

function uiEnhancePage() {
  uiDecorateBrand();
  uiDecorateNav();
  uiUpdateHeader();
  uiWrapTables(document.querySelector('#view') || document);
  uiDecorateSocialCards(document.querySelector('#view') || document);
  uiSystemPageClasses();
  const key = uiCurrentMeta().key;
  if (key === 'content') uiContentFilters();
  if (key === 'projects') uiProjectsPage();
  if (key === 'schedule') uiSchedulePage();
  if (key === 'journal') uiJournalFilters();
}

function uiQueueEnhance() {
  if (uiEnhanceTimer) clearTimeout(uiEnhanceTimer);
  uiEnhanceTimer = setTimeout(() => {
    uiEnhanceTimer = null;
    uiEnhancePage();
  }, 0);
}

for (const method of ['pushState','replaceState']) {
  const original = history[method];
  history[method] = function (...args) {
    const result = original.apply(this, args);
    window.dispatchEvent(new Event('publikator:route'));
    return result;
  };
}
window.addEventListener('popstate', uiQueueEnhance);
window.addEventListener('publikator:route', uiQueueEnhance);

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.nav[data-route]')) document.body.classList.remove('ui-nav-open');
  if (document.body.classList.contains('ui-nav-open') && !target?.closest('aside') && !target?.closest('.ui-mobile-menu')) document.body.classList.remove('ui-nav-open');
}, true);

const uiView = document.querySelector('#view');
const uiTitle = document.querySelector('#page-title');
const uiApp = document.querySelector('#app');
const uiObserver = new MutationObserver(uiQueueEnhance);
if (uiView) uiObserver.observe(uiView, { childList: true, subtree: true });
if (uiTitle) uiObserver.observe(uiTitle, { childList: true, subtree: true, characterData: true });
if (uiApp) uiObserver.observe(uiApp, { attributes: true, attributeFilter: ['class'] });
uiQueueEnhance();
