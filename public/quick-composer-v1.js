import { plainTextToRichDocument } from './rich-text-editor-v1.js';

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
  const dispose = () => {
    if (state?.busy) return;
    if (state?.uncertainPublish && !window.confirm('Результат последней операции не подтверждён. Проверьте публикации перед повторной отправкой. Закрыть редактор?')) return;
    if (state?.dirty && !window.confirm('Есть несохранённые изменения. Закрыть редактор и потерять их?')) return;
    if (state?.pending) for (const image of state.pending) URL.revokeObjectURL(image.url);
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
    dispose();
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
    const [projects, accounts] = await Promise.all([request('/api/projects'), request('/api/accounts')]);
    if (!overlay.isConnected) return;
    state = {
      projects, accounts, pending: [], savedId: null, version: null,
      busy: false, finished: false, uncertainPublish: false, dirty: false,
      scheduleTimezone: null, scheduleMode: 'MANUAL', remoteMediaOrder: []
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
          '<textarea id="qc-text" rows="8" placeholder="Напишите то, что увидят подписчики. Заголовок не нужен." autofocus></textarea>' +
          '<div class="qc-photo-head"><strong>Фотографии</strong><span class="qc-muted">Можно добавить сразу, до сохранения</span></div>' +
          '<label class="qc-drop" id="qc-drop"><input id="qc-files" type="file" accept="image/*" multiple>' +
          '<span class="qc-drop-icon" aria-hidden="true">+</span><strong>Добавить фото</strong><small>Выберите несколько изображений или перетащите сюда</small></label>' +
          '<div id="qc-images" class="qc-images" aria-live="polite"></div>' +
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
        (available.length ? '<div class="qc-target-actions"><button type="button" id="qc-select-all">Выбрать все</button>' +
          '<button type="button" id="qc-select-none">Снять выбор</button></div><div class="qc-accounts">' + grouped + '</div>'
          : '<div class="qc-empty">Нет активных подключений. Черновик можно сохранить и без них.' +
            '<a href="/socials" id="qc-connect">Перейти к подключению соцсетей</a></div>') +
        '<div class="qc-preview"><h4>Предпросмотр текста</h4><p id="qc-preview-text">Текст появится здесь</p>' +
          '<div id="qc-preview-targets" class="qc-muted">Площадки пока не выбраны</div></div></section></div>' +
      '<footer class="qc-footer"><div id="qc-status" role="status" aria-live="polite">Добавьте текст и выберите площадки. Необязательные настройки скрыты.</div>' +
      '<div class="qc-buttons"><button type="button" id="qc-save" class="qc-subtle">Сохранить черновик</button>' +
      '<button type="button" id="qc-schedule" class="qc-subtle">Запланировать</button>' +
      '<button type="button" id="qc-send" class="qc-primary">Опубликовать сейчас</button></div></footer>';

    const root = overlay;
    const text = root.querySelector('#qc-text');
    const status = root.querySelector('#qc-status');
    const selectedIds = () => [...root.querySelectorAll('input[name="qc-account"]:checked')].map((input) => input.value);
    const checkedAccounts = () => state.accounts.filter((account) => selectedIds().includes(account.id));
    const pendingList = root.querySelector('#qc-images');

    function setStatus(message, error = false) {
      status.textContent = message;
      status.classList.toggle('is-error', error);
    }
    const projectTimezone = (id) =>
      state.projects.find((project) => project.id === id)?.default_timezone || 'UTC';
    function showTimezone() {
      root.querySelector('#qc-timezone-note').textContent =
        'Время в часовом поясе ' + (state.savedId && state.scheduleMode === 'AT'
          ? state.scheduleTimezone || 'UTC'
          : projectTimezone(root.querySelector('#qc-project').value)) + '.';
    }
    function setBusy(busy) {
      state.busy = busy;
      const locked = state.finished || state.uncertainPublish;
      root.querySelectorAll('input,textarea,select,button').forEach((element) => {
        element.disabled = busy || (locked && element.id !== 'qc-close') ||
          (element.id === 'qc-project' && Boolean(state.savedId));
      });
      redrawPhotos();
    }
    function markDirty() {
      if (!state.busy && !state.finished && !state.uncertainPublish) state.dirty = true;
    }
    function refreshPreview() {
      root.querySelector('#qc-preview-text').textContent = text.value.trim() || 'Текст появится здесь';
      const labels = checkedAccounts().map(accountLabel);
      root.querySelector('#qc-counter').textContent = labels.length + ' выбрано';
      if (status.classList.contains('is-error') && !state.busy) setStatus('Проверьте текст и получателей перед сохранением.');
      root.querySelector('#qc-preview-targets').textContent = labels.length
        ? 'Получатели: ' + labels.join(', ') : 'Площадки пока не выбраны';
    }
    function redrawPhotos() {
      pendingList.replaceChildren();
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
    }
    function addFiles(files) {
      if (state.busy || state.finished || state.uncertainPublish) return;
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
    root.querySelector('#qc-project').addEventListener('change', () => { markDirty(); showTimezone(); });
    root.querySelector('#qc-datetime').addEventListener('change', markDirty);
    root.querySelector('#qc-ambiguous').addEventListener('change', markDirty);
    refreshPreview();
    showTimezone();
    root.querySelector('#qc-close').addEventListener('click', dispose);
    root.querySelector('#qc-connect')?.addEventListener('click', (event) => {
      event.preventDefault(); window.location.assign('/socials');
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
            ? state.scheduleTimezone : projectTimezone(projectId))
          : null,
        body: text.value.trim(),
        accountIds: Object.freeze(chosen.map((account) => account.id)),
        images: Object.freeze([...state.pending])
      });
    }

    function createPayload(projectId, operation) {
      const payload = {
        projectId, title: titleFromText(operation.body), body: operation.body,
        bodyRich: plainTextToRichDocument(operation.body),
        contentFormat: operation.images.length ? 'MEDIA' : 'TEXT_ONLY',
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
        let created;
        try {
          created = await request('/api/posts', { method: 'POST', body: JSON.stringify(payload) });
        } catch (error) {
          state.uncertainPublish = !Number.isInteger(error?.httpStatus);
          throw new Error('Не удалось подтвердить создание черновика. Проверьте список публикаций, чтобы избежать дубля. ' + readableError(error));
        }
        state.savedId = created.id;
        state.version = created.content_version;
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

      for (const item of operation.images) {
        if (item.uploaded) continue;
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
      const nextOrder = operation.images.map((item) => item.remoteId);
      if (nextOrder.some((id) => !id)) throw new Error('Не удалось подтвердить загрузку всех изображений.');
      if (nextOrder.join('\u0000') !== state.remoteMediaOrder.join('\u0000')) {
        const reordered = await request('/api/posts/' + encodeURIComponent(state.savedId) + '/media-order', {
          method: 'PUT',
          body: JSON.stringify({ mediaIds: nextOrder, expectedContentVersion: state.version })
        });
        state.version = reordered.contentVersion;
        state.remoteMediaOrder = [...nextOrder];
      }
      return state.savedId;
    }

    async function execute(action) {
      if (state.busy || state.uncertainPublish || state.finished) return;
      const chosen = checkedAccounts();
      const operation = snapshotOperation(action, chosen);
      if (!operation.body) { setStatus('Напишите текст публикации.', true); text.focus(); return; }
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
      setBusy(true);
      try {
        setStatus('Сохраняю публикацию…');
        const id = await persistDraft(operation);
        if (action !== 'save') {
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
            state.finished = true;
            setStatus('Публикация обработана: ' + (sent.post?.status || 'статус уточняется') +
              '. Откройте список публикаций для результатов по каждой площадке.');
          } else {
            state.finished = true;
            setStatus('Публикация запланирована. Её статус можно проверить в списке публикаций.');
          }
        } else {
          state.dirty = false;
          setStatus('Черновик сохранён со всеми выбранными изображениями и площадками.');
        }
        root.querySelector('#qc-close').textContent = 'Закрыть';
        root.querySelector('#qc-close').setAttribute('aria-label', 'Закрыть редактор');
      } catch (error) {
        setStatus(readableError(error) + (state.savedId ? ' Черновик сохранён: откройте список публикаций при необходимости.' : ''), true);
      } finally {
        setBusy(false);
      }
    }

    root.querySelector('#qc-save').addEventListener('click', () => execute('save'));
    root.querySelector('#qc-schedule').addEventListener('click', () => execute('schedule'));
    root.querySelector('#qc-send').addEventListener('click', () => execute('send'));
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
