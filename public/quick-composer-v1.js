import { plainTextToRichDocument } from './rich-text-editor-v1.js';
import { createComposerRecovery } from './quick-composer-recovery-v1.js';

// The visible user operation is a single composer. Existing versioned APIs still
// create an immutable draft, upload media, select targets and run READY in order.
const PLATFORM_NAMES = { telegram: 'Telegram', vk: 'ВКонтакте', max: 'MAX', instagram: 'Instagram' };
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
let openDialog = null;

function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : 'Сервер ответил HTTP ' + response.status;
    const error = new Error(message);
    error.httpStatus = response.status;
    // Preserve the existing server's structured preflight diagnostics.
    // This is display-only metadata; authorization stays server-side.
    if (Array.isArray(data?.issues)) error.preflightIssues = data.issues;
    throw error;
  }
  return data;
}

function titleFromText(value) {
  const first = String(value).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || 'Публикация';
  return Array.from(first).slice(0, 90).join('');
}

function accountLabel(account) {
  let label = PLATFORM_NAMES[account.platform] || account.platform;
  label += ' · ' + account.name;
  if (account.platform === 'vk' && account.destination_kind === 'COMMUNITY') label += ' · сообщество';
  if (account.platform === 'vk' && account.destination_kind === 'PERSONAL') label += ' · личная страница';
  return label;
}

function readableError(error) {
  return error instanceof Error ? error.message : 'Не удалось выполнить операцию.';
}

export async function openQuickComposer() {
  if (openDialog) return;
  const overlay = document.createElement('div');
  overlay.className = 'qc-overlay';
  overlay.innerHTML = '<div class="qc-dialog" role="dialog" aria-modal="true" aria-labelledby="qc-title">' +
    '<header class="qc-head"><div><p class="qc-eyebrow">ОДНА ПУБЛИКАЦИЯ — НЕСКОЛЬКО ПЛОЩАДОК</p><h2 id="qc-title">Создать публикацию</h2></div>' +
    '<button id="qc-close" class="qc-icon-button" type="button" aria-label="Закрыть редактор">×</button></header>' +
    '<div class="qc-loading" role="status">Загрузка подключений…</div></div>';
  document.body.append(overlay);
  openDialog = overlay;
  document.body.classList.add('qc-open');

  let state = null;
  let recovery = null;
  const dispose = () => {
    if (state?.busy) return;
    if (state?.uncertainPublish && !window.confirm('Результат последней операции не подтверждён. Проверьте публикации перед повторной отправкой. Закрыть редактор?')) return;
    if (state?.dirty && !window.confirm('Есть несохранённые изменения. Закрыть редактор и потерять их?')) return;
    if (state?.pending) for (const image of state.pending) URL.revokeObjectURL(image.url);
    if (state?.video?.url) URL.revokeObjectURL(state.video.url);
    // Explicitly discarded unsaved content must not reappear on the next opening.
    // Keep recovery markers for interrupted/uncertain server operations.
    if (state && !state.savedId && !state.uncertainPublish) recovery?.clear();
    document.body.classList.remove('qc-target-sheet-open');
    overlay.remove();
    document.body.classList.remove('qc-open');
    openDialog = null;
  };
  overlay.querySelector('#qc-close').addEventListener('click', dispose);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) dispose(); });
  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || openDialog !== overlay) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (overlay.querySelector('#qc-target-picker')?.classList.contains('is-open')) {
      overlay.querySelector('#qc-target-done')?.click();
    } else {
      dispose();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  // A newly opened overlay owns its one keydown listener.
  const removeListenerWhenClosed = new MutationObserver(() => {
    if (overlay.isConnected) return;
    document.removeEventListener('keydown', onKeyDown);
    removeListenerWhenClosed.disconnect();
  });
  removeListenerWhenClosed.observe(document.body, { childList: true });

  try {
    const [projects, accounts, auth] = await Promise.all([
      request('/api/projects'), request('/api/accounts'), request('/api/auth/state')
    ]);
    if (!overlay.isConnected) return;
    recovery = createComposerRecovery(auth);
    state = {
      projects, accounts, pending: [], savedId: null, version: null,
      busy: false, finished: false, uncertainPublish: false, dirty: false,
      scheduleTimezone: null, scheduleMode: 'MANUAL', remoteMediaOrder: [],
      restoredScheduleTimezone: null, recoveryRequiredFiles: 0,
      video: null, recoveryRequiresVideo: false,
      previewToken: 0, previewLoading: false, previewRows: []
    };
    const available = accounts.filter((account) => account.enabled);
    const grouped = ['telegram', 'vk', 'max', 'instagram'].map((platform) => {
      const list = accounts.filter((account) => account.platform === platform);
      if (!list.length) return '';
      return '<section class="qc-account-group"><h4>' + html(PLATFORM_NAMES[platform]) +
        ' <span>' + list.filter((a) => a.enabled).length + ' доступно</span></h4>' +
        list.map((account) => '<label class="qc-account' + (account.enabled ? '' : ' is-disabled') + '">' +
          '<input type="checkbox" name="qc-account" value="' + html(account.id) + '"' +
          (account.enabled ? '' : ' disabled') + '><span>' + html(accountLabel(account)) + '</span>' +
          (account.enabled ? '' : '<small>Подключение отключено</small>') +
          '</label>').join('') + '</section>';
    }).join('');
    const projectOptions = projects.map((project) =>
      '<option value="' + html(project.id) + '">' + html(project.name) + '</option>').join('');
    overlay.querySelector('.qc-dialog').innerHTML =
      '<header class="qc-head"><div><p class="qc-eyebrow">ОДНА ПУБЛИКАЦИЯ — НЕСКОЛЬКО ПЛОЩАДОК</p>' +
        '<h2 id="qc-title">Создать публикацию</h2></div><button id="qc-close" class="qc-icon-button" type="button" aria-label="Закрыть редактор">×</button></header>' +
      '<div class="qc-main">' +
        '<section class="qc-editor"><label class="qc-label" for="qc-text">Текст публикации</label>' +
          '<textarea id="qc-text" rows="8" placeholder="Текст можно оставить пустым для поддерживаемых медиапубликаций. Заголовок не нужен." autofocus></textarea>' +
          '<span id="qc-recovery-note" class="qc-muted" role="status" aria-live="polite"></span>' +
          '<div id="qc-recovery-warning" class="qc-recovery-warning"><strong>Возможен уже сохранённый черновик</strong>' +
          '<p>Предыдущая операция прервалась. Проверьте список публикаций перед повторной отправкой.</p>' +
          '<a href="/content">Открыть публикации</a>' +
          '<button type="button" id="qc-start-new">Я проверил — начать новый материал</button></div>' +
          '<div id="qc-missing-media" class="qc-recovery-warning">' +
          '<strong>Фотографии из прежней вкладки отсутствуют</strong>' +
          '<p id="qc-missing-media-detail"></p>' +
          '<button type="button" id="qc-skip-recovered-media">Продолжить без прежних фотографий</button></div>' +
          '<div id="qc-missing-video" class="qc-recovery-warning">' +
          '<strong>Видео MP4 из прежней вкладки отсутствует</strong>' +
          '<p>Выберите MP4 снова или явно подтвердите отказ от него.</p>' +
          '<button type="button" id="qc-skip-recovered-video">Продолжить без прежнего видео</button></div>' +
          '<div class="qc-photo-head"><strong>Фотографии</strong><span class="qc-muted">До сохранения, перетаскиванием или Ctrl+V</span></div>' +
          '<label class="qc-drop" id="qc-drop"><input id="qc-files" type="file" accept="image/*" multiple>' +
          '<span class="qc-drop-icon" aria-hidden="true">+</span><strong>Добавить фото</strong><small>Выберите несколько изображений, перетащите или вставьте из буфера обмена</small></label>' +
          '<div id="qc-images" class="qc-images" aria-live="polite"></div>' +
          '<div class="qc-video-section"><div class="qc-photo-head"><strong>Видео MP4</strong>' +
          '<span class="qc-muted">Отдельно от фотографий · подпись зависит от площадки</span></div>' +
          '<label class="qc-drop qc-video-drop" id="qc-video-drop">' +
          '<input id="qc-video-file" type="file" accept="video/mp4">' +
          '<span class="qc-drop-icon" aria-hidden="true">▶</span><strong>Добавить MP4</strong>' +
          '<small>До сохранения · формат и доступность проверяет сервер</small></label>' +
          '<div id="qc-video-preview" class="qc-video-preview" aria-live="polite"></div></div>' +
          '<details class="qc-advanced"><summary>Дополнительно: проект и расписание</summary>' +
          '<div class="qc-options"><label>Проект (для организации материалов)<select id="qc-project">' +
          (projectOptions || '<option value="">Мои публикации — будет создан автоматически</option>') +
          '</select></label><label>Дата и время, если нужно запланировать<input id="qc-datetime" type="datetime-local"></label>' +
          '<p id="qc-timezone-note" class="qc-muted"></p><label>При повторяющемся времени (перевод часов)' +
          '<select id="qc-ambiguous"><option value="">Попросить уточнить</option><option value="earlier">Первое наступление времени</option>' +
          '<option value="later">Второе наступление времени</option></select></label></div></details>' +
        '</section>' +
        '<section class="qc-right"><div class="qc-target-head"><div><h3>Куда опубликовать</h3><p>Выберите любое количество ваших подключений</p></div>' +
        '<span class="qc-counter" id="qc-counter">0 выбрано</span></div>' +
        (available.length ? '<button type="button" id="qc-target-toggle" class="qc-target-toggle" aria-expanded="false" aria-controls="qc-target-picker">' +
          'Выбрать получателей <span aria-hidden="true">›</span></button>' +
          '<div class="qc-target-picker" id="qc-target-picker">' +
          '<header class="qc-target-sheet-head"><h4 id="qc-target-picker-title">Аккаунты и каналы</h4>' +
          '<button type="button" id="qc-target-done">Готово</button></header>' +
          '<div class="qc-target-actions"><button type="button" id="qc-select-all">Выбрать все</button>' +
          '<button type="button" id="qc-select-none">Снять выбор</button></div><div class="qc-accounts">' + grouped + '</div></div>'
          : '<div class="qc-empty">Нет активных подключений. Черновик можно сохранить и без них.' +
            '<a href="/socials" id="qc-connect">Перейти к подключению соцсетей</a></div>') +
        '<div class="qc-preview"><h4>Предпросмотр текста</h4><p id="qc-preview-text">Текст появится здесь</p>' +
          '<div id="qc-preview-targets" class="qc-muted">Площадки пока не выбраны</div>' +
          '<button id="qc-platform-preview-load" class="qc-platform-preview-load" type="button" disabled>' +
          'Предпросмотр до сохранения</button>' +
          '<div id="qc-platform-preview" class="qc-platform-preview" hidden>' +
          '<label for="qc-platform-preview-choice">Какой аккаунт посмотреть' +
          '<select id="qc-platform-preview-choice"></select></label>' +
          '<p id="qc-platform-preview-source" class="qc-platform-preview-source"></p>' +
          '<div id="qc-platform-preview-card"></div>' +
          '<p class="qc-muted">Ориентировочный внешний вид. Итоговую публикацию и разрешения проверяет сервер и сама площадка.</p>' +
          '</div></div></section></div>' +
      '<footer class="qc-footer"><div class="qc-feedback">' +
        '<div id="qc-status" role="status" aria-live="polite">Добавьте текст и выберите площадки. Необязательные настройки скрыты.</div>' +
        '<section class="qc-preflight-issues" id="qc-preflight-issues" role="alert" aria-label="Причины отказа по аккаунтам" hidden></section></div>' +
      '<div class="qc-buttons"><button type="button" id="qc-save" class="qc-subtle">Сохранить черновик</button>' +
      '<button type="button" id="qc-schedule" class="qc-subtle">Запланировать</button>' +
      '<button type="button" id="qc-send" class="qc-primary">Опубликовать сейчас</button></div></footer>';

    const root = overlay;
    const text = root.querySelector('#qc-text');
    const status = root.querySelector('#qc-status');
    const selectedIds = () => [...root.querySelectorAll('input[name="qc-account"]:checked')].map((input) => input.value);
    const checkedAccounts = () => state.accounts.filter((account) => selectedIds().includes(account.id));
    const pendingList = root.querySelector('#qc-images');
    const targetPicker = root.querySelector('#qc-target-picker');
    const targetToggle = root.querySelector('#qc-target-toggle');

    function closeTargetPicker() {
      if (!targetPicker?.classList.contains('is-open')) return;
      targetPicker.classList.remove('is-open');
      targetPicker.removeAttribute('role');
      targetPicker.removeAttribute('aria-modal');
      document.body.classList.remove('qc-target-sheet-open');
      targetToggle.setAttribute('aria-expanded', 'false');
      for (const element of root.querySelectorAll('.qc-head, .qc-editor, .qc-footer, .qc-preview')) {
        element.inert = false;
      }
      targetToggle.focus();
    }
    function openTargetPicker() {
      if (!targetPicker || state.busy || state.finished || state.uncertainPublish) return;
      if (!window.matchMedia('(max-width: 810px)').matches) return;
      targetPicker.classList.add('is-open');
      targetPicker.setAttribute('role', 'dialog');
      targetPicker.setAttribute('aria-modal', 'true');
      targetPicker.setAttribute('aria-labelledby', 'qc-target-picker-title');
      targetToggle.setAttribute('aria-expanded', 'true');
      document.body.classList.add('qc-target-sheet-open');
      for (const element of root.querySelectorAll('.qc-head, .qc-editor, .qc-footer, .qc-preview')) {
        element.inert = true;
      }
      root.querySelector('#qc-target-done').focus();
    }
    targetToggle?.addEventListener('click', openTargetPicker);
    root.querySelector('#qc-target-done')?.addEventListener('click', closeTargetPicker);
    targetPicker?.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || !targetPicker.classList.contains('is-open')) return;
      const items = [...targetPicker.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
        .filter((element) => element.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    const onWindowResize = () => {
      if (targetPicker?.classList.contains('is-open') &&
          !window.matchMedia('(max-width: 810px)').matches) closeTargetPicker();
    };
    window.addEventListener('resize', onWindowResize);
    const stopSheetResizeListener = new MutationObserver(() => {
      if (overlay.isConnected) return;
      window.removeEventListener('resize', onWindowResize);
      stopSheetResizeListener.disconnect();
    });
    stopSheetResizeListener.observe(document.body, { childList: true });

    function setStatus(message, error = false) {
      status.textContent = message;
      status.classList.toggle('is-error', error);
    }
    const preflightPanel = root.querySelector('#qc-preflight-issues');
    function clearPreflightIssues() {
      preflightPanel.replaceChildren();
      preflightPanel.hidden = true;
    }
    function showPreflightIssues(issues) {
      clearPreflightIssues();
      if (!Array.isArray(issues)) return false;
      const failures = issues.filter((issue) =>
        issue && typeof issue === 'object' && issue.severity === 'error' &&
        typeof issue.message === 'string' && issue.message.trim()
      ).slice(0, 100);
      if (!failures.length) return false;
      const title = document.createElement('strong');
      title.textContent = 'Не прошли проверку: ' + failures.length +
        '. Публикация не отправлялась.';
      const list = document.createElement('ul');
      for (const issue of failures) {
        const item = document.createElement('li');
        const account = document.createElement('strong');
        const platform = PLATFORM_NAMES[issue.platform] || String(issue.platform || 'Площадка');
        account.textContent = platform + ' · ' +
          (typeof issue.accountName === 'string' && issue.accountName.trim()
            ? issue.accountName : 'Подключение');
        const detail = document.createElement('span');
        detail.textContent = issue.message;
        item.append(account, detail);
        list.append(item);
      }
      preflightPanel.append(title, list);
      preflightPanel.hidden = false;
      return true;
    }
    const projectTimezone = (id) =>
      state.projects.find((project) => project.id === id)?.default_timezone || 'UTC';
    function showTimezone() {
      root.querySelector('#qc-timezone-note').textContent =
        'Время в часовом поясе ' + (state.savedId && state.scheduleMode === 'AT'
          ? state.scheduleTimezone || 'UTC'
          : (state.restoredScheduleTimezone || projectTimezone(root.querySelector('#qc-project').value))) + '.';
    }
    function setBusy(busy) {
      state.busy = busy;
      const locked = state.finished || state.uncertainPublish;
      root.querySelectorAll('input,textarea,select,button').forEach((element) => {
        const unavailable = element.matches('input[name="qc-account"]') &&
          !state.accounts.some((account) => account.id === element.value && account.enabled);
        const previewUnavailable = element.id === 'qc-platform-preview-load' &&
          (state.previewLoading || !selectedIds().length ||
            !(text.value.trim() || state.pending.length || state.video));
        element.disabled = busy || (locked && !['qc-close', 'qc-start-new'].includes(element.id)) ||
          unavailable || previewUnavailable ||
          (element.id === 'qc-project' && Boolean(state.savedId));
      });
      redrawPhotos();
      redrawVideo();
      updatePreviewButton();
    }
    const previewArea = root.querySelector('#qc-platform-preview');
    const previewChoice = root.querySelector('#qc-platform-preview-choice');
    const previewContent = root.querySelector('#qc-platform-preview-card');
    const previewButton = root.querySelector('#qc-platform-preview-load');
    const previewSource = root.querySelector('#qc-platform-preview-source');
    function updatePreviewButton() {
      const hasContent = Boolean(text.value.trim() || state.pending.length || state.video);
      previewButton.disabled = state.busy || state.finished || state.uncertainPublish ||
        state.previewLoading || selectedIds().length === 0 || !hasContent;
      previewButton.textContent = state.savedId && !state.dirty
        ? 'Посмотреть по площадкам' : 'Предпросмотр до сохранения';
    }
    const FORMAT_NAMES = {
      TEXT_ONLY: 'Только текст', IMAGE: 'Фотография', CAROUSEL: 'Карусель',
      VIDEO: 'Видео', VERTICAL_VIDEO: 'Вертикальное видео',
      STORY_SEQUENCE: 'Истории'
    };
    function clearPlatformPreview() {
      state.previewToken += 1;
      state.previewRows = [];
      previewArea.hidden = true;
      previewSource.textContent = '';
      previewChoice.replaceChildren();
      previewContent.replaceChildren();
    }
    function renderPlatformPreview() {
      previewContent.replaceChildren();
      const selected = state.previewRows.find((item) => item.targetId === previewChoice.value);
      if (!selected) return;
      const heading = document.createElement('strong');
      heading.textContent = (PLATFORM_NAMES[selected.platform] || selected.platform || 'Площадка') +
        ' · ' + (selected.accountName || 'Подключение');
      const format = document.createElement('span');
      format.className = 'qc-muted';
      format.textContent = FORMAT_NAMES[selected.contentFormat] || selected.contentFormat || 'Пост';
      const mediaGroup = document.createElement('div');
      mediaGroup.className = 'qc-platform-media';
      const media = Array.isArray(selected.media) ? selected.media.filter((item) => item.role !== 'poster') : [];
      for (const item of media) {
        if (typeof item.url !== 'string') continue;
        const trustedSource = selected.localDraft === true
          ? item.url.startsWith('blob:')
          : item.url.startsWith('/public-media/');
        if (!trustedSource) continue;
        let element;
        if (item.mimeType === 'video/mp4') {
          element = document.createElement('video');
          element.controls = true;
          element.preload = 'metadata';
          element.playsInline = true;
          if (typeof item.posterUrl === 'string' && item.posterUrl.startsWith('/public-media/')) {
            element.poster = item.posterUrl;
          }
        } else if (typeof item.mimeType === 'string' && item.mimeType.startsWith('image/')) {
          element = document.createElement('img');
          element.alt = 'Изображение для ' + (selected.accountName || 'площадки');
          element.loading = 'lazy';
        } else continue;
        element.src = item.url;
        mediaGroup.append(element);
      }
      const caption = document.createElement('p');
      caption.className = 'qc-platform-caption';
      caption.textContent = String(selected.text || '').trim() || 'Без подписи';
      previewContent.append(heading, format);
      if (selected.captionPlacement === 'above') previewContent.append(caption, mediaGroup);
      else previewContent.append(mediaGroup, caption);
      const issues = Array.isArray(selected.issues)
        ? selected.issues.filter((i) => i && ['error', 'warning'].includes(i.severity)) : [];
      if (issues.length) {
        const warningList = document.createElement('ul');
        warningList.className = 'qc-platform-notes';
        for (const issue of issues) {
          const row = document.createElement('li');
          row.textContent = String(issue.message || 'Проверьте требования площадки');
          warningList.append(row);
        }
        previewContent.append(warningList);
      }
    }
    function presentPreviewRows(rows, message) {
      state.previewRows = rows;
      previewChoice.replaceChildren();
      for (const item of state.previewRows) {
        const option = document.createElement('option');
        option.value = item.targetId;
        option.textContent = (PLATFORM_NAMES[item.platform] || item.platform || 'Площадка') +
          ' · ' + (item.accountName || 'Подключение');
        previewChoice.append(option);
      }
      previewSource.textContent = message;
      previewArea.hidden = false;
      if (state.previewRows.length) renderPlatformPreview();
      else previewContent.textContent = 'Нет выбранных получателей для предпросмотра.';
      previewArea.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
    function localPreviewRows() {
      // This is a visual approximation from operator-selected local files.
      // Never present it as a server-validated rendition or persist it via API.
      const images = state.pending.map((item, index) => ({
        url: item.url,
        mimeType: item.file.type,
        role: 'primary',
        order: index
      }));
      const media = state.video
        ? [{ url: state.video.url, mimeType: 'video/mp4', role: 'primary', order: 0 }]
        : images;
      const contentFormat = state.video ? 'VIDEO'
        : images.length > 1 ? 'CAROUSEL'
          : images.length ? 'IMAGE' : 'TEXT_ONLY';
      return checkedAccounts().map((account) => ({
        targetId: 'local:' + account.id,
        accountId: account.id,
        accountName: account.name,
        platform: account.platform,
        enabled: true,
        localDraft: true,
        captionPlacement: account.platform === 'vk' ? 'above' : 'below',
        contentFormat,
        text: text.value.trim(),
        media,
        issues: []
      }));
    }
    async function loadPlatformPreview() {
      if (state.busy || state.finished || state.uncertainPublish ||
          state.previewLoading || !selectedIds().length ||
          !(text.value.trim() || state.pending.length || state.video)) return;
      if (!state.savedId || state.dirty) {
        clearPlatformPreview();
        presentPreviewRows(localPreviewRows(),
          state.savedId
            ? 'Несохранённые изменения: локальный приблизительный вид. Для серверного предпросмотра сохраните черновик.'
            : 'До сохранения: локальный приблизительный вид. Сервер ещё не проверил текст, файлы и ограничения площадок.');
        updatePreviewButton();
        return;
      }
      state.previewLoading = true;
      const token = ++state.previewToken;
      previewButton.disabled = true;
      try {
        const response = await request('/api/posts/' + encodeURIComponent(state.savedId) + '/platform-previews');
        if (token !== state.previewToken || !overlay.isConnected || state.busy) return;
        if (!Array.isArray(response?.previews)) throw new Error('Сервер не вернул данные предпросмотра');
        presentPreviewRows(response.previews.filter((item) => item && item.enabled),
          'По сохранённой серверной версии. Это не подтверждение готовности к отправке.');
      } catch (error) {
        if (token === state.previewToken && overlay.isConnected) {
          previewArea.hidden = false;
          previewSource.textContent = '';
          previewContent.textContent = 'Не удалось получить предпросмотр: ' + readableError(error);
        }
      } finally {
        state.previewLoading = false;
        updatePreviewButton();
      }
    }
    previewButton.addEventListener('click', loadPlatformPreview);
    previewChoice.addEventListener('change', renderPlatformPreview);
    function markDirty() {
      if (state.busy || state.finished || state.uncertainPublish) return;
      clearPreflightIssues();
      clearPlatformPreview();
      state.dirty = true;
      updatePreviewButton();
      if (state.savedId || !recovery) return;
      const stored = recovery.saveLocalDraft({
        body: text.value,
        projectId: root.querySelector('#qc-project').value,
        scheduledAtLocal: root.querySelector('#qc-datetime').value,
        scheduleTimezone: state.restoredScheduleTimezone || projectTimezone(root.querySelector('#qc-project').value),
        ambiguousOffset: root.querySelector('#qc-ambiguous').value,
        accountIds: selectedIds(),
        // Unattached files from a restored draft remain required across text,
        // target and schedule edits, including another tab refresh.
        photoCount: Math.max(state.pending.length, state.recoveryRequiredFiles),
        videoRequired: Boolean(state.video || state.recoveryRequiresVideo)
      });
      root.querySelector('#qc-recovery-note').textContent = stored
        ? 'Текст и настройки временно сохранены в этой вкладке. Файлы после перезагрузки нужно выбрать заново.'
        : 'Локальное восстановление недоступно: сохраните черновик на сервере.';
    }
    function updateMissingFilesNotice() {
      const missing = Math.max(0, state.recoveryRequiredFiles - state.pending.length);
      root.querySelector('#qc-missing-media').classList.toggle('is-visible', missing > 0);
      root.querySelector('#qc-missing-media-detail').textContent =
        'Повторно добавьте ' + missing + ' фото или явно подтвердите отказ от них.';
      root.querySelector('#qc-missing-video').classList.toggle('is-visible',
        state.recoveryRequiresVideo && !state.video);
    }
    function syncMediaInputs() {
      const locked = state.busy || state.finished || state.uncertainPublish;
      const cannotAddPhotos = locked || Boolean(state.video) || state.recoveryRequiresVideo;
      const cannotAddVideo = locked || state.pending.length > 0 || Boolean(state.video) ||
        state.recoveryRequiredFiles > 0;
      root.querySelector('#qc-files').disabled = cannotAddPhotos;
      root.querySelector('#qc-video-file').disabled = cannotAddVideo;
      root.querySelector('#qc-drop').classList.toggle('is-disabled', cannotAddPhotos);
      root.querySelector('#qc-video-drop').classList.toggle('is-disabled', cannotAddVideo);
    }
    function updateCaptionPreview() {
      root.querySelector('#qc-preview-text').textContent = text.value.trim() ||
        (state.pending.length || state.video ? 'Без подписи' : 'Текст появится здесь');
    }
    function refreshPreview() {
      updateCaptionPreview();
      const labels = checkedAccounts().map(accountLabel);
      root.querySelector('#qc-counter').textContent = labels.length + ' выбрано';
      if (status.classList.contains('is-error') && !state.busy) setStatus('Проверьте текст и получателей перед сохранением.');
      root.querySelector('#qc-preview-targets').textContent = labels.length
        ? 'Получатели: ' + labels.join(', ') : 'Площадки пока не выбраны';
      updatePreviewButton();
    }
    function redrawPhotos() {
      pendingList.replaceChildren();
      updateMissingFilesNotice();
      state.pending.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = 'qc-image';
        const img = document.createElement('img');
        img.src = item.url;
        img.alt = item.file.name;
        const caption = document.createElement('span');
        caption.textContent = item.file.name;
        const controls = document.createElement('div');
        controls.className = 'qc-image-controls';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Удалить ' + item.file.name);
        remove.textContent = 'Удалить';
        remove.disabled = state.busy || state.finished || state.uncertainPublish;
        remove.addEventListener('click', async () => {
          if (state.busy || state.finished || state.uncertainPublish) return;
          if (item.uploaded && item.remoteId) {
            setBusy(true);
            try {
              const result = await request('/api/media/' + encodeURIComponent(item.remoteId),
                { method: 'DELETE', headers: { 'x-content-version': String(state.version) } });
              state.version = result.contentVersion;
              state.remoteMediaOrder = state.remoteMediaOrder.filter((id) => id !== item.remoteId);
            } catch (error) {
              setStatus(readableError(error), true);
              setBusy(false);
              return;
            }
            setBusy(false);
          }
          URL.revokeObjectURL(item.url);
          state.pending.splice(state.pending.indexOf(item), 1);
          markDirty();
          redrawPhotos();
        });
        controls.append(remove);
        const up = document.createElement('button');
        up.type = 'button'; up.textContent = '←'; up.setAttribute('aria-label', 'Переместить раньше');
        up.disabled = index === 0 || state.busy || state.finished || state.uncertainPublish;
        up.addEventListener('click', () => {
          if (state.busy || state.finished || state.uncertainPublish) return;
          [state.pending[index - 1], state.pending[index]] = [state.pending[index], state.pending[index - 1]];
          markDirty();
          redrawPhotos();
        });
        const down = document.createElement('button');
        down.type = 'button'; down.textContent = '→'; down.setAttribute('aria-label', 'Переместить позже');
        down.disabled = index === state.pending.length - 1 || state.busy || state.finished || state.uncertainPublish;
        down.addEventListener('click', () => {
          if (state.busy || state.finished || state.uncertainPublish) return;
          [state.pending[index + 1], state.pending[index]] = [state.pending[index], state.pending[index + 1]];
          markDirty();
          redrawPhotos();
        });
        controls.append(up, down);
        card.append(img, caption, controls);
        pendingList.append(card);
      });
      syncMediaInputs();
      updateCaptionPreview();
    }
    function addFiles(files) {
      if (state.busy || state.finished || state.uncertainPublish) return;
      if (state.video || state.recoveryRequiresVideo) {
        setStatus('Смешивание фото и видео не поддерживается. Сначала удалите MP4 либо отмените его восстановление.', true);
        return;
      }
      const currentKeys = new Set(state.pending.map((item) => item.file.name + ':' + item.file.size + ':' + item.file.lastModified));
      for (const file of files) {
        if (!file.type.startsWith('image/')) { setStatus('Выберите файлы изображений.', true); continue; }
        if (file.size > MAX_IMAGE_BYTES) { setStatus('Слишком большой файл: ' + file.name + ' (максимум 50 МБ).', true); continue; }
        const key = file.name + ':' + file.size + ':' + file.lastModified;
        if (currentKeys.has(key)) continue;
        currentKeys.add(key);
        state.pending.push({ file, url: URL.createObjectURL(file), uploaded: false, remoteId: null });
        markDirty();
      }
      redrawPhotos();
    }
    function redrawVideo() {
      const host = root.querySelector('#qc-video-preview');
      host.replaceChildren();
      updateMissingFilesNotice();
      if (!state.video) { syncMediaInputs(); updateCaptionPreview(); return; }
      const item = state.video;
      const card = document.createElement('div');
      card.className = 'qc-video-card';
      const preview = document.createElement('video');
      preview.controls = true;
      preview.muted = true;
      preview.playsInline = true;
      preview.preload = 'metadata';
      preview.src = item.url;
      preview.setAttribute('aria-label', 'Предпросмотр видео ' + item.file.name);
      const meta = document.createElement('div');
      meta.className = 'qc-video-meta';
      const title = document.createElement('strong');
      title.textContent = item.file.name;
      const size = document.createElement('span');
      const readableSize = item.file.size < 1024 * 1024
        ? (item.file.size / 1024).toFixed(1) + ' КБ'
        : (item.file.size / (1024 * 1024)).toFixed(1) + ' МБ';
      size.textContent = readableSize + ' · MP4' +
        (item.uploaded ? ' · загружено на сервер' : ' · ожидает сохранения');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Удалить видео';
      remove.setAttribute('aria-label', 'Удалить видео ' + item.file.name);
      remove.disabled = state.busy || state.finished || state.uncertainPublish;
      remove.addEventListener('click', async () => {
        if (state.busy || state.finished || state.uncertainPublish) return;
        if (item.uploaded && item.remoteId) {
          setBusy(true);
          try {
            const deleted = await request('/api/media/' + encodeURIComponent(item.remoteId), {
              method: 'DELETE', headers: { 'x-content-version': String(state.version) }
            });
            state.version = deleted.contentVersion;
          } catch (error) {
            setStatus(readableError(error), true);
            setBusy(false);
            return;
          }
          setBusy(false);
        }
        URL.revokeObjectURL(item.url);
        state.video = null;
        markDirty();
        redrawVideo();
      });
      meta.append(title, size, remove);
      card.append(preview, meta);
      host.append(card);
      syncMediaInputs();
      updateCaptionPreview();
    }
    root.querySelector('#qc-video-file').addEventListener('change', (event) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = '';
      if (!file || state.busy || state.finished || state.uncertainPublish) return;
      if (state.pending.length || state.recoveryRequiredFiles) {
        setStatus('Чтобы выбрать MP4, сначала удалите фотографии или завершите их восстановление.', true);
        return;
      }
      if (state.video) {
        setStatus('Сначала удалите ранее выбранное видео.', true);
        return;
      }
      if (file.type !== 'video/mp4' || !file.name.toLowerCase().endsWith('.mp4') || !file.size) {
        setStatus('Допустим непустой MP4 с MIME video/mp4. Другие видеоформаты не поддерживаются.', true);
        return;
      }
      state.video = { file, url: URL.createObjectURL(file), uploaded: false, remoteId: null };
      markDirty();
      redrawVideo();
      setStatus('Видео MP4 выбрано. Проверьте предпросмотр и сохраните черновик.');
    });
    root.querySelector('#qc-files').addEventListener('change', (event) => {
      addFiles(Array.from(event.currentTarget.files || []));
      event.currentTarget.value = '';
    });
    const drop = root.querySelector('#qc-drop');
    ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => {
      event.preventDefault(); drop.classList.add('is-dragging');
    }));
    ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, (event) => {
      event.preventDefault(); drop.classList.remove('is-dragging');
      if (name === 'drop') addFiles(Array.from(event.dataTransfer?.files || []));
    }));
    // Paste is handled only while the composer is open. Text-only clipboard
    // data is left to the browser, so normal text editing is unaffected.
    // Do not read navigator.clipboard or request persistent clipboard access.
    root.addEventListener('paste', (event) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      let images = Array.from(clipboard.items || [])
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!images.length) {
        images = Array.from(clipboard.files || [])
          .filter((file) => file.type.startsWith('image/'));
      }
      if (!images.length) return;
      event.preventDefault();
      const before = state.pending.length;
      addFiles(images);
      const added = state.pending.length - before;
      if (added > 0) {
        setStatus('Из буфера обмена добавлено изображений: ' + added +
          '. Проверьте порядок и сохраните публикацию.');
      }
    });
    root.querySelectorAll('input[name="qc-account"]').forEach((input) => input.addEventListener('change', () => {
      markDirty();
      refreshPreview();
    }));
    root.querySelector('#qc-select-all')?.addEventListener('click', () => {
      if (state.busy || state.finished || state.uncertainPublish) return;
      root.querySelectorAll('input[name="qc-account"]:not(:disabled)').forEach((input) => { input.checked = true; });
      markDirty();
      refreshPreview();
    });
    root.querySelector('#qc-select-none')?.addEventListener('click', () => {
      if (state.busy || state.finished || state.uncertainPublish) return;
      root.querySelectorAll('input[name="qc-account"]').forEach((input) => { input.checked = false; });
      markDirty();
      refreshPreview();
    });
    text.addEventListener('input', () => { markDirty(); refreshPreview(); });
    root.querySelector('#qc-project').addEventListener('change', () => {
      state.restoredScheduleTimezone = null;
      markDirty();
      showTimezone();
    });
    root.querySelector('#qc-datetime').addEventListener('change', markDirty);
    root.querySelector('#qc-ambiguous').addEventListener('change', markDirty);
    refreshPreview();
    showTimezone();
    redrawVideo();
    root.querySelector('#qc-close').addEventListener('click', dispose);
    root.querySelector('#qc-skip-recovered-media').addEventListener('click', () => {
      if (state.busy || state.finished || state.uncertainPublish) return;
      if (!window.confirm('Вы больше не хотите добавлять прежние фотографии? Публикация будет без них.')) return;
      state.recoveryRequiredFiles = 0;
      updateMissingFilesNotice();
      markDirty();
      setStatus('Подтверждено: продолжить без фотографий из предыдущей сессии.');
    });
    root.querySelector('#qc-skip-recovered-video').addEventListener('click', () => {
      if (state.busy || state.finished || state.uncertainPublish) return;
      if (!window.confirm('Вы отказываетесь от видео из прежней вкладки? Публикация будет без него.')) return;
      state.recoveryRequiresVideo = false;
      updateMissingFilesNotice();
      markDirty();
      syncMediaInputs();
      setStatus('Подтверждено: продолжить без видео из предыдущей сессии.');
    });
    root.querySelector('#qc-connect')?.addEventListener('click', (event) => {
      event.preventDefault();
      if (state.busy) return;
      if (state.dirty && !window.confirm('Есть несохранённые изменения. Перейти к подключению соцсетей и потерять их?')) return;
      window.location.assign('/socials');
    });

    function snapshotOperation(action, chosen) {
      const projectId = root.querySelector('#qc-project').value;
      const mode = action === 'schedule' ? 'AT' : 'MANUAL';
      const scheduledAtLocal = root.querySelector('#qc-datetime').value;
      const ambiguousOffset = root.querySelector('#qc-ambiguous').value;
      return Object.freeze({
        action, mode, projectId, scheduledAtLocal, ambiguousOffset,
        scheduleTimezone: mode === 'AT'
          ? (state.savedId && state.scheduleMode === 'AT' && state.scheduleTimezone
            ? state.scheduleTimezone : (state.restoredScheduleTimezone || projectTimezone(projectId)))
          : null,
        body: text.value.trim(),
        accountIds: Object.freeze(chosen.map((account) => account.id)),
        images: Object.freeze([...state.pending]),
        video: state.video
      });
    }

    function createPayload(projectId, operation) {
      const payload = {
        projectId, title: titleFromText(operation.body), body: operation.body,
        bodyRich: plainTextToRichDocument(operation.body),
        contentFormat: operation.images.length || operation.video ? 'MEDIA' : 'TEXT_ONLY',
        scheduleMode: operation.mode
      };
      if (operation.mode === 'AT') {
        if (!operation.scheduledAtLocal) throw new Error('Укажите дату и время публикации.');
        payload.scheduledAtLocal = operation.scheduledAtLocal;
        payload.scheduleTimezone = operation.scheduleTimezone || 'UTC';
        if (operation.ambiguousOffset) payload.ambiguousOffset = operation.ambiguousOffset;
      }
      return payload;
    }

    async function ensureProject(operation) {
      if (operation.projectId) return operation.projectId;
      const created = await request('/api/projects', {
        method: 'POST', body: JSON.stringify({ name: 'Мои публикации', slug: 'my-publications' })
      });
      state.projects.push(created);
      // The project is an internal scope; never ask the operator to create it manually.
      const select = root.querySelector('#qc-project');
      select.innerHTML = '<option value="' + html(created.id) + '">Мои публикации</option>';
      showTimezone();
      return created.id;
    }

    async function persistDraft(operation) {
      const projectId = await ensureProject(operation);
      const payload = createPayload(projectId, operation);
      if (!state.savedId) {
        // If the create response is lost, do not repeat blindly: the server may
        // have committed the draft. The operator can inspect /content safely.
        // Session marker must be durable before the network operation starts.
        // A reload while POST is still pending may leave a committed server draft.
        if (!recovery?.saveUncertain()) {
          throw new Error('Временное хранилище браузера недоступно. Отправка остановлена для защиты от дублирования.');
        }
        let created;
        try {
          created = await request('/api/posts', { method: 'POST', body: JSON.stringify(payload) });
        } catch (error) {
          const rejected = Number.isInteger(error?.httpStatus) &&
            error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 429].includes(error.httpStatus);
          state.uncertainPublish = !rejected;
          if (rejected) {
            recovery.saveLocalDraft({
              body: operation.body, projectId: operation.projectId,
              scheduledAtLocal: operation.scheduledAtLocal,
              scheduleTimezone: operation.scheduleTimezone,
              ambiguousOffset: operation.ambiguousOffset,
              accountIds: operation.accountIds, photoCount: operation.images.length,
              videoRequired: Boolean(operation.video || state.recoveryRequiresVideo)
            });
          } else {
            recovery.saveUncertain();
          }
          throw new Error('Не удалось подтвердить создание черновика. Проверьте список публикаций, чтобы избежать дубля. ' + readableError(error));
        }
        state.savedId = created.id;
        state.version = created.content_version;
        recovery?.saveServerDraft(created.id);
      } else {
        const updated = await request('/api/posts/' + encodeURIComponent(state.savedId), {
          method: 'PATCH', body: JSON.stringify({ ...payload, expectedContentVersion: state.version })
        });
        state.version = updated.contentVersion;
      }
      state.scheduleMode = operation.mode;
      state.scheduleTimezone = operation.scheduleTimezone;
      const updatedTargets = await request('/api/posts/' + encodeURIComponent(state.savedId) + '/targets', {
        method: 'PUT',
        body: JSON.stringify({ accountIds: operation.accountIds, expectedContentVersion: state.version })
      });
      state.version = updatedTargets.contentVersion;
      const appliedIds = Array.isArray(updatedTargets.targets)
        ? updatedTargets.targets.filter((target) => target.enabled).map((target) => target.account_id)
        : null;
      if (!appliedIds || appliedIds.length !== operation.accountIds.length ||
          appliedIds.some((id) => !operation.accountIds.includes(id))) {
        throw new Error('Сохранённые получатели отличаются от подтверждённых. Отправка остановлена.');
      }

      const nextOrder = [];
      state.lastDeduplicatedCount = 0;
      for (const item of operation.images) {
        if (!item.uploaded) {
          setStatus('Загружаю: ' + item.file.name);
          const data = new FormData();
          data.set('file', item.file);
          const saved = await request('/api/posts/' + encodeURIComponent(state.savedId) + '/media', {
            method: 'POST', body: data, headers: { 'x-content-version': String(state.version) }
          });
          item.remoteId = saved.id;
          item.uploaded = true;
          state.version = saved.contentVersion;
        }
        if (!item.remoteId) throw new Error('Не удалось подтвердить загрузку изображения.');
        if (nextOrder.includes(item.remoteId)) {
          // A confirmed duplicate consumes one of the original lost-file slots.
          // If a later media upload fails, a retry must remain possible even
          // though the server has normalized two files into a single media ID.
          state.recoveryRequiredFiles = Math.max(0, state.recoveryRequiredFiles - 1);
          // The server deduplicates identical normalized image bytes, not file names.
          // Keep one local card per persisted media ID so order/delete stay consistent.
          const index = state.pending.indexOf(item);
          if (index !== -1) state.pending.splice(index, 1);
          URL.revokeObjectURL(item.url);
          state.lastDeduplicatedCount += 1;
          continue;
        }
        nextOrder.push(item.remoteId);
      }
      if (nextOrder.join('\u0000') !== state.remoteMediaOrder.join('\u0000')) {
        const reordered = await request('/api/posts/' + encodeURIComponent(state.savedId) + '/media-order', {
          method: 'PUT',
          body: JSON.stringify({ mediaIds: nextOrder, expectedContentVersion: state.version })
        });
        state.version = reordered.contentVersion;
        state.remoteMediaOrder = [...nextOrder];
      }
      if (operation.video && !operation.video.uploaded) {
        // A completed MP4 POST may have a lost response; never retry it blindly.
        if (!recovery?.saveServerDraft(state.savedId)) {
          throw new Error('Не удалось сохранить защитную запись загрузки MP4. Операция остановлена.');
        }
        setStatus('Загружаю видео: ' + operation.video.file.name);
        const data = new FormData();
        data.set('file', operation.video.file);
        let uploaded;
        try {
          uploaded = await request('/api/posts/' + encodeURIComponent(state.savedId) + '/video', {
            method: 'POST', body: data, headers: { 'x-content-version': String(state.version) }
          });
        } catch (error) {
          if (!Number.isInteger(error?.httpStatus) || error.httpStatus >= 500 ||
              [408, 429].includes(error.httpStatus)) {
            state.uncertainPublish = true;
            throw new Error('Результат загрузки MP4 неизвестен. Проверьте публикацию и вложения перед повтором: ' +
              readableError(error));
          }
          throw error;
        }
        operation.video.remoteId = uploaded.id;
        operation.video.uploaded = true;
        state.version = uploaded.contentVersion;
        redrawVideo();
      }
      state.recoveryRequiresVideo = false;
      // The transient recovery requirement protects only the initial rebuild
      // of a lost local media selection. Once all files are persisted, any
      // server deduplication or later explicit deletion must not revive it.
      state.recoveryRequiredFiles = 0;
      updateMissingFilesNotice();
      return state.savedId;
    }

    async function execute(action) {
      if (state.busy || state.uncertainPublish || state.finished) return;
      const chosen = checkedAccounts();
      const operation = snapshotOperation(action, chosen);
      if (state.recoveryRequiredFiles > state.pending.length) {
        updateMissingFilesNotice();
        setStatus('Снова приложите фотографии или подтвердите продолжение без них.', true);
        return;
      }
      if (state.recoveryRequiresVideo && !operation.video) {
        updateMissingFilesNotice();
        setStatus('Снова выберите MP4 или явно подтвердите отказ от прежнего видео.', true);
        return;
      }
      if (operation.video && operation.images.length) {
        setStatus('Смешивание фотографий и видео не поддерживается. Выберите один тип вложений.', true);
        return;
      }
      if (!operation.body && !operation.images.length && !operation.video) {
        setStatus('Добавьте текст, фотографии или MP4.', true);
        text.focus();
        return;
      }
      if (action !== 'save' && !operation.accountIds.length) {
        setStatus('Выберите хотя бы одно подключение.', true); return;
      }
      if (action === 'schedule' && !operation.scheduledAtLocal) {
        root.querySelector('.qc-advanced').open = true;
        setStatus('Чтобы запланировать, укажите дату и время в дополнительных настройках.', true);
        root.querySelector('#qc-datetime').focus();
        return;
      }
      if (action !== 'save') {
        const what = action === 'send' ? 'Опубликовать сейчас' : 'Запланировать публикацию';
        if (!window.confirm(what + ' в ' + chosen.length + ' выбранных подключениях?\n\n' +
          chosen.map(accountLabel).join('\n') + '\n\nПроверьте текст и фотографии.')) return;
      }
      clearPreflightIssues();
      clearPlatformPreview();
      setBusy(true);
      try {
        setStatus('Сохраняю публикацию…');
        const id = await persistDraft(operation);
        if (action !== 'save') {
          // A preceding Save clears its old recovery record. Restore the
          // durable server-draft guard before READY/schedule/publish operations.
          // A tab refresh or lost /publish-now response cannot silently bypass
          // reconciliation and cause a duplicate public post.
          if (!recovery?.saveServerDraft(id)) {
            throw new Error('Не удалось сохранить защитную запись операции. Публикация остановлена во избежание дублирования.');
          }
          setStatus('Проверяю права и форматы для выбранных площадок…');
          const ready = await request('/api/posts/' + encodeURIComponent(id) + '/ready', {
            method: 'POST', body: JSON.stringify({ expectedContentVersion: state.version })
          });
          state.version = ready.contentVersion;
          if (action === 'send') {
            setStatus('Отправляю на выбранные площадки…');
            // Once POST starts, an HTTP timeout is ambiguous. Never send twice automatically.
            state.uncertainPublish = true;
            const sent = await request('/api/posts/' + encodeURIComponent(id) + '/publish-now', { method: 'POST' });
            state.uncertainPublish = false;
            state.dirty = false;
            state.finished = true;
            setStatus('Публикация обработана: ' + (sent.post?.status || 'статус уточняется') +
              '. Откройте список публикаций для результатов по каждой площадке.');
          } else {
            state.dirty = false;
            state.finished = true;
            setStatus('Публикация запланирована. Её статус можно проверить в списке публикаций.');
          }
        } else {
          state.dirty = false;
          setStatus('Черновик сохранён со всеми выбранными медиафайлами и получателями.' +
            (state.lastDeduplicatedCount ? ' Одинаковые изображения объединены: ' + state.lastDeduplicatedCount + '.' : ''));
        }
        recovery?.clear();
        root.querySelector('#qc-recovery-note').textContent = '';
        root.querySelector('#qc-close').textContent = '×';
        root.querySelector('#qc-close').setAttribute('aria-label', 'Закрыть редактор');
      } catch (error) {
        if (state.uncertainPublish && !state.savedId) {
          root.querySelector('#qc-recovery-warning').classList.add('is-visible');
        }
        const hasTargetFailures = showPreflightIssues(error?.preflightIssues);
        const explanation = hasTargetFailures
          ? 'Проверка готовности не пройдена. Исправьте ошибки аккаунтов ниже.'
          : readableError(error);
        setStatus(explanation + (state.savedId ? ' Черновик сохранён: откройте список публикаций при необходимости.' : ''), true);
      } finally {
        setBusy(false);
      }
    }

    root.querySelector('#qc-save').addEventListener('click', () => execute('save'));
    root.querySelector('#qc-schedule').addEventListener('click', () => execute('schedule'));
    root.querySelector('#qc-send').addEventListener('click', () => execute('send'));

    root.querySelector('#qc-start-new').addEventListener('click', () => {
      if (!state.uncertainPublish || state.busy) return;
      if (!window.confirm('Вы проверили список публикаций и убедились, что новый материал не дублирует уже сохранённый? Начать новый материал?')) return;
      recovery?.clear();
      state.uncertainPublish = false;
      root.querySelector('#qc-recovery-warning').classList.remove('is-visible');
      setBusy(false);
      setStatus('Начат новый материал. Предыдущий черновик не изменён.');
      text.focus();
    });
    const previous = recovery?.read();
    if (previous?.kind === 'local') {
      if (window.confirm('Есть незавершённая публикация в этой вкладке. Восстановить текст и получателей?' +
          (previous.photoCount ? '\\nФотографии потребуется добавить заново.' : '') +
          (previous.videoRequired ? '\\nMP4 потребуется выбрать заново.' : ''))) {
        text.value = typeof previous.body === 'string' ? previous.body : '';
        const project = root.querySelector('#qc-project');
        if ([...project.options].some((option) => option.value === previous.projectId)) project.value = previous.projectId;
        const datetime = root.querySelector('#qc-datetime');
        if (typeof previous.scheduledAtLocal === 'string') datetime.value = previous.scheduledAtLocal;
        if (['earlier', 'later'].includes(previous.ambiguousOffset)) {
          root.querySelector('#qc-ambiguous').value = previous.ambiguousOffset;
        }
        const validIds = new Set(Array.isArray(previous.accountIds) ? previous.accountIds : []);
        root.querySelectorAll('input[name="qc-account"]').forEach((input) => {
          input.checked = !input.disabled && validIds.has(input.value);
        });
        state.dirty = true;
        if (typeof previous.scheduleTimezone === 'string' && previous.scheduleTimezone) {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: previous.scheduleTimezone });
            state.restoredScheduleTimezone = previous.scheduleTimezone;
          } catch {
            root.querySelector('#qc-recovery-note').textContent =
              'Часовой пояс не удалось восстановить. Проверьте расписание перед отправкой.';
          }
        }
        state.recoveryRequiredFiles = Math.max(0, Number(previous.photoCount) || 0);
        state.recoveryRequiresVideo = Boolean(previous.videoRequired);
        updateMissingFilesNotice();
        syncMediaInputs();
        refreshPreview();
        showTimezone();
        setStatus(previous.photoCount
          ? 'Текст и получатели восстановлены. Добавьте фотографии заново перед публикацией.'
          : previous.videoRequired
            ? 'Текст и получатели восстановлены. Снова выберите MP4 перед публикацией.'
            : 'Восстановлены текст, получатели и настройки времени.');
      } else {
        recovery.clear();
      }
    } else if (previous?.kind === 'server-draft' || previous?.kind === 'uncertain') {
      state.uncertainPublish = true;
      root.querySelector('#qc-recovery-warning').classList.add('is-visible');
      setBusy(false);
      setStatus('Обнаружена незавершённая серверная операция. Сначала проверьте список публикаций.', true);
    }
    text.focus();
  } catch (error) {
    if (overlay.isConnected) {
      const message = overlay.querySelector('.qc-loading');
      if (message) {
        message.textContent = 'Не удалось открыть редактор: ' + readableError(error);
        message.classList.add('is-error');
      }
    }
  }
}

document.addEventListener('click', (event) => {
  const button = event.target instanceof Element
    ? event.target.closest('#quick-compose-nav, #quick-new-post, #dashboard-quick-new-post') : null;
  if (!button) return;
  event.preventDefault();
  openQuickComposer();
});

window.PublikatorQuickComposer = { open: openQuickComposer };
