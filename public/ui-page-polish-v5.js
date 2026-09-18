import { STATUS_LABELS, statusLabel } from './presentation-labels.js';

const UI_SCHEDULE_LABEL = { MANUAL: 'Вручную', QUEUE: 'Очередь', AT: 'По времени' };
let uiPolishTimer = null;

function uiSetText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function uiPolishStatuses(root = document) {
  const preserveContentStatus = window.location.pathname === '/content';
  root.querySelectorAll('.badge').forEach((badge) => {
    if (badge.dataset.presentationOwner === 'library') return;
    const raw = badge.dataset.rawStatus || badge.textContent.trim();
    if (!badge.dataset.rawStatus && STATUS_LABELS[raw]) badge.dataset.rawStatus = raw;
    const key = badge.dataset.rawStatus;
    if (key && STATUS_LABELS[key] && !preserveContentStatus) uiSetText(badge, statusLabel(key));
  });
  root.querySelectorAll('.operator-classification').forEach((chip) => {
    const raw = chip.dataset.rawClassification || chip.textContent.trim();
    if (!chip.dataset.rawClassification && STATUS_LABELS[raw]) chip.dataset.rawClassification = raw;
    if (chip.dataset.rawClassification) uiSetText(chip, statusLabel(chip.dataset.rawClassification));
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
    for (const [raw, label] of Object.entries(STATUS_LABELS)) text = text.replace(new RegExp(`\\b${raw}\\b`, 'g'), label);
    text = text.replace(/schedule\s+/gi, 'план: ').replace(/display\s+/gi, 'просмотр: ');
    uiSetText(node, text);
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
    if (!STATUS_LABELS[rawStatus]) return;
    if (!badge.dataset.rawStatus) badge.dataset.rawStatus = rawStatus;
    badge.classList.add('ui-internal-status');
    let visible = badge.nextElementSibling;
    if (!visible?.classList.contains('ui-human-status')) {
      visible = document.createElement('span');
      visible.className = `badge ui-human-status ${rawStatus}`;
      badge.after(visible);
    }
    uiSetText(visible, statusLabel(rawStatus));
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

function uiPolishAll() {
  const view = document.querySelector('#view') || document;
  uiPolishStatuses(view);
  uiPolishCalendar(view);
  uiPolishContent(view);
  uiPolishPostEditor(document);
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
