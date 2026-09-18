const UI_STATUS_LABEL = {
  DRAFT: 'Черновик', READY: 'Готово', PUBLISHING: 'Публикуется', PUBLISHED: 'Опубликовано',
  PARTIAL: 'Частично', FAILED: 'Ошибка', RETRY: 'Повтор', RECOVERY_NEEDED: 'Восстановление',
  IDEA: 'Идея', IN_REVIEW: 'На проверке', APPROVED: 'Одобрено',
  NEW: 'Новая', UPDATE: 'Изменена', UNCHANGED: 'Без изменений', CONFLICT: 'Конфликт', ERROR: 'Ошибка'
};
const UI_SCHEDULE_LABEL = { MANUAL: 'Вручную', QUEUE: 'Очередь', AT: 'По времени' };
const UI_SOURCE_LABEL = { manual: 'Вручную', ai: 'ИИ', api: 'API', bundle: 'Пакет', sheets: 'Таблица' };
const UI_FORMAT_LABEL = { 'FEED / IMAGE': 'Пост · Изображение', 'FEED / VIDEO': 'Пост · Видео', 'SHORT / VERTICAL_VIDEO': 'Короткое видео', 'STORY / IMAGE': 'История · Изображение', 'STORY / VIDEO': 'История · Видео', 'STORY / STORY_SEQUENCE': 'Серия историй' };
let uiPolishTimer = null;

function uiSetText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function uiPolishStatuses(root = document) {
  const preserveContentStatus = window.location.pathname === '/content';
  root.querySelectorAll('.badge').forEach((badge) => {
    const raw = badge.dataset.rawStatus || badge.textContent.trim();
    if (!badge.dataset.rawStatus && UI_STATUS_LABEL[raw]) badge.dataset.rawStatus = raw;
    const key = badge.dataset.rawStatus;
    if (key && UI_STATUS_LABEL[key] && !preserveContentStatus) uiSetText(badge, UI_STATUS_LABEL[key]);
  });
  root.querySelectorAll('.operator-classification').forEach((chip) => {
    const raw = chip.dataset.rawClassification || chip.textContent.trim();
    if (!chip.dataset.rawClassification && UI_STATUS_LABEL[raw]) chip.dataset.rawClassification = raw;
    if (chip.dataset.rawClassification) uiSetText(chip, UI_STATUS_LABEL[chip.dataset.rawClassification] || chip.dataset.rawClassification);
  });
}

function uiPolishCalendar(root = document) {
  const agenda = root.querySelector('[data-calendar-mode="agenda"]');
  uiSetText(agenda, 'Список');
  root.querySelectorAll('.calendar-toolbar .small.muted').forEach((node) => {
    const text = node.textContent.trim();
    if (text.startsWith('display:')) uiSetText(node, `Часовой пояс: ${text.slice('display:'.length).trim()}`);
  });
  root.querySelectorAll('.calendar-source').forEach((node) => {
    let text = node.textContent;
    text = text.replace(/\bmanual\b/gi, 'вручную').replace(/\bsource:\s*/gi, 'Источник: ');
    for (const [raw, label] of Object.entries(UI_STATUS_LABEL)) text = text.replace(new RegExp(`\\b${raw}\\b`, 'g'), label);
    text = text.replace(/schedule\s+/gi, 'план: ').replace(/display\s+/gi, 'просмотр: ');
    uiSetText(node, text);
  });
}

function uiPolishLibrary(root = document) {
  root.querySelectorAll('[data-library-view]').forEach((button) => {
    const labels = { all: 'Все', inbox: 'Входящие', draft: 'Черновики', ready: 'Готово', scheduled: 'Запланировано', published: 'Опубликовано', problems: 'Проблемы' };
    if (labels[button.dataset.libraryView]) uiSetText(button, labels[button.dataset.libraryView]);
  });
  root.querySelectorAll('[data-layout]').forEach((button) => {
    if (button.dataset.layout === 'grid') uiSetText(button, 'Карточки');
    if (button.dataset.layout === 'list') uiSetText(button, 'Таблица');
  });
  const format = root.querySelector('#library-format');
  if (format) {
    const labels = { all: 'Все форматы', image: 'Изображения', stories: 'Истории', shorts: 'Короткие видео', video: 'Видео' };
    [...format.options].forEach((option) => { if (labels[option.value]) uiSetText(option, labels[option.value]); });
  }
  root.querySelectorAll('.library-meta').forEach((node) => {
    let text = node.textContent;
    for (const [raw, label] of Object.entries(UI_FORMAT_LABEL)) text = text.replace(raw, label);
    uiSetText(node, text);
    const match = node.textContent.match(/source:\s*([^·]+)/i);
    if (!match) return;
    const raw = match[1].trim().toLowerCase();
    uiSetText(node, node.textContent.replace(/source:\s*[^·]+/i, `Источник: ${UI_SOURCE_LABEL[raw] || match[1].trim()}`));
  });
}

function uiPolishContent(root = document) {
  if (window.location.pathname !== '/content') return;
  const table = root.querySelector('table.table');
  if (!table) return;
  table.querySelectorAll('tbody tr').forEach((row) => {
    const mode = row.children[3];
    if (mode) {
      const rawMode = mode.dataset.rawSchedule || mode.textContent.trim();
      if (!mode.dataset.rawSchedule && UI_SCHEDULE_LABEL[rawMode]) mode.dataset.rawSchedule = rawMode;
      if (mode.dataset.rawSchedule) uiSetText(mode, UI_SCHEDULE_LABEL[mode.dataset.rawSchedule] || mode.dataset.rawSchedule);
    }
    const badge = row.querySelector('.badge');
    if (!badge) return;
    const rawStatus = badge.dataset.rawStatus || badge.textContent.trim();
    if (!UI_STATUS_LABEL[rawStatus]) return;
    if (!badge.dataset.rawStatus) badge.dataset.rawStatus = rawStatus;
    badge.classList.add('ui-internal-status');
    let visible = badge.nextElementSibling;
    if (!visible?.classList.contains('ui-human-status')) {
      visible = document.createElement('span');
      visible.className = `badge ui-human-status ${rawStatus}`;
      badge.after(visible);
    }
    uiSetText(visible, UI_STATUS_LABEL[rawStatus]);
  });
}

function uiSetLabelText(label, value) {
  if (!label) return;
  const node = [...label.childNodes].find((item) => item.nodeType === Node.TEXT_NODE && item.textContent.trim());
  if (node && node.textContent !== value + ' ') node.textContent = value + ' ';
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
    const modalTitle = form.closest('.modal-card')?.querySelector('h2');
    if (modalTitle?.textContent.trim() === 'Новый пост') uiSetText(modalTitle, 'Новая публикация');
    const projectLabel = form.querySelector('select[name="projectId"]')?.closest('label');
    const modeSelect = form.querySelector('select[name="scheduleMode"]');
    const modeLabel = modeSelect?.closest('label');
    const scheduledInput = form.querySelector('input[name="scheduledAt"]');
    const scheduledLabel = scheduledInput?.closest('label');
    uiSetLabelText(projectLabel, 'Проект');
    uiSetLabelText(modeLabel, 'Когда публиковать');
    uiSetLabelText(scheduledLabel, 'Дата и время публикации');
    if (modeSelect && scheduledLabel && modeSelect.dataset.uiScheduleSync !== '1') {
      modeSelect.dataset.uiScheduleSync = '1';
      const sync = () => scheduledLabel.classList.toggle('hidden', modeSelect.value !== 'AT');
      modeSelect.addEventListener('change', sync);
      sync();
    }
    const firstField = form.querySelector('label');
    if (firstField) firstField.before(uiEditorSection('Основное', 'Проект, режим публикации, заголовок и текст.', '1'));
    const mediaInput = form.querySelector('#media-file');
    const mediaBlock = mediaInput?.closest('.full') || [...form.querySelectorAll('.full')].find((node) => node.querySelector('.media-list'));
    const targetPicker = form.querySelector('.target-picker');
    if (mediaBlock) {
      const heading = [...mediaBlock.children].find((node) => node.tagName === 'STRONG');
      uiSetText(heading, 'Медиа');
      if (mediaInput) {
        mediaBlock.before(uiEditorSection('Медиа', 'Добавьте изображения или видео и проверьте порядок файлов.', '2'));
      } else {
        mediaBlock.before(uiEditorSection('После сохранения', 'Сначала сохраните черновик — затем появятся загрузка медиа и выбор площадок.', '2'));
        const hint = mediaBlock.querySelector('.muted.small');
        uiSetText(hint, 'Сохраните черновик. После этого можно загрузить медиа и выбрать площадки.');
      }
    }
    const targetBlock = targetPicker?.closest('.full');
    if (targetBlock) targetBlock.before(uiEditorSection('Площадки', 'Выберите подключения, куда должна уйти публикация.', '3'));
  });
}

function uiPolishLibraryRoles(root = document) {
  if (window.location.pathname !== '/library') return;
  root.querySelectorAll('.library-badges, .library-table tbody td:nth-child(7)').forEach((group) => {
    const badges = group.querySelectorAll('.badge');
    if (badges[0]?.dataset.rawStatus) uiSetText(badges[0], `Контент · ${UI_STATUS_LABEL[badges[0].dataset.rawStatus] || badges[0].dataset.rawStatus}`);
    if (badges[1]?.dataset.rawStatus) uiSetText(badges[1], `Публикация · ${UI_STATUS_LABEL[badges[1].dataset.rawStatus] || badges[1].dataset.rawStatus}`);
  });
}

function uiPolishAll() {
  const view = document.querySelector('#view') || document;
  uiPolishStatuses(view);
  uiPolishCalendar(view);
  uiPolishLibrary(view);
  uiPolishContent(view);
  uiPolishPostEditor(document);
  uiPolishLibraryRoles(view);
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
