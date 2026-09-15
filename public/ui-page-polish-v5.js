const UI_STATUS_LABEL = {
  DRAFT: 'Черновик', READY: 'Готово', PUBLISHING: 'Публикуется', PUBLISHED: 'Опубликовано',
  PARTIAL: 'Частично', FAILED: 'Ошибка', RETRY: 'Повтор', RECOVERY_NEEDED: 'Восстановление',
  IDEA: 'Идея', IN_REVIEW: 'На проверке', APPROVED: 'Одобрено',
  NEW: 'Новая', UPDATE: 'Изменена', UNCHANGED: 'Без изменений', CONFLICT: 'Конфликт', ERROR: 'Ошибка'
};
const UI_SCHEDULE_LABEL = { MANUAL: 'Вручную', QUEUE: 'Очередь', AT: 'По времени' };
const UI_SOURCE_LABEL = { manual: 'Вручную', ai: 'ИИ', api: 'API', bundle: 'Пакет', sheets: 'Таблица' };
let uiPolishTimer = null;

function uiPolishStatuses(root = document) {
  root.querySelectorAll('.badge').forEach((badge) => {
    const raw = badge.dataset.rawStatus || badge.textContent.trim();
    if (!badge.dataset.rawStatus && UI_STATUS_LABEL[raw]) badge.dataset.rawStatus = raw;
    const key = badge.dataset.rawStatus;
    if (key && UI_STATUS_LABEL[key]) badge.textContent = UI_STATUS_LABEL[key];
  });
  root.querySelectorAll('.operator-classification').forEach((chip) => {
    const raw = chip.dataset.rawClassification || chip.textContent.trim();
    if (!chip.dataset.rawClassification && UI_STATUS_LABEL[raw]) chip.dataset.rawClassification = raw;
    if (chip.dataset.rawClassification) chip.textContent = UI_STATUS_LABEL[chip.dataset.rawClassification] || chip.dataset.rawClassification;
  });
}

function uiPolishCalendar(root = document) {
  const agenda = root.querySelector('[data-calendar-mode="agenda"]');
  if (agenda) agenda.textContent = 'Список';
  root.querySelectorAll('.calendar-toolbar .small.muted').forEach((node) => {
    const text = node.textContent.trim();
    if (text.startsWith('display:')) node.textContent = `Часовой пояс: ${text.slice('display:'.length).trim()}`;
  });
  root.querySelectorAll('.calendar-source').forEach((node) => {
    let text = node.textContent;
    text = text.replace(/\bmanual\b/gi, 'вручную').replace(/\bsource:\s*/gi, 'Источник: ');
    for (const [raw, label] of Object.entries(UI_STATUS_LABEL)) text = text.replace(new RegExp(`\\b${raw}\\b`, 'g'), label);
    text = text.replace(/schedule\s+/gi, 'план: ').replace(/display\s+/gi, 'просмотр: ');
    node.textContent = text;
  });
}

function uiPolishLibrary(root = document) {
  root.querySelectorAll('[data-library-view]').forEach((button) => {
    const labels = { all: 'Все', inbox: 'Входящие', draft: 'Черновики', ready: 'Готово', scheduled: 'Запланировано', published: 'Опубликовано', problems: 'Проблемы' };
    if (labels[button.dataset.libraryView]) button.textContent = labels[button.dataset.libraryView];
  });
  root.querySelectorAll('[data-layout]').forEach((button) => {
    if (button.dataset.layout === 'grid') button.textContent = 'Карточки';
    if (button.dataset.layout === 'list') button.textContent = 'Таблица';
  });
  const format = root.querySelector('#library-format');
  if (format) {
    const labels = { all: 'Все форматы', image: 'Изображения', stories: 'Истории', shorts: 'Короткие видео', video: 'Видео' };
    [...format.options].forEach((option) => { if (labels[option.value]) option.textContent = labels[option.value]; });
  }
  root.querySelectorAll('.library-meta').forEach((node) => {
    const match = node.textContent.match(/source:\s*([^·]+)/i);
    if (!match) return;
    const raw = match[1].trim().toLowerCase();
    node.textContent = node.textContent.replace(/source:\s*[^·]+/i, `Источник: ${UI_SOURCE_LABEL[raw] || match[1].trim()}`);
  });
}

function uiPolishContent(root = document) {
  if (window.location.pathname !== '/content') return;
  const table = root.querySelector('table.table');
  if (!table) return;
  table.querySelectorAll('tbody tr').forEach((row) => {
    const mode = row.children[3];
    if (!mode) return;
    const raw = mode.dataset.rawSchedule || mode.textContent.trim();
    if (!mode.dataset.rawSchedule && UI_SCHEDULE_LABEL[raw]) mode.dataset.rawSchedule = raw;
    if (mode.dataset.rawSchedule) mode.textContent = UI_SCHEDULE_LABEL[mode.dataset.rawSchedule] || mode.dataset.rawSchedule;
  });
}

function uiPolishTemplates(root = document) {
  if (window.location.pathname !== '/templates') return;
  const page = root.querySelector('.operator-page');
  if (!page || page.dataset.uiCopy === '1') return;
  page.dataset.uiCopy = '1';
  const description = page.querySelector('.operator-page-head p');
  if (description) description.textContent = 'Здесь будут храниться повторно используемые заготовки текста, структуры и настроек публикации.';
  const empty = page.querySelector('.operator-empty');
  if (empty) empty.textContent = 'Шаблоны пока не включены. До их появления создавайте и дублируйте материалы через раздел «Контент».';
}

function uiPolishSources(root = document) {
  if (window.location.pathname !== '/sources') return;
  const sourceInput = root.querySelector('#operator-source-id');
  if (sourceInput) {
    const label = sourceInput.closest('label');
    if (label && label.dataset.uiCopy !== '1') {
      label.dataset.uiCopy = '1';
      const first = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (first) first.textContent = 'Название набора ';
      const help = label.querySelector('.operator-field-help');
      if (help) help.textContent = 'Например: social-plan. Оставляйте одно название для повторных версий одной и той же таблицы.';
    }
  }
  root.querySelectorAll('.operator-section h3').forEach((heading) => {
    if (/Excel\s*\/\s*CSV/i.test(heading.textContent)) heading.textContent = 'Таблица Excel / CSV';
  });
  root.querySelectorAll('.operator-section > p').forEach((paragraph) => {
    if (paragraph.textContent.includes('Preview') && paragraph.textContent.includes('Apply')) paragraph.textContent = 'Сначала выберите файл и нажмите «Проверить». Импорт станет доступен только после успешной проверки этого же файла.';
  });
  const preview = root.querySelector('#operator-source-preview');
  if (preview) preview.textContent = '1. Проверить таблицу';
  const apply = root.querySelector('#operator-source-apply');
  if (apply) apply.textContent = '2. Импортировать';
}

function uiEditorSection(title, note, index) {
  const section = document.createElement('div');
  section.className = 'ui-editor-section-title full';
  section.innerHTML = `<span>${index}</span><div><strong>${title}</strong><small>${note}</small></div>`;
  return section;
}

function uiPolishPostEditor(root = document) {
  root.querySelectorAll('#post-form').forEach((form) => {
    if (form.dataset.uiStructured === '1') return;
    form.dataset.uiStructured = '1';
    form.classList.add('ui-post-form');
    const firstField = form.querySelector('label');
    if (firstField) firstField.before(uiEditorSection('Основное', 'Проект, режим публикации, заголовок и текст.', '1'));
    const mediaInput = form.querySelector('#media-file');
    const mediaBlock = mediaInput?.closest('.full') || [...form.querySelectorAll('.full')].find((node) => node.querySelector('.media-list'));
    if (mediaBlock) {
      const heading = [...mediaBlock.children].find((node) => node.tagName === 'STRONG');
      if (heading) heading.textContent = 'Медиа';
      mediaBlock.before(uiEditorSection('Медиа', 'Добавьте изображения или видео и проверьте порядок файлов.', '2'));
    }
    const targetPicker = form.querySelector('.target-picker');
    const targetBlock = targetPicker?.closest('.full');
    if (targetBlock) targetBlock.before(uiEditorSection('Площадки', 'Выберите подключения, куда должна уйти публикация.', '3'));
  });
}

function uiPolishPlatformCards(root = document) {
  root.querySelectorAll('.operator-platform-card').forEach((card) => {
    const trigger = card.querySelector('[data-platform]');
    if (trigger?.dataset.platform) card.dataset.platform = trigger.dataset.platform;
  });
}

function uiPolishAll() {
  const view = document.querySelector('#view') || document;
  uiPolishStatuses(view);
  uiPolishCalendar(view);
  uiPolishLibrary(view);
  uiPolishContent(view);
  uiPolishTemplates(view);
  uiPolishSources(view);
  uiPolishPostEditor(document);
  uiPolishPlatformCards(view);
}

function uiQueuePolish() {
  if (uiPolishTimer) clearTimeout(uiPolishTimer);
  uiPolishTimer = setTimeout(() => { uiPolishTimer = null; uiPolishAll(); }, 0);
}

const polishObserver = new MutationObserver(uiQueuePolish);
polishObserver.observe(document.body, { childList: true, subtree: true });
window.addEventListener('popstate', uiQueuePolish);
window.addEventListener('publikator:route', uiQueuePolish);
uiQueuePolish();
