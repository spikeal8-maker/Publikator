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
  catch { throw new Error('Вставьте JSON-файл целиком: от первой { до последней }. Отдельный private_key или ключ n8n сюда не подходит.'); }
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

function connectorCard(connector) {
  const preview = googlePreviewByConnector.get(connector.id);
  return `<article class="gs-connector" data-gs-id="${gsEsc(connector.id)}">
    <div class="gs-connector-head">
      <div><strong>${gsEsc(connector.name)}</strong><span>${gsEsc(connector.config.spreadsheetId)} · ${gsEsc(connector.config.sheetName)}</span></div>
      <span class="badge">${connector.config.writeBack ? 'Импорт + статусы публикаций' : 'Только импорт'}</span>
    </div>
    <div class="gs-connector-meta">Сервисный аккаунт: <code>${gsEsc(connector.config.serviceAccountEmail)}</code></div>
    <div class="gs-polling">
      <div class="gs-setting"><label><input class="gs-poll-enabled" type="checkbox" ${connector.config.pollingEnabled ? 'checked' : ''}> Проверять таблицу автоматически</label>${gsHelp('Автопроверка', 'Publikator периодически читает таблицу. Сама проверка не создаёт публикаций и ничего не отправляет в соцсети.')}</div>
      <div class="gs-setting"><label>Как часто <select class="gs-poll-interval">${[5,15,30,60].map(value => '<option value="' + value + '" ' + (Number(connector.config.pollIntervalMinutes || 15) === value ? 'selected' : '') + '>' + value + ' мин</option>').join('')}</select></label>${gsHelp('Интервал проверки', 'Это частота чтения таблицы, а не время отправки. Время публикации задаётся в строке таблицы или календаре. Изменения обнаружатся при следующей проверке.')}</div>
      <div class="gs-setting"><label><input class="gs-auto-apply" type="checkbox" ${connector.config.autoApplyEnabled ? 'checked' : ''}> Импортировать новые и изменённые строки в черновики</label>${gsHelp('Автоимпорт', 'После проверки Publikator сохраняет корректные строки как черновики. Ошибки и конфликты не перезаписываются автоматически. Для изменения строки увеличивайте source_revision; сохраняйте external_id, чтобы не создавать дубликаты.')}</div>
      <div class="gs-setting gs-ready-setting"><label><input class="gs-auto-ready" type="checkbox" ${connector.config.autoReadyEnabled ? 'checked' : ''} ${connector.config.autoApplyEnabled ? '' : 'disabled'}> Разрешить автоматическую готовность к публикации</label>${gsHelp('Автоматическая готовность', '<strong>Может привести к реальной отправке.</strong> После автоимпорта приложение проверяет текст, изображения, получателей и ограничения площадок. Успешно проверенный материал становится готовым. Режим AT отправит его в назначенное время, QUEUE — по очереди; MANUAL сам не отправится. Включайте только для таблицы, содержимое и получатели которой проверены. Требуется автоимпорт.')}<p class="operator-field-help">Выключено — материалы ждут вашей проверки. Включено — проверенные материалы могут отправляться по своему расписанию.</p></div>
      <button class="secondary gs-poll-save" type="button">Сохранить автоматизацию</button>
      <span class="gs-poll-meta">${gsPollingMeta(connector.polling)}</span>
    </div>
    <div class="row-actions">
      <button class="secondary gs-test" type="button">Проверить</button>
      <button class="primary gs-preview" type="button">Посмотреть изменения</button>
      <button class="secondary gs-apply" type="button" ${preview?.canApply ? '' : 'disabled'}>Импортировать изменения</button>
      ${connector.config.writeBack ? '<button class="secondary gs-publication-writeback" type="button">Записать статусы сейчас</button>' : ''}
    </div>
    <div class="gs-result">${preview ? `<div class="operator-result ${preview.canApply ? 'ok' : 'error'}"><strong>${preview.canApply ? 'Предпросмотр готов.' : 'Импорт заблокирован.'}</strong> ${gsHelp("Технические сведения проверки", "<code>" + gsEsc(preview.sourceSnapshotSha256) + "</code>")}</div>${gsSummary(preview.summary)}${gsPreviewRows(preview)}` : ''}</div>
  </article>`;
}

async function loadGoogleConnectors(host) {
  const data = await googleSheetsApi('/api/google-sheets/connectors');
  const connectors = data.connectors || [];
  const list = host.querySelector('#gs-connectors-list');
  list.innerHTML = connectors.length ? connectors.map(connectorCard).join('') : '<div class="operator-empty">Google Sheets ещё не подключён.</div>';
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

function renderGoogleConnectForm(host) {
  const formHost = host.querySelector('#gs-connect-form-host');
  formHost.innerHTML = `<div class="gs-connect-form operator-section">
    <div class="operator-page-head"><div><h3>Подключить Google Sheets</h3><p>Создайте Service Account в Google Cloud, включите Sheets API и поделитесь нужной таблицей с email сервисного аккаунта.</p></div><button id="gs-close-connect" class="secondary" type="button">Закрыть</button></div>
    <form id="gs-connect-form" class="operator-form">
      <label class="full">Название подключения<input name="name" required placeholder="Например: План публикаций ASA Lab"></label>
      <label class="full">Ссылка на Google Таблицу или ID<input name="spreadsheetId" required placeholder="https://docs.google.com/spreadsheets/d/…/edit"></label>
      <div class="full gs-setup-guide"><strong>1. Подготовьте доступ Google</strong>${gsHelp("Где найти JSON", gsJsonGuide)}<p>Подключение состоит из двух шагов: ключ подтверждает личность сервисного аккаунта, а общий доступ к таблице разрешает ему читать её.</p></div><label class="full">JSON сервисного аккаунта Google<textarea name="credentials" required rows="9" autocomplete="off" placeholder='{"type":"service_account", ...}'></textarea><span class="operator-field-help">Вставьте содержимое файла целиком. После сохранения приватный ключ хранится зашифрованно и не возвращается в браузер.</span></label>
      <label class="full">Или выберите файл JSON<input id="gs-json-file" type="file" accept=".json,application/json"></label><div id="gs-share-hint" class="operator-secret-note">Вставьте JSON — здесь появится email, которому нужно открыть доступ к таблице.</div>
      <div class="row-actions full"><button id="gs-inspect" class="secondary" type="button">1. Проверить таблицу и получить листы</button></div>
      <label id="gs-sheet-wrap" class="full hidden">Лист<select name="sheetName"></select></label>
      <label id="gs-writeback-wrap" class="target-check hidden"><input name="writeBack" type="checkbox"> Записывать результат импорта и публикации обратно в таблицу (V:AD)</label>
      <div id="gs-connect-result" class="full"></div>
      <div class="row-actions full"><button id="gs-save" class="primary" type="submit" disabled>2. Сохранить подключение</button></div>
    </form>
  </div>`;
  const form = formHost.querySelector('#gs-connect-form');
  const credentialsInput = form.elements.credentials;
  const result = formHost.querySelector('#gs-connect-result');
  const save = formHost.querySelector('#gs-save');
  const sheetWrap = formHost.querySelector('#gs-sheet-wrap');
  const writeBackWrap = formHost.querySelector('#gs-writeback-wrap');
  let verified = '';

  const invalidate = () => { verified = ''; save.disabled = true; sheetWrap.classList.add('hidden'); writeBackWrap.classList.add('hidden'); result.innerHTML = ''; };
  [form.elements.spreadsheetId, credentialsInput].forEach((input) => input.addEventListener('input', invalidate));
  form.querySelector('#gs-json-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 65536) { result.textContent = 'JSON слишком большой: выберите файл ключа Google до 64 КБ.'; return; }
    credentialsInput.value = await file.text();
    credentialsInput.dispatchEvent(new Event('input', { bubbles: true }));
    event.target.value = '';
  });
  credentialsInput.addEventListener('input', () => {
    const email = serviceAccountIdentity(credentialsInput.value);
    formHost.querySelector('#gs-share-hint').innerHTML = email
      ? `<strong>2. Откройте доступ этому аккаунту:</strong> <code>${gsEsc(email)}</code><p>В нужной Google Таблице нажмите «Настройки доступа» → вставьте этот email → «Читатель» для импорта или «Редактор» для записи статусов → «Отправить». Ваш личный доступ к таблице не заменяет доступ сервисного аккаунта.</p>`
      : 'Вставьте корректный Service Account JSON — здесь появится email, которому нужно открыть доступ к таблице.';
  });
  formHost.querySelector('#gs-close-connect').onclick = () => { formHost.innerHTML = ''; };
  formHost.querySelector('#gs-inspect').onclick = async () => {
    const inspectButton = formHost.querySelector('#gs-inspect');
    if (inspectButton.disabled) return;
    inspectButton.disabled = true;
    result.innerHTML = '<div class="operator-result">Проверяю доступ к Spreadsheet…</div>';
    save.disabled = true;
    try {
      const credentials = gsCredentials(credentialsInput.value);
      const spreadsheetId = gsSpreadsheetId(form.elements.spreadsheetId.value);
      const inspection = await googleSheetsApi('/api/google-sheets/inspect', {
        method: 'POST', body: JSON.stringify({ spreadsheetId, credentials })
      });
      if (gsSpreadsheetId(form.elements.spreadsheetId.value) !== spreadsheetId || JSON.stringify(gsCredentials(credentialsInput.value)) !== JSON.stringify(credentials)) throw new Error('Поля изменились во время проверки. Проверьте таблицу заново.');
      const select = form.elements.sheetName;
      select.innerHTML = inspection.sheets.map((name) => `<option value="${gsEsc(name)}">${gsEsc(name)}</option>`).join('');
      sheetWrap.classList.remove('hidden');
      writeBackWrap.classList.remove('hidden');
      verified = JSON.stringify({ spreadsheetId, credentials });
      result.innerHTML = `<div class="operator-result ok"><strong>Доступ подтверждён.</strong> ${gsEsc(inspection.spreadsheetTitle)} · листов: ${inspection.sheets.length}</div>`;
      save.disabled = false;
    } catch (error) {
      verified = '';
      result.innerHTML = `<div class="operator-result error" role="alert">${gsEsc(gsActionableError(error, serviceAccountIdentity(credentialsInput.value)))}</div>`;
    } finally { inspectButton.disabled = false; }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    try {
      const credentials = gsCredentials(credentialsInput.value);
      const spreadsheetId = gsSpreadsheetId(form.elements.spreadsheetId.value);
      if (verified !== JSON.stringify({ spreadsheetId, credentials })) throw new Error('После изменения Spreadsheet ID или credentials выполните проверку заново.');
      result.innerHTML = '<div class="operator-result">Повторно проверяю и сохраняю connector…</div>';
      await googleSheetsApi('/api/google-sheets/connectors', {
        method: 'POST',
        body: JSON.stringify({
          name: String(form.elements.name.value || '').trim(),
          spreadsheetId,
          sheetName: String(form.elements.sheetName.value || '').trim(),
          writeBack: Boolean(form.elements.writeBack.checked),
          credentials
        })
      });
      formHost.innerHTML = '';
      await loadGoogleConnectors(host);
    } catch (error) {
      result.innerHTML = `<div class="operator-result error" role="alert">${gsEsc(gsActionableError(error, serviceAccountIdentity(credentialsInput.value)))}</div>`;
      save.disabled = !verified;
    }
  };
}

async function mountGoogleSheets() {
  if (googleSheetsMountBusy) return;
  if (document.querySelector('#page-title')?.textContent !== 'Источники / Интеграции') return;
  const layout = document.querySelector('.operator-source-layout');
  if (!layout || document.querySelector('#operator-google-sheets-live')) return;
  googleSheetsMountBusy = true;
  try {
    const cards = [...layout.querySelectorAll('.operator-connector-card')];
    const card = cards.find((item) => item.querySelector('strong')?.textContent?.trim() === 'Google Sheets');
    if (card) {
      card.innerHTML = '<strong>Google Sheets</strong><span>Постоянный план публикаций: подключите таблицу, проверьте строки и настройте импорт.</span><button id="gs-open-connect" class="secondary" type="button">Подключить</button>';
    }
    const host = document.createElement('section');
    host.id = 'operator-google-sheets-live';
    host.className = 'operator-section gs-live-section';
    host.innerHTML = `<div class="operator-page-head"><div><h3>Google Sheets</h3><p>Publikator читает лист «Публикации», показывает изменения до импорта и сохраняет канонические данные внутри Publikator.</p></div><a class="button-link secondary" href="/api/content-plan/v3/template.xlsx" download>Скачать XLSX шаблон</a></div><div id="gs-connect-form-host"></div><div id="gs-connectors-list"><div class="muted">Загрузка connectors…</div></div>`;
    layout.after(host);
    card?.querySelector('#gs-open-connect')?.addEventListener('click', () => renderGoogleConnectForm(host));
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
  section.innerHTML = '<h3>Откуда брать изображения</h3><p>Подключите папку отдельно от таблицы. Publikator скачивает JPEG/PNG и сохраняет проверенную копию внутри приложения. Подключение папки само ничего не публикует.</p><div class="row-actions"><button type="button" id="gs-add-drive">Подключить Google Drive</button><button type="button" id="gs-add-yandex">Подключить Яндекс Диск</button></div>' +
    gsHelp('Как связать изображение со строкой', '<p>В колонке media укажите название подключения и путь файла относительно выбранной папки. Например:</p><code>[{"source":"Фото проекта","path":"post-01.jpg"}]</code><p>Для нескольких изображений добавьте объекты в нужном порядке. Не указывайте путь Windows или ссылку страницы файла. Поддерживаются изображения; облачный импорт MP4 здесь не включён.</p>') +
    '<div id="gs-cloud-form"></div><div id="gs-cloud-list"></div>';
  host.append(section);
  async function refresh() {
    const list = section.querySelector('#gs-cloud-list');
    const results = await Promise.allSettled(['google-drive', 'yandex-disk'].map(async kind => {
      const response = await googleSheetsApi('/api/' + kind + '/connectors');
      return { kind, connectors: response.connectors || [] };
    }));
    list.innerHTML = results.map((item, index) => {
      const platform = index === 0 ? 'Google Drive' : 'Яндекс Диск';
      if (item.status !== 'fulfilled') return '<p role="alert">' + gsEsc(platform) + ': ' + gsEsc(gsActionableError(item.reason)) + '</p>';
      return item.value.connectors.map(connector => '<article class="gs-cloud-card"><strong>' + gsEsc(connector.name) + '</strong><span>' + platform + ' · ' + gsEsc(connector.config.rootFolderName || connector.config.rootFolderId || connector.config.rootPath) + '</span><button type="button" class="gs-cloud-test" data-kind="' + item.value.kind + '" data-id="' + gsEsc(connector.id) + '">Проверить папку</button><div class="gs-cloud-result" role="status"></div></article>').join('');
    }).join('') || '<p class="operator-field-help">Папки изображений ещё не подключены.</p>';
    list.querySelectorAll('.gs-cloud-test').forEach(button => button.addEventListener('click', async () => {
      const out = button.parentElement.querySelector('.gs-cloud-result');
      button.disabled = true;
      out.textContent = 'Проверяю доступ к папке…';
      try {
        await googleSheetsApi('/api/' + button.dataset.kind + '/connectors/' + encodeURIComponent(button.dataset.id) + '/test', { method: 'POST', body: '{}' });
        out.textContent = 'Папка доступна. Проверка не загружает и не публикует материалы.';
      } catch (error) { out.textContent = gsActionableError(error, '', button.dataset.kind); }
      finally { button.disabled = false; }
    }));
  }
  function open(kind) {
    const drive = kind === 'google-drive';
    const formHost = section.querySelector('#gs-cloud-form');
    formHost.innerHTML = '<form class="operator-form gs-media-form"><h4 class="full">' + (drive ? 'Google Drive' : 'Яндекс Диск') + ': папка изображений</h4>' +
      '<label class="full">Название подключения<input name="name" required placeholder="Фото проекта"></label>' +
      '<label class="full">' + (drive ? 'Ссылка на папку Google Drive или её ID' : 'Путь папки на Яндекс Диске') + '<input name="root" required placeholder="' + (drive ? 'https://drive.google.com/drive/folders/…' : '/Фото проекта') + '"></label>' +
      (drive ? '<label class="full">JSON сервисного аккаунта Google<textarea name="secret" required rows="5" autocomplete="off"></textarea></label>' + gsHelp('JSON для Google Drive', gsJsonGuide) + '<p class="full operator-field-help gs-drive-email">После вставки JSON здесь появится email. Выдайте ему доступ «Читатель» к папке и включите Google Drive API.</p>' :
        '<label class="full">OAuth-токен Яндекс Диска<input name="secret" type="password" required autocomplete="off"></label><p class="full operator-field-help">Нужен OAuth-токен с доступом к чтению файлов вашего Яндекс Диска. Публичная ссылка и пароль Яндекса не подходят. <a href="https://yandex.ru/dev/disk-api/doc/ru/" target="_blank" rel="noopener noreferrer">Инструкция API Яндекс Диска</a>.</p>') +
      '<div class="row-actions full"><button type="button" class="gs-media-inspect">1. Проверить папку</button><button type="submit" class="gs-media-save" disabled>2. Сохранить папку</button><button type="button" class="gs-media-close">Закрыть</button></div><div class="full gs-media-result" role="status"></div></form>';
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
    form.querySelector('.gs-media-close').onclick = () => { if (!busy) formHost.innerHTML = ''; };
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
        form.elements.secret.value = ''; formHost.innerHTML = '';
        await refresh();
      } catch (error) { out.textContent = gsActionableError(error, '', kind); }
      finally { busy = false; inspect.disabled = false; }
    };
  }
  section.querySelector('#gs-add-drive').onclick = () => open('google-drive');
  section.querySelector('#gs-add-yandex').onclick = () => open('yandex-disk');
  await refresh();
}
