import { statusLabel } from './presentation-labels.js';

const googlePreviewByConnector = new Map();
let googleSheetsMountBusy = false;

async function googleSheetsApi(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function gsEsc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function gsSummary(summary = {}) {
  const rows = [
    ['Всего', summary.totalRows], ['Новые', summary.newRows], ['Обновления', summary.updateRows],
    ['Без изменений', summary.unchangedRows], ['Конфликты', summary.conflicts], ['Ошибки', summary.errors]
  ];
  return `<div class="gs-summary">${rows.map(([label, value]) => `<div><strong>${Number(value || 0)}</strong><span>${label}</span></div>`).join('')}</div>`;
}

function gsPreviewRows(validation) {
  const rows = (validation.rows || []).slice(0, 60);
  if (!rows.length) return '<div class="muted">В таблице нет строк для preview.</div>';
  return `<div class="operator-preview-table"><table class="table"><thead><tr><th>Строка</th><th>Результат</th><th>Материал</th><th>Проект</th><th>Что исправить</th></tr></thead><tbody>${rows.map((row) => {
    const normalized = row.normalized;
    return `<tr><td>${Number(row.rowNumber || 0)}</td><td><span class="operator-classification ${gsEsc(row.classification)}" data-raw-classification="${gsEsc(row.classification)}">${gsEsc(statusLabel(row.classification))}</span></td><td>${normalized ? gsEsc(normalized.title) : '—'}</td><td>${normalized ? gsEsc(normalized.project) : '—'}</td><td class="small error">${gsEsc((row.errors || []).join('; '))}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function serviceAccountIdentity(text) {
  try {
    const value = JSON.parse(String(text || ''));
    return typeof value.client_email === 'string' ? value.client_email.trim() : '';
  } catch {
    return '';
  }
}


function gsHelp(title, body) {
  return '<details class="gs-help"><summary aria-label="Справка: ' + gsEsc(title) + '">ⓘ</summary><div class="gs-help-body">' + body + '</div></details>';
}

function gsCredentials(text) {
  let value;
  try { value = JSON.parse(String(text || '')); }
  catch { throw new Error('Вставьте JSON-файл целиком: от первой { до последней }. Отдельный private_key или API-ключ самого n8n сюда не подходит.'); }
  if (value?.type !== 'service_account' || typeof value.client_email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(value.client_email) ||
      typeof value.private_key !== 'string' || !value.private_key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('Нужен JSON сервисного аккаунта Google с type=service_account, client_email и private_key. OAuth Client ID и API-ключ n8n не подходят.');
  }
  return value;
}

function gsSpreadsheetId(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/);
  const id = match ? match[1] : raw;
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new Error('Вставьте ссылку на Google Таблицу или её ID между /d/ и /edit.');
  return id;
}

function gsActionableError(error, email = '', service = 'sheets') {
  const message = error instanceof Error ? error.message : String(error);
  const who = email ? ' ' + email : ' email из JSON';
  if (/HTTP 403/.test(message) && service === 'google-drive') return 'Нет доступа к папке Google Drive (403). Откройте «Настройки доступа» папки и добавьте' + who + ' как «Читатель». Если доступ выдан, проверьте Google Drive API в проекте сервисного аккаунта.';
  if (/HTTP 401|HTTP 403/.test(message) && service === 'yandex-disk') return 'Яндекс Диск не разрешил чтение папки. Проверьте OAuth-токен и его права чтения файлов; пароль и публичная ссылка не подходят.';
  if (/HTTP 403|SHEETS_ACCESS_DENIED/.test(message)) return 'Нет доступа к таблице (403). Откройте «Настройки доступа» в Google Таблице и добавьте' + who + '. Для чтения выберите «Читатель», для записи статусов — «Редактор». Если доступ уже выдан, проверьте Google Sheets API в проекте сервисного аккаунта.';
  if (/SHEETS_API_DISABLED/.test(message)) return 'Google Sheets API выключен в проекте сервисного аккаунта. В Google Cloud откройте «API и сервисы → Библиотека → Google Sheets API» и включите API.';
  if (/HTTP 404/.test(message)) return 'Таблица или папка не найдена либо недоступна сервисному аккаунту. Проверьте ссылку и общий доступ.';
  if (/HTTP 401|Google OAuth failed|private_key could not sign/.test(message)) return 'Google не принял ключ. Проверьте, что вставлен JSON сервисного аккаунта целиком, а ключ не отозван. Не изменяйте переносы внутри private_key вручную.';
  if (/timed out|Failed to fetch/.test(message)) return 'Не удалось дождаться ответа. Проверьте соединение и повторите проверку; это действие ничего не публикует.';
  return message;
}

const gsJsonGuide = '<ol><li>Откройте <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener noreferrer">Google Cloud → IAM и администрирование → Сервисные аккаунты</a>.</li><li>Выберите аккаунт → «Ключи». Используйте ранее скачанный JSON. Если его нет, создайте новый ключ типа JSON; старые ключи не удаляйте без проверки других приложений.</li><li>Включите Google Sheets API, а для папки изображений — Google Drive API в этом же проекте.</li><li>Откройте файл .json в текстовом редакторе и скопируйте весь текст от { до }. Или выберите файл кнопкой ниже. Не вставляйте ключ в таблицу и не отправляйте его в чат.</li></ol>';

function gsDate(value) {
  if (!value) return '\u2014';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ru-RU');
}

function gsPollingMeta(polling = {}) {
  const summary = polling.lastSummary || {};
  const changes = Number(summary.newRows || 0) + Number(summary.updateRows || 0);
  const issues = Number(summary.conflicts || 0) + Number(summary.errors || 0);
  const result = polling.lastResult === 'failed'
    ? `\u043e\u0448\u0438\u0431\u043a\u0430: ${gsEsc(polling.lastError || 'unknown')}`
    : polling.lastResult === 'success'
      ? `\u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0439: ${changes}, \u043f\u0440\u043e\u0431\u043b\u0435\u043c: ${issues}`
      : '\u0435\u0449\u0451 \u043d\u0435 \u0437\u0430\u043f\u0443\u0441\u043a\u0430\u043b\u0430\u0441\u044c';
  const next = polling.nextDueAt ? ` \u00b7 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0430\u044f: ${gsEsc(gsDate(polling.nextDueAt))}` : '';
  const autoApply = polling.lastAutoApply?.ok === true
    ? ` \u00b7 \u0430\u0432\u0442\u043e\u0438\u043c\u043f\u043e\u0440\u0442: +${Number(polling.lastAutoApply.created || 0)} / ~${Number(polling.lastAutoApply.updated || 0)}`
    : polling.lastAutoApply?.ok === false
      ? ` \u00b7 \u0430\u0432\u0442\u043e\u0438\u043c\u043f\u043e\u0440\u0442: \u043e\u0448\u0438\u0431\u043a\u0430`
      : '';
  const autoReady = polling.lastAutoReady?.attempted
    ? ` \u00b7 \u0430\u0432\u0442\u043e\u0433\u043e\u0442\u043e\u0432\u043e: ${Number(polling.lastAutoReady.ready || 0)}, \u0431\u043b\u043e\u043a: ${Number(polling.lastAutoReady.blocked || 0)}`
    : '';
  return `\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u044f\u044f \u0430\u0432\u0442\u043e\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430: ${gsEsc(gsDate(polling.lastAttemptAt))} \u00b7 ${result}${autoApply}${autoReady}${next}`;
}


function gsDialog(host, id, title) {
  host.querySelector('dialog.gs-setup-dialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.className = 'gs-dialog gs-setup-dialog';
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = '<div id="' + id + '"></div>';
  host.append(dialog);
  dialog.showModal();
  return dialog.firstElementChild;
}
function gsCloseDialog(container, message = '') {
  const dialog = container.closest('dialog');
  if (dialog) { dialog.close(); dialog.remove(); }
  const notice = document.querySelector('#sources-notice');
  if (notice && message) { notice.textContent = message; notice.className = 'operator-result ok'; }
}
function gsAutomationSummary(connector) {
  const config = connector.config;
  const active = connector.enabled !== false;
  return '<div class="gs-state-grid" aria-label="Сохранённые настройки">' +
    '<div><span>Проверка таблицы</span><strong>' + (active && config.pollingEnabled ? 'Каждые ' + Number(config.pollIntervalMinutes || 15) + ' мин' : 'Автоматически не проверяется') + '</strong></div>' +
    '<div><span>Импорт строк</span><strong>' + (active && config.pollingEnabled && config.autoApplyEnabled ? 'Автоматически в черновики' : 'Вручную после проверки') + '</strong></div>' +
    '<div><span>Готовность к отправке</span><strong>' + (active && config.pollingEnabled && config.autoApplyEnabled && config.autoReadyEnabled ? 'Автоматически после проверок' : 'Требует вашей проверки') + '</strong></div></div>';
}

function connectorCard(connector) {
  const preview = googlePreviewByConnector.get(connector.id);
  return `<article class="gs-connector" data-gs-id="${gsEsc(connector.id)}">
    <div class="gs-connector-head">
      <div><strong><a href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(connector.config.spreadsheetId)}/edit" target="_blank" rel="noopener noreferrer">${gsEsc(connector.name)} ↗</a></strong><span>Google Таблица · лист «${gsEsc(connector.config.sheetName)}»</span></div>
      <span class="gs-enabled">${connector.enabled === false ? 'Отключено' : connector.polling?.lastResult === 'failed' ? 'Ошибка проверки' : 'Подключено'}</span>
    </div>
    ${gsAutomationSummary(connector)}
    <dialog class="gs-dialog gs-automation" aria-label="Автоматизация таблицы"><div class="gs-settings-body"><div class="operator-page-head"><h3>Автоматизация</h3><button class="secondary gs-settings-close" type="button">Закрыть</button></div>
    <div class="gs-connector-meta">Сервисный аккаунт: <code>${gsEsc(connector.config.serviceAccountEmail)}</code></div>
    <div class="gs-polling">
      <div class="gs-setting"><label><input class="gs-poll-enabled" type="checkbox" ${connector.config.pollingEnabled ? 'checked' : ''}> Проверять по таймеру</label>${gsHelp('Автопроверка', 'Publikator периодически читает таблицу. Сама проверка не создаёт публикаций и ничего не отправляет в соцсети.')}</div>
      <div class="gs-setting"><label>Как часто <select class="gs-poll-interval">${[5,15,30,60].map(value => '<option value="' + value + '" ' + (Number(connector.config.pollIntervalMinutes || 15) === value ? 'selected' : '') + '>' + value + ' мин</option>').join('')}</select></label>${gsHelp('Интервал проверки', 'Это частота чтения таблицы, а не время отправки. Время публикации задаётся в строке таблицы или календаре. Изменения обнаружатся при следующей проверке.')}</div>
      <div class="gs-setting"><label><input class="gs-auto-apply" type="checkbox" ${connector.config.autoApplyEnabled ? 'checked' : ''}> Импортировать в черновики</label>${gsHelp('Автоимпорт', 'После проверки Publikator сохраняет корректные строки как черновики. Ошибки и конфликты не перезаписываются автоматически. Для изменения строки увеличивайте source_revision; сохраняйте external_id, чтобы не создавать дубликаты.')}</div>
      <div class="gs-setting gs-ready-setting"><label><input class="gs-auto-ready" type="checkbox" ${connector.config.autoReadyEnabled ? 'checked' : ''} ${connector.config.autoApplyEnabled ? '' : 'disabled'}> Готовить к отправке автоматически</label>${gsHelp('Автоматическая готовность', '<strong>Может привести к реальной отправке.</strong> После автоимпорта приложение проверяет текст, изображения, получателей и ограничения площадок. Успешно проверенный материал становится готовым. Режим AT отправит его в назначенное время, QUEUE — по очереди; MANUAL сам не отправится. Включайте только для таблицы, содержимое и получатели которой проверены. Требуется автоимпорт.')}</div>
      <button class="secondary gs-poll-save" type="button">Сохранить автоматизацию</button>
      <span class="gs-poll-meta">${gsPollingMeta(connector.polling)}</span>
    </div><p class="gs-unsaved hidden" role="status">Есть несохранённые изменения</p>
      ${connector.config.writeBack ? '<button class="secondary gs-publication-writeback" type="button">Записать статусы сейчас</button>' : ''}
    </div></dialog>
    <div class="row-actions gs-main-actions">
      <button class="primary gs-preview" type="button">Изменения</button>
      <button class="secondary gs-apply ${preview ? '' : 'hidden'}" type="button" ${preview?.canApply ? '' : 'disabled'}>Импортировать</button>
      <button class="secondary gs-test" type="button">Проверить</button>
      <button class="secondary gs-add-folder" type="button">Папка +</button>
      <button class="secondary gs-settings" type="button">Настройки</button>
    </div>
    <div class="gs-result">${preview ? `<div class="operator-result ${preview.canApply ? 'ok' : 'error'}"><strong>${preview.canApply ? 'Предпросмотр готов.' : 'Импорт заблокирован.'}</strong> ${gsHelp("Технические сведения проверки", "<code>" + gsEsc(preview.sourceSnapshotSha256) + "</code>")}</div>${gsSummary(preview.summary)}${gsPreviewRows(preview)}` : ''}</div>
  </article>`;
}

async function loadGoogleConnectors(host) {
  const list = host.querySelector('#gs-connectors-list');
  let data;
  try { data = await googleSheetsApi('/api/google-sheets/connectors'); }
  catch (error) {
    host.querySelector('#sources-google-count').textContent = '?';
    list.innerHTML = '<div class="operator-result error" role="alert">' + gsEsc(gsActionableError(error)) + '</div><button type="button" class="secondary gs-retry">Повторить загрузку таблиц</button>';
    list.querySelector('.gs-retry').onclick = () => loadGoogleConnectors(host);
    return;
  }
  const connectors = data.connectors || [];
  host.querySelector('#sources-google-count').textContent = String(connectors.length);
  list.innerHTML = connectors.length ? connectors.map(connectorCard).join('') : '<p class="muted">Нет подключённых таблиц</p>';
  list.querySelectorAll('.gs-add-folder').forEach(button => button.addEventListener('click', () => renderGoogleConnectForm(host, button.closest('.gs-connector').dataset.gsId)));
  list.querySelectorAll('.gs-connector').forEach(card => {
    const settings = card.querySelector('.gs-automation');
    card.querySelector('.gs-settings').onclick = () => settings.showModal();
    card.querySelector('.gs-settings-close').onclick = () => settings.close();
    card.querySelectorAll('.gs-polling input, .gs-polling select').forEach(input => input.addEventListener('change', () => {
      card.querySelector('.gs-unsaved').classList.remove('hidden');
    }));
  });
  list.querySelectorAll('.gs-auto-apply').forEach((control) => control.addEventListener('change', () => {
    const autoReady = control.closest('.gs-connector')?.querySelector('.gs-auto-ready');
    if (!autoReady) return;
    autoReady.disabled = !control.checked;
    if (!control.checked) autoReady.checked = false;
  }));
  list.querySelectorAll('.gs-poll-save').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('.gs-connector');
    const out = card.querySelector('.gs-result');
    const enabled = Boolean(card.querySelector('.gs-poll-enabled')?.checked);
    const intervalMinutes = Number(card.querySelector('.gs-poll-interval')?.value || 15);
    const autoApplyEnabled = Boolean(card.querySelector('.gs-auto-apply')?.checked);
    const autoReadyEnabled = autoApplyEnabled && Boolean(card.querySelector('.gs-auto-ready')?.checked);
    button.disabled = true;
    out.innerHTML = '<div class="operator-result">\u0421\u043e\u0445\u0440\u0430\u043d\u044f\u044e \u043f\u0430\u0440\u0430\u043c\u0435\u0442\u0440\u044b \u0430\u0432\u0442\u043e\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438\u2026</div>';
    try {
      await googleSheetsApi(`/api/google-sheets/connectors/${encodeURIComponent(card.dataset.gsId)}/polling`, {
        method: 'PUT', body: JSON.stringify({ enabled, intervalMinutes, autoApplyEnabled, autoReadyEnabled })
      });
      await loadGoogleConnectors(host);
    } catch (error) {
      out.innerHTML = `<div class="operator-result error">${gsEsc(gsActionableError(error))}</div>`;
      button.disabled = false;
    }
  }));
  list.querySelectorAll('.gs-publication-writeback').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('.gs-connector');
    const out = card.querySelector('.gs-result');
    button.disabled = true;
    out.innerHTML = '<div class="operator-result">Записываю актуальные статусы публикаций в Google Sheets…</div>';
    try {
      const result = await googleSheetsApi(`/api/google-sheets/connectors/${encodeURIComponent(card.dataset.gsId)}/publication-writeback`, { method: 'POST', body: '{}' });
      out.innerHTML = `<div class="operator-result ok"><strong>Статусы синхронизированы.</strong> Записано: ${Number(result.written || 0)}, ошибок: ${Number(result.failed || 0)}.</div>`;
    } catch (error) {
      out.innerHTML = `<div class="operator-result error">${gsEsc(gsActionableError(error))}</div>`;
    } finally { button.disabled = false; }
  }));
  list.querySelectorAll('.gs-test').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('.gs-connector');
    const out = card.querySelector('.gs-result');
    out.innerHTML = '<div class="operator-result">Проверяю доступ к Google…</div>';
    try {
      const result = await googleSheetsApi(`/api/google-sheets/connectors/${encodeURIComponent(card.dataset.gsId)}/test`, { method: 'POST', body: '{}' });
      out.innerHTML = `<div class="operator-result ok"><strong>Подключение работает.</strong> ${gsEsc(result.spreadsheetTitle)} · лист ${gsEsc(result.sheetName)}</div>`;
    } catch (error) {
      out.innerHTML = `<div class="operator-result error">${gsEsc(gsActionableError(error))}</div>`;
    }
  }));
  list.querySelectorAll('.gs-preview').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('.gs-connector');
    const out = card.querySelector('.gs-result');
    out.innerHTML = '<div class="operator-result">Читаю Sheet и выполняю Preview без изменения базы…</div>';
    try {
      const preview = await googleSheetsApi(`/api/google-sheets/connectors/${encodeURIComponent(card.dataset.gsId)}/preview`, { method: 'POST', body: '{}' });
      googlePreviewByConnector.set(card.dataset.gsId, preview);
      await loadGoogleConnectors(host);
    } catch (error) {
      googlePreviewByConnector.delete(card.dataset.gsId);
      out.innerHTML = `<div class="operator-result error">${gsEsc(gsActionableError(error))}</div>`;
    }
  }));
  list.querySelectorAll('.gs-apply').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('.gs-connector');
    const connectorId = card.dataset.gsId;
    const preview = googlePreviewByConnector.get(connectorId);
    const out = card.querySelector('.gs-result');
    if (!preview?.canApply) return;
    if (!window.confirm('Импортировать проверенные новые/изменённые строки как DRAFT? Удаление строк из Google Sheets ничего не удаляет в Publikator.')) return;
    button.disabled = true;
    out.innerHTML = '<div class="operator-result">Повторно сверяю Sheet и применяю snapshot…</div>';
    try {
      const applied = await googleSheetsApi(`/api/google-sheets/connectors/${encodeURIComponent(connectorId)}/apply`, {
        method: 'POST',
        body: JSON.stringify({ confirm: 'IMPORT', previewSha: preview.sourceSnapshotSha256 })
      });
      googlePreviewByConnector.delete(connectorId);
      const warning = applied.writeBack?.attempted && !applied.writeBack.ok
        ? `<div class="operator-result error">Импорт сохранён, но status write-back не выполнен: ${gsEsc(applied.writeBack.error || 'Google API error')}</div>` : '';
      out.innerHTML = `<div class="operator-result ok"><strong>Google Sheets синхронизирован.</strong> Создано: ${Number(applied.created || 0)}, обновлено: ${Number(applied.updated || 0)}, без изменений: ${Number(applied.unchanged || 0)}.</div>${warning}`;
    } catch (error) {
      out.innerHTML = `<div class="operator-result error">${gsEsc(gsActionableError(error))}</div>`;
    } finally {
      button.disabled = false;
    }
  }));
}

async function renderGoogleConnectForm(host, existingId = '') {
  const formHost = gsDialog(host, 'gs-connect-form-host', 'Подключение Google');
  formHost.innerHTML = '<p role="status">Загружаю сохранённые подключения Google…</p>';
  let saved;
  try { saved = (await googleSheetsApi('/api/google-sheets/connectors')).connectors.filter(item => item.enabled); }
  catch (error) {
    formHost.innerHTML = '<div class="gs-dialog-error"><p role="alert">' + gsEsc(gsActionableError(error)) + '</p><button type="button">Закрыть</button></div>';
    formHost.querySelector('button').onclick = () => gsCloseDialog(formHost);
    formHost.closest('dialog').addEventListener('cancel', event => { event.preventDefault(); gsCloseDialog(formHost); });
    formHost.querySelector('button').focus();
    return;
  }
  formHost.innerHTML = '<div class="gs-connect-form operator-section"><div class="operator-page-head"><div><h3>Google: таблица и папка изображений</h3><p>Один сервисный аккаунт для плана публикаций и фотографий. Доступ выдаётся отдельно к таблице и папке.</p></div><button id="gs-close-connect" class="secondary" type="button">Закрыть</button></div>' +
    '<form id="gs-connect-form" class="operator-form">' +
    '<div class="full gs-setup-guide"><strong>1. Выберите сервисный аккаунт</strong>' + gsHelp('Один аккаунт для Google', '<p>JSON — удостоверение сервисного аккаунта, а не доступ ко всему Google Диску. Для таблицы и папки подходит один JSON. API-ключ самого n8n, пароль Google и OAuth Client ID сюда не подходят. Если имя сервисного аккаунта содержит n8n, его Google JSON подходит: название аккаунта не ограничивает использование.</p>' + gsJsonGuide) + '</div>' +
    '<div class="full gs-account-choices" role="group" aria-label="Сервисный аккаунт Google">' + saved.map(item => '<label><input type="radio" name="accountChoice" value="' + gsEsc(item.id) + '"><span><strong>Использовать сохранённый аккаунт</strong><small>' + gsEsc(item.name) + '<br>' + gsEsc(item.config.serviceAccountEmail) + '</small></span></label>').join('') + '<label><input type="radio" name="accountChoice" value=""><span><strong>Подключить другой аккаунт</strong><small>Загрузить или вставить его JSON-ключ</small></span></label><select name="existingConnectorId" hidden aria-hidden="true" tabindex="-1"><option value="">Новый аккаунт</option>' + saved.map(item => '<option value="' + gsEsc(item.id) + '">' + gsEsc(item.name) + '</option>').join('') + '</select></div>' +
    '<div class="full" id="gs-new-key"><label>JSON сервисного аккаунта Google<textarea name="credentials" rows="6" autocomplete="off" placeholder=\'{"type":"service_account", …}\'></textarea></label><label>Или выберите файл JSON<input id="gs-json-file" type="file" accept=".json,application/json"></label><p class="operator-field-help">Вставьте весь файл от первой { до последней }. Ключ хранится зашифрованно. При выборе сохранённого аккаунта он остаётся на сервере и не запрашивается снова.</p></div>' +
    '<div id="gs-share-hint" class="operator-secret-note"></div>' +
    '<div class="full gs-setup-guide"><strong>2. Таблица с планом публикаций</strong>' + gsHelp('Как указать таблицу и выдать доступ', '<ol><li>Откройте нужную Google Таблицу и скопируйте адрес целиком. Подойдёт и ID между /d/ и /edit.</li><li>Нажмите «Настройки доступа» → добавьте показанный email сервисного аккаунта.</li><li>Для чтения выберите «Читатель», для записи результатов обратно — «Редактор». Ваш личный доступ не передаётся приложению.</li><li>В проекте Google Cloud включите Google Sheets API. После проверки выберите лист с колонками шаблона Publikator.</li></ol><p>Сохранённая таблица сохраняет свой ID подключения, настройки автоматизации и историю импорта. Здесь к ней можно добавить папку; таблица повторно не создаётся.</p>') + '</div>' +
    '<label class="full">Название подключения<input name="name" required placeholder="План публикаций"></label>' +
    '<label class="full">Ссылка на Google Таблицу или ID<input name="spreadsheetId" required placeholder="https://docs.google.com/spreadsheets/d/…/edit"></label>' +
    '<div class="full gs-setup-guide"><strong>3. Папка изображений — необязательно</strong>' + gsHelp('Как подключить папку изображений', '<ol><li>Создайте или откройте папку Google Drive с фотографиями для публикаций. Скопируйте ссылку вида drive.google.com/drive/folders/…</li><li>В «Настройках доступа» этой папки добавьте тот же email сервисного аккаунта как «Читатель». Доступ к таблице сам по себе не открывает папку.</li><li>В том же проекте Google Cloud включите Google Drive API. Отдельный JSON создавать не нужно.</li><li>Задайте понятное имя папки в Publikator. В колонке media таблицы используйте это имя как source и имя файла внутри папки как path.</li></ol><code>[{"source":"Фото проекта","path":"post-01.jpg"}]</code><p>Порядок объектов задаёт порядок фото. Не вставляйте путь Windows или ссылку страницы отдельного файла. Поддерживаются JPEG/PNG; облачный MP4 пока не включён. Если изображения не нужны, оставьте оба поля папки пустыми.</p>') + '</div>' +
    '<label class="full">Ссылка на папку Google Drive или её ID<input name="rootFolder" placeholder="https://drive.google.com/drive/folders/…"></label>' +
    '<label class="full">Название папки в Publikator<input name="mediaName" placeholder="Например: Фото проекта"><span class="operator-field-help">Укажите это точное название в поле source колонки media. Пример: ASA Lab Media Test.</span></label>' +
    '<div class="row-actions full"><button id="gs-inspect" class="secondary" type="button">1. Проверить доступ к таблице и папке</button></div>' +
    '<label id="gs-sheet-wrap" class="full hidden">Лист таблицы<select name="sheetName"></select></label>' +
    '<label id="gs-writeback-wrap" class="target-check hidden"><input name="writeBack" type="checkbox"> Записывать результаты импорта и публикации обратно в таблицу</label>' +
    '<div class="full">' + gsHelp('Что произойдёт после сохранения', '<p>Сохранятся проверенные подключения таблицы и папки. Фотографии загрузятся при импорте строк с указанными файлами. Сохранение подключения не публикует материалы. Автоматическая готовность и расписание настраиваются отдельно. Проверка чтения не подтверждает права записи: для статусов таблице нужен «Редактор». Результаты записываются в служебные колонки V:AD; не заполняйте их вручную.</p><p>403/404: проверьте адрес и доступ email к конкретной таблице или папке. Если доступ есть, проверьте соответствующий API в Google Cloud. Неправильный JSON, отозванный ключ и сетевой тайм-аут требуют разных действий; результаты проверки показаны отдельно ниже.</p>') + '</div>' +
    '<div id="gs-connect-result" class="full" role="status"></div><div class="row-actions full"><button id="gs-save" class="primary" type="submit" disabled>2. Сохранить Google-подключение</button></div></form></div>';
  const form = formHost.querySelector('form'), result = form.querySelector('#gs-connect-result'), save = form.querySelector('#gs-save');
  const credentialsInput = form.elements.credentials, selectAccount = form.elements.existingConnectorId;
  const inspect = form.querySelector('#gs-inspect');
  let verified = '', busy = false;
  function existing() { return saved.find(item => item.id === selectAccount.value); }
  function email() { return existing()?.config.serviceAccountEmail || serviceAccountIdentity(credentialsInput.value); }
  function showIdentity() {
    const address = email(), hint = form.querySelector('#gs-share-hint');
    hint.innerHTML = address ? '<strong>Выдайте доступ этому сервисному аккаунту:</strong><p><code>' + gsEsc(address) + '</code></p><ul><li>Таблица: «Читатель» для импорта, «Редактор» для записи статусов.</li><li>Папка Google Drive: «Читатель» для изображений.</li></ul><p>Откройте «Настройки доступа» каждого ресурса и добавьте этот email. Не открывайте доступ «всем по ссылке».</p>' : 'Выберите сохранённый аккаунт или вставьте JSON — здесь появится email для доступа и к таблице, и к папке.';
  }
  function invalidate() { verified = ''; save.disabled = true; result.textContent = ''; form.querySelector('#gs-sheet-wrap').classList.add('hidden'); form.querySelector('#gs-writeback-wrap').classList.add('hidden'); }
  function accountChanged() {
    invalidate();
    const item = existing();
    form.querySelector('#gs-new-key').classList.toggle('hidden', !!item);
    credentialsInput.disabled = !!item;
    if (item) credentialsInput.value = '';
    form.elements.name.readOnly = !!item; form.elements.spreadsheetId.readOnly = !!item;
    form.elements.name.value = item?.name || '';
    form.elements.spreadsheetId.value = item?.config.spreadsheetId || '';
    showIdentity();
  }
  function snapshot() {
    const body = { spreadsheetId: gsSpreadsheetId(form.elements.spreadsheetId.value), rootFolder: form.elements.rootFolder.value.trim() };
    if (existing()) body.existingConnectorId = existing().id;
    else body.credentials = gsCredentials(credentialsInput.value);
    return body;
  }
  selectAccount.onchange = accountChanged;
  form.querySelectorAll('[name=accountChoice]').forEach(radio => radio.addEventListener('change', () => { selectAccount.value = radio.value; accountChanged(); }));
  for (const input of [credentialsInput, form.elements.spreadsheetId, form.elements.rootFolder]) input.addEventListener('input', () => { invalidate(); showIdentity(); });
  form.querySelector('#gs-json-file').onchange = async event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 65536) { result.textContent = 'Выберите JSON ключа до 64 КБ.'; return; }
    credentialsInput.value = await file.text();
    credentialsInput.dispatchEvent(new Event('input', { bubbles: true })); event.target.value = '';
  };
  formHost.querySelector('#gs-close-connect').onclick = () => { if (!busy) gsCloseDialog(formHost); };
  formHost.closest('dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else { event.preventDefault(); gsCloseDialog(formHost); } });
  inspect.onclick = async () => {
    if (busy) return;
    busy = true; inspect.disabled = true; save.disabled = true;
    result.textContent = 'Проверяю таблицу и папку одним сервисным аккаунтом…';
    try {
      const body = snapshot();
      const checked = await googleSheetsApi('/api/google-sheets/setup/inspect', { method: 'POST', body: JSON.stringify(body) });
      if (JSON.stringify(snapshot()) !== JSON.stringify(body)) throw new Error('Поля изменились во время проверки. Проверьте доступ заново.');
      result.innerHTML = '<div class="operator-result ' + (checked.sheet.ok ? 'ok' : 'error') + '"><strong>Таблица: ' + (checked.sheet.ok ? 'чтение доступно' : 'нужна проверка') + '</strong><p>' + gsEsc(checked.sheet.ok ? checked.sheet.value.spreadsheetTitle : checked.sheet.message) + '</p></div>' +
        (checked.folder ? '<div class="operator-result ' + (checked.folder.ok ? 'ok' : 'error') + '"><strong>Папка: ' + (checked.folder.ok ? 'чтение доступно' : 'нужна проверка') + '</strong><p>' + gsEsc(checked.folder.ok ? checked.folder.value.rootFolderName : checked.folder.message) + '</p></div>' : '<p>Папка не указана: подключится только таблица.</p>');
      if (!checked.canSave) { verified = ''; return; }
      const item = existing(), select = form.elements.sheetName;
      select.innerHTML = checked.sheet.value.sheets.map(name => '<option value="' + gsEsc(name) + '">' + gsEsc(name) + '</option>').join('');
      if (item) select.value = item.config.sheetName;
      select.disabled = !!item;
      form.elements.writeBack.checked = !!item?.config.writeBack;
      form.elements.writeBack.disabled = !!item;
      form.querySelector('#gs-sheet-wrap').classList.remove('hidden');
      form.querySelector('#gs-writeback-wrap').classList.remove('hidden');
      verified = JSON.stringify(body); save.disabled = false;
    } catch (error) { verified = ''; result.textContent = gsActionableError(error, email()); }
    finally { busy = false; inspect.disabled = false; }
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || save.disabled) return;
    busy = true; save.disabled = true; inspect.disabled = true;
    try {
      const body = snapshot();
      if (verified !== JSON.stringify(body)) throw new Error('Проверьте доступ после изменения адреса или аккаунта.');
      if (body.rootFolder && !form.elements.mediaName.value.trim()) throw new Error('Укажите название папки в Publikator для колонки media.');
      if (!body.rootFolder && form.elements.mediaName.value.trim()) throw new Error('Укажите адрес папки или очистите её название.');
      await googleSheetsApi('/api/google-sheets/setup/save', { method: 'POST', body: JSON.stringify({ ...body, name: form.elements.name.value.trim(), sheetName: form.elements.sheetName.value, writeBack: form.elements.writeBack.checked, mediaName: form.elements.mediaName.value.trim() }) });
      credentialsInput.value = '';
      gsCloseDialog(formHost, 'Google-подключение сохранено. Выбранные ресурсы проверены; материалы не публиковались.');
      await loadGoogleConnectors(host);
      host.querySelector('.gs-cloud-media')?.remove();
      await mountCloudMedia(host);
    } catch (error) { result.textContent = gsActionableError(error, email()); save.disabled = !verified; }
    finally { busy = false; inspect.disabled = false; }
  };
  if (!existingId && saved.length === 1) existingId = saved[0].id;
  if (saved.some(item => item.id === existingId)) selectAccount.value = existingId;
  form.querySelectorAll('[name=accountChoice]').forEach(radio => { radio.checked = radio.value === selectAccount.value; });
  accountChanged();
  formHost.querySelector('#gs-close-connect').focus();
}

async function mountGoogleSheets() {
  if (googleSheetsMountBusy) return;
  if (document.querySelector('#page-title')?.textContent !== 'Источники / Интеграции') return;
  const layout = document.querySelector('.operator-source-layout');
  if (!layout || document.querySelector('#operator-google-sheets-live')) return;
  googleSheetsMountBusy = true;
  try {
    const host = document.createElement('section');
    host.id = 'operator-google-sheets-live';
    host.className = 'gs-live-section';
    host.innerHTML = '<div class="sources-toolbar"><button id="gs-open-connect" type="button" class="primary">+ Google</button><button id="gs-add-yandex" type="button" class="secondary">+ Яндекс Диск</button></div><div id="sources-notice" role="status"></div>' +
      '<section class="sources-group"><h3>Таблицы <span id="sources-google-count" class="sources-count">…</span></h3><div id="gs-connectors-list"><p role="status">Загрузка…</p></div></section><div id="sources-media-slot"></div>';
    document.querySelector('#operator-source-connected-slot').append(host);
    host.querySelector('#gs-open-connect').addEventListener('click', () => renderGoogleConnectForm(host));
    await Promise.all([loadGoogleConnectors(host), mountCloudMedia(host)]);
  } catch (error) {
    const host = document.querySelector('#operator-google-sheets-live');
    if (host) host.innerHTML = `<div class="operator-result error">${gsEsc(gsActionableError(error))}</div>`;
  } finally {
    googleSheetsMountBusy = false;
  }
}

window.addEventListener('publikator:operator-route-rendered', (event) => {
  if (event instanceof CustomEvent && event.detail?.path === '/sources') mountGoogleSheets().catch(() => {});
});
setTimeout(() => mountGoogleSheets().catch(() => {}), 0);

async function mountCloudMedia(host) {
  const section = document.createElement('section');
  section.className = 'gs-cloud-media';
  section.id = 'cloud-media-sources';
  section.innerHTML = '<h3>Папки изображений</h3>' +
    gsHelp('Как связать изображение со строкой', '<p>В колонке media укажите массив: <code>[{"source":"Фото проекта","path":"post-01.jpg"}]</code>. source — название подключения ниже, path — имя файла или путь внутри выбранной папки. Например, фото в подпапке: <code>Обложки/post-01.png</code>. Publikator сохраняет свою копию изображения. Подключение папки само ничего не импортирует и не публикует.') +
    '<div id="gs-cloud-list"><p role="status">Загружаю папки…</p></div>';
  host.querySelector('#sources-media-slot').append(section);
  async function refresh() {
    const list = section.querySelector('#gs-cloud-list');
    const results = await Promise.allSettled(['google-drive', 'yandex-disk'].map(async kind => {
      const response = await googleSheetsApi('/api/' + kind + '/connectors');
      return { kind, connectors: response.connectors || [] };
    }));
    list.innerHTML = results.map((item, index) => {
      const platform = index === 0 ? 'Google Drive' : 'Яндекс Диск';
      if (item.status !== 'fulfilled') return '<p role="alert">' + gsEsc(platform) + ': ' + gsEsc(gsActionableError(item.reason)) + '</p>';
      return item.value.connectors.map(connector => '<article class="gs-cloud-card"><div class="gs-cloud-card-info"><strong>' + gsEsc(connector.name) + '</strong><span>' + platform + ' · ' + gsEsc(connector.config.rootFolderName || connector.config.rootFolderId || connector.config.rootPath) + '</span><small>' + (connector.enabled === false ? 'Отключено' : 'Подключено') + '</small></div><button type="button" class="secondary gs-cloud-test" data-kind="' + item.value.kind + '" data-id="' + gsEsc(connector.id) + '">Проверить папку</button><div class="gs-cloud-result" role="status"></div></article>').join('');
    }).join('') || '<p class="muted">Нет подключённых папок</p>';
    list.querySelectorAll('.gs-cloud-test').forEach(button => button.addEventListener('click', async () => {
      const out = button.parentElement.querySelector('.gs-cloud-result');
      button.disabled = true;
      out.textContent = 'Проверяю доступ к папке…';
      try {
        await googleSheetsApi('/api/' + button.dataset.kind + '/connectors/' + encodeURIComponent(button.dataset.id) + '/test', { method: 'POST', body: '{}' });
        out.textContent = 'Папка доступна.';
      } catch (error) { out.textContent = gsActionableError(error, '', button.dataset.kind); }
      finally { button.disabled = false; }
    }));
  }
  function open(kind) {
    const drive = kind === 'google-drive';
    const formHost = gsDialog(host, 'gs-cloud-form', 'Подключение Яндекс Диска');
    formHost.innerHTML = '<form class="operator-form gs-media-form"><div class="full operator-page-head"><h4>Яндекс Диск: папка изображений</h4><button type="button" class="secondary gs-media-close">Закрыть</button></div><p class="full">Три шага: получите токен, укажите папку, проверьте и сохраните. Подключение не публикует материалы.</p>' +
      '<div class="full gs-yandex-guide"><h4>1. Получите доступ к своим изображениям</h4><p>Если токен уже есть, вставьте его ниже. Если нет — выполните шаги. Google JSON здесь не нужен.</p><ol>' +
        '<li>Откройте <a href="https://oauth.yandex.ru/" target="_blank" rel="noopener noreferrer">Яндекс OAuth — мои приложения ↗</a> под владельцем папки и создайте приложение для личного подключения. Назовите его «Publikator».</li>' +
        '<li>В платформах укажите веб-сервис и Redirect URI <code>https://oauth.yandex.ru/verification_code</code>.</li>' +
        '<li>В доступе к данным найдите «Яндекс Диск REST API» и выберите <strong>Чтение всего Диска</strong> (<code>cloud_api:disk.read</code>). Право записи не требуется. Это право чтения всего Диска; указанный ниже путь ограничивает папку, используемую Publikator, а не права токена.</li>' +
        '<li>Сохраните приложение. Скопируйте его <strong>ClientID</strong> (идентификатор приложения, не Client secret) и вставьте сюда, чтобы открыть страницу получения токена.</li></ol>' +
        '<label>ClientID приложения — только для получения токена<input name="clientId" autocomplete="off" placeholder="Идентификатор из настроек Яндекс OAuth"></label><a class="button-link secondary gs-yandex-authorize hidden" target="_blank" rel="noopener noreferrer">Открыть получение токена в Яндексе ↗</a><p class="gs-yandex-client-hint">После ввода ClientID здесь появится кнопка перехода.</p>' +
        '<p>Разрешите доступ в Яндексе. Скопируйте только значение <code>access_token</code> с открывшейся страницы, без <code>OAuth</code>, кавычек и остального адреса. Вернитесь в это окно и вставьте в поле ниже. <a href="https://yandex.ru/dev/id/doc/ru/tokens/debug-token" target="_blank" rel="noopener noreferrer">Официальная инструкция ↗</a>.</p></div>' +
        '<label class="full">2. OAuth-токен Яндекс Диска<input name="secret" type="password" required autocomplete="off"><span class="operator-field-help">Токен — секретный код доступа. Пароль Яндекса, ClientID и публичная ссылка не подходят. Хранится зашифрованно.</span></label>' +
      '<div class="full gs-setup-guide"><strong>3. Выберите папку изображений</strong><p>Только JPEG/PNG. Файлы копируются внутрь Publikator при импорте строк таблицы.</p></div>' +
      '<label class="full">Название подключения<input name="name" required placeholder="Фото проекта"><span class="operator-field-help">Придумайте понятное название: оно используется в колонке media таблицы.</span></label>' +
      '<label class="full">Путь папки на Яндекс Диске<input name="root" required placeholder="/Фото проекта"><span class="operator-field-help">Например: /Фото проекта или /Публикации/Обложки. Путь от корня Диска, не имя аккаунта и не ссылка браузера.</span></label>' +
      '<div class="row-actions full"><button type="button" class="secondary gs-media-inspect">1. Проверить папку</button><button type="submit" class="primary gs-media-save" disabled>2. Сохранить папку</button></div><div class="full gs-media-result" role="status"></div></form>';
    const form = formHost.querySelector('form'), out = form.querySelector('.gs-media-result'), save = form.querySelector('.gs-media-save');
    let verified = '', busy = false;
    function payload() {
      const secret = form.elements.secret.value;
      return { name: form.elements.name.value.trim(), ...(drive ? { rootFolder: form.elements.root.value.trim(), credentials: gsCredentials(secret) } : { rootPath: form.elements.root.value.trim(), credentials: { oauthToken: secret.trim() } }) };
    }
    form.addEventListener('input', () => {
      verified = ''; save.disabled = true;
      if (drive) {
        const email = serviceAccountIdentity(form.elements.secret.value);
        form.querySelector('.gs-drive-email').textContent = email ? 'Откройте папку Google Drive → «Настройки доступа» → добавьте ' + email + ' как «Читатель». В проекте аккаунта должен быть включён Google Drive API.' : 'Вставьте JSON целиком, чтобы увидеть email для доступа к папке.';
      }
    });
    form.querySelector('.gs-media-close').onclick = () => { if (!busy) gsCloseDialog(formHost); };
    formHost.closest('dialog').addEventListener('cancel', event => { event.preventDefault(); if (!busy) gsCloseDialog(formHost); });
    form.querySelector('[name=clientId]')?.addEventListener('input', event => {
      const id = event.target.value.trim(), valid = /^[a-zA-Z0-9_-]{10,128}$/.test(id);
      const link = form.querySelector('.gs-yandex-authorize');
      link.classList.toggle('hidden', !valid);
      if (valid) link.href = 'https://oauth.yandex.ru/authorize?response_type=token&client_id=' + encodeURIComponent(id);
      else link.removeAttribute('href');
      form.querySelector('.gs-yandex-client-hint').textContent = valid ? 'Кнопка откроет Яндекс в новой вкладке. Это ещё не токен.' : 'Введите ClientID из настроек приложения, чтобы открыть получение токена.';
    });
    form.querySelector('.gs-media-close').focus();
    const inspect = form.querySelector('.gs-media-inspect');
    inspect.onclick = async () => {
      if (busy) return;
      busy = true; inspect.disabled = true; save.disabled = true;
      try {
        const body = payload();
        if (!body.name) throw new Error('Укажите название подключения: оно используется в колонке media таблицы.');
        await googleSheetsApi('/api/' + kind + '/inspect', { method: 'POST', body: JSON.stringify(body) });
        if (JSON.stringify(payload()) !== JSON.stringify(body)) throw new Error('Поля изменились во время проверки. Проверьте папку заново.');
        verified = JSON.stringify(body); save.disabled = false;
        out.textContent = 'Папка доступна. Сохраните подключение, затем укажите его название и имя файла в колонке media.';
      } catch (error) { out.textContent = gsActionableError(error, drive ? serviceAccountIdentity(form.elements.secret.value) : '', kind); }
      finally { busy = false; inspect.disabled = false; }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      if (busy) return;
      busy = true; save.disabled = true; inspect.disabled = true;
      try {
        const body = payload();
        if (!verified || verified !== JSON.stringify(body)) throw new Error('После изменения полей сначала проверьте папку.');
        await googleSheetsApi('/api/' + kind + '/connectors', { method: 'POST', body: JSON.stringify(body) });
        form.elements.secret.value = ''; gsCloseDialog(formHost, 'Папка Яндекс Диска сохранена. Теперь её можно указать в строках таблицы.');
        await refresh();
      } catch (error) { out.textContent = gsActionableError(error, '', kind); }
      finally { busy = false; inspect.disabled = false; }
    };
  }
  host.querySelector('#gs-add-yandex').onclick = () => open('yandex-disk');
  await refresh();
}
