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
    throw new Error(message);
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
    if (state?.savedId && !state?.finished &&
        !window.confirm('Черновик сохранён, но операция не завершена. Закрыть редактор?')) return;
    if (state?.pending) for (const image of state.pending) URL.revokeObjectURL(image.url);
    overlay.remove();
    document.body.classList.remove('qc-open');
    openDialog = null;
  };
  overlay.querySelector('#qc-close').addEventListener('click', dispose);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) dispose(); });
  const onKeyDown = (event) => { if (event.key === 'Escape' && !state?.busy && openDialog === overlay) dispose(); };
  document.addEventListener('keydown', onKeyDown);
  const originalDispose = dispose;
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
      busy: false, finished: false, uncertainPublish: false
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
          '<span class="qc-drop-icon">＋</span><strong>Добавить фото</strong><small>Выберите несколько изображений или перетащите сюда</small></label>' +
          '<div id="qc-images" class="qc-images" aria-live="polite"></div>' +
          '<details class="qc-advanced"><summary>Дополнительно: проект и расписание</summary>' +
          '<div class="qc-options"><label>Проект (для организации материалов)<select id="qc-project">' +
          (projectOptions || '<option value="">Мои публикации — будет создан автоматически</option>') +
          '</select></label><label>Дата и время, если нужно запланировать<input id="qc-datetime" type="datetime-local"></label></div></details>' +
        '</section>' +
        '<aside class="qc-right"><div class="qc-target-head"><div><h3>Куда опубликовать</h3><p>Выберите любое количество ваших подключений</p></div>' +
        '<span class="qc-counter" id="qc-counter">0 выбрано</span></div>' +
        (available.length ? '<div class="qc-target-actions"><button type="button" id="qc-select-all">Выбрать все</button>' +
          '<button type="button" id="qc-select-none">Снять выбор</button></div><div class="qc-accounts">' + grouped + '</div>'
          : '<div class="qc-empty">Нет активных подключений. Черновик можно сохранить и без них.' +
            '<a href="/socials" id="qc-connect">Перейти к подключению соцсетей</a></div>') +
        '<div class="qc-preview"><h4>Предпросмотр текста</h4><p id="qc-preview-text">Текст появится здесь</p>' +
          '<div id="qc-preview-targets" class="qc-muted">Площадки пока не выбраны</div></div></aside></div>' +
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
    function refreshPreview() {
      root.querySelector('#qc-preview-text').textContent = text.value.trim() || 'Текст появится здесь';
      const labels = checkedAccounts().map(accountLabel);
      root.querySelector('#qc-counter').textContent = labels.length + ' выбрано';
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
        remove.disabled = state.busy;
        remove.addEventListener('click', async () => {
          if (state.busy) return;
          if (item.uploaded && item.remoteId) {
            state.busy = true;
            try {
              const result = await request('/api/media/' + encodeURIComponent(item.remoteId),
                { method: 'DELETE', headers: { 'x-content-version': String(state.version) } });
              state.version = result.contentVersion;
            } catch (error) {
              setStatus(readableError(error), true);
              state.busy = false;
              return;
            }
            state.busy = false;
          }
          URL.revokeObjectURL(item.url);
          state.pending.splice(state.pending.indexOf(item), 1);
          redrawPhotos();
        });
        controls.append(remove);
        const up = document.createElement('button');
        up.type = 'button'; up.textContent = '←'; up.setAttribute('aria-label', 'Переместить раньше');
        up.disabled = index === 0 || Boolean(state.savedId);
        up.addEventListener('click', () => {
          [state.pending[index - 1], state.pending[index]] = [state.pending[index], state.pending[index - 1]];
          redrawPhotos();
        });
        const down = document.createElement('button');
        down.type = 'button'; down.textContent = '→'; down.setAttribute('aria-label', 'Переместить позже');
        down.disabled = index === state.pending.length - 1 || Boolean(state.savedId);
        down.addEventListener('click', () => {
          [state.pending[index + 1], state.pending[index]] = [state.pending[index], state.pending[index + 1]];
          redrawPhotos();
        });
        controls.append(up, down);
        card.append(img, caption, controls);
        pendingList.append(card);
      });
    }
    function addFiles(files) {
      const currentKeys = new Set(state.pending.map((item) => item.file.name + ':' + item.file.size + ':' + item.file.lastModified));
      for (const file of files) {
        if (!file.type.startsWith('image/')) { setStatus('Выберите файлы изображений.', true); continue; }
        if (file.size > MAX_IMAGE_BYTES) { setStatus('Слишком большой файл: ' + file.name + ' (максимум 50 МБ).', true); continue; }
        const key = file.name + ':' + file.size + ':' + file.lastModified;
        if (currentKeys.has(key)) continue;
        currentKeys.add(key);
        state.pending.push({ file, url: URL.createObjectURL(file), uploaded: false, remoteId: null });
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
    root.querySelectorAll('input[name="qc-account"]').forEach((input) => input.addEventListener('change', refreshPreview));
    root.querySelector('#qc-select-all')?.addEventListener('click', () => {
      root.querySelectorAll('input[name="qc-account"]:not(:disabled)').forEach((input) => { input.checked = true; });
      refreshPreview();
    });
    root.querySelector('#qc-select-none')?.addEventListener('click', () => {
      root.querySelectorAll('input[name="qc-account"]').forEach((input) => { input.checked = false; });
      refreshPreview();
    });
    text.addEventListener('input', refreshPreview);
    refreshPreview();
    root.querySelector('#qc-close').addEventListener('click', dispose);
    root.querySelector('#qc-connect')?.addEventListener('click', (event) => {
      event.preventDefault(); window.location.assign('/socials');
    });

    function createPayload(projectId, mode) {
      const body = text.value.trim();
      const payload = {
        projectId, title: titleFromText(body), body,
        bodyRich: plainTextToRichDocument(body),
        contentFormat: state.pending.length ? 'MEDIA' : 'TEXT_ONLY', scheduleMode: mode
      };
      if (mode === 'AT') {
        const at = root.querySelector('#qc-datetime').value;
        if (!at) throw new Error('Укажите дату и время публикации.');
        payload.scheduledAtLocal = at;
      }
      return payload;
    }

    async function ensureProject() {
      let projectId = root.querySelector('#qc-project').value;
      if (projectId) return projectId;
      const created = await request('/api/projects', {
        method: 'POST', body: JSON.stringify({ name: 'Мои публикации', slug: 'my-publications' })
      });
      projectId = created.id;
      // The project is an internal scope; never ask the operator to create it manually.
      const select = root.querySelector('#qc-project');
      select.innerHTML = '<option value="' + html(projectId) + '">Мои публикации</option>';
      return projectId;
    }

    async function persistDraft(mode) {
      const projectId = await ensureProject();
      const payload = createPayload(projectId, mode);
      if (!state.savedId) {
        // If the create response is lost, do not repeat blindly: the server may
        // have committed the draft. The operator can inspect /content safely.
        let created;
        try {
          created = await request('/api/posts', { method: 'POST', body: JSON.stringify(payload) });
        } catch (error) {
          state.uncertainPublish = true;
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
      const updatedTargets = await request('/api/posts/' + encodeURIComponent(state.savedId) + '/targets', {
        method: 'PUT',
        body: JSON.stringify({ accountIds: selectedIds(), expectedContentVersion: state.version })
      });
      state.version = updatedTargets.contentVersion;

      for (const item of state.pending) {
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
      return state.savedId;
    }

    async function execute(action) {
      if (state.busy || state.uncertainPublish) return;
      const body = text.value.trim();
      if (!body) { setStatus('Напишите текст публикации.', true); text.focus(); return; }
      const chosen = checkedAccounts();
      if (action !== 'save' && !chosen.length) { setStatus('Выберите хотя бы одно подключение.', true); return; }
      const mode = action === 'schedule' ? 'AT' : 'MANUAL';
      if (action === 'schedule' && !root.querySelector('#qc-datetime').value) {
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
      state.busy = true;
      root.querySelectorAll('#qc-save,#qc-schedule,#qc-send').forEach((button) => { button.disabled = true; });
      try {
        setStatus('Сохраняю публикацию…');
        const id = await persistDraft(mode);
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
          state.finished = true;
          setStatus('Черновик сохранён со всеми выбранными изображениями и площадками.');
        }
        root.querySelector('#qc-close').textContent = 'Закрыть';
        root.querySelector('#qc-close').setAttribute('aria-label', 'Закрыть редактор');
      } catch (error) {
        setStatus(readableError(error) + (state.savedId ? ' Черновик сохранён: откройте список публикаций при необходимости.' : ''), true);
      } finally {
        state.busy = false;
        if (!state.uncertainPublish && !state.finished) {
          root.querySelectorAll('#qc-save,#qc-schedule,#qc-send').forEach((button) => { button.disabled = false; });
        }
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
