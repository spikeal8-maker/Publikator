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
    return `<tr><td>${Number(row.rowNumber || 0)}</td><td><span class="operator-classification ${gsEsc(row.classification)}">${gsEsc(row.classification)}</span></td><td>${normalized ? gsEsc(normalized.title) : '—'}</td><td>${normalized ? gsEsc(normalized.project) : '—'}</td><td class="small error">${gsEsc((row.errors || []).join('; '))}</td></tr>`;
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

function connectorCard(connector) {
  const preview = googlePreviewByConnector.get(connector.id);
  return `<article class="gs-connector" data-gs-id="${gsEsc(connector.id)}">
    <div class="gs-connector-head">
      <div><strong>${gsEsc(connector.name)}</strong><span>${gsEsc(connector.config.spreadsheetId)} · ${gsEsc(connector.config.sheetName)}</span></div>
      <span class="badge">${connector.config.writeBack ? 'import + status write-back' : 'import only'}</span>
    </div>
    <div class="gs-connector-meta">Service account: <code>${gsEsc(connector.config.serviceAccountEmail)}</code></div>
    <div class="row-actions">
      <button class="secondary gs-test" type="button">Проверить</button>
      <button class="primary gs-preview" type="button">Preview sync</button>
      <button class="secondary gs-apply" type="button" ${preview?.canApply ? '' : 'disabled'}>Import new/changed rows</button>
    </div>
    <div class="gs-result">${preview ? `<div class="operator-result ${preview.canApply ? 'ok' : 'error'}"><strong>${preview.canApply ? 'Preview готов.' : 'Apply заблокирован.'}</strong> Sheet SHA: <code>${gsEsc(preview.sourceSnapshotSha256)}</code></div>${gsSummary(preview.summary)}${gsPreviewRows(preview)}` : ''}</div>
  </article>`;
}

async function loadGoogleConnectors(host) {
  const data = await googleSheetsApi('/api/google-sheets/connectors');
  const connectors = data.connectors || [];
  const list = host.querySelector('#gs-connectors-list');
  list.innerHTML = connectors.length ? connectors.map(connectorCard).join('') : '<div class="operator-empty">Google Sheets ещё не подключён.</div>';
  list.querySelectorAll('.gs-test').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('.gs-connector');
    const out = card.querySelector('.gs-result');
    out.innerHTML = '<div class="operator-result">Проверяю доступ к Google…</div>';
    try {
      const result = await googleSheetsApi(`/api/google-sheets/connectors/${encodeURIComponent(card.dataset.gsId)}/test`, { method: 'POST', body: '{}' });
      out.innerHTML = `<div class="operator-result ok"><strong>Подключение работает.</strong> ${gsEsc(result.spreadsheetTitle)} · лист ${gsEsc(result.sheetName)}</div>`;
    } catch (error) {
      out.innerHTML = `<div class="operator-result error">${gsEsc(error instanceof Error ? error.message : String(error))}</div>`;
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
      out.innerHTML = `<div class="operator-result error">${gsEsc(error instanceof Error ? error.message : String(error))}</div>`;
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
      out.innerHTML = `<div class="operator-result error">${gsEsc(error instanceof Error ? error.message : String(error))}</div>`;
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
      <label class="full">Название подключения<input name="name" required placeholder="ASA content sheet"></label>
      <label class="full">Spreadsheet ID<input name="spreadsheetId" required placeholder="ID между /d/ и /edit в URL таблицы"></label>
      <label class="full">Service Account JSON<textarea name="credentials" required rows="9" autocomplete="off" placeholder='{"type":"service_account", ...}'></textarea><span class="operator-field-help">Private key хранится только зашифрованно в Publikator.</span></label>
      <div id="gs-share-hint" class="operator-secret-note">Вставьте JSON — здесь появится email, которому нужно открыть доступ к таблице.</div>
      <div class="row-actions full"><button id="gs-inspect" class="secondary" type="button">1. Проверить таблицу и получить листы</button></div>
      <label id="gs-sheet-wrap" class="full hidden">Лист<select name="sheetName"></select></label>
      <label id="gs-writeback-wrap" class="target-check hidden"><input name="writeBack" type="checkbox"> Записывать служебный результат в V:Y</label>
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
  form.querySelectorAll('input,textarea').forEach((input) => input.addEventListener('input', invalidate));
  credentialsInput.addEventListener('input', () => {
    const email = serviceAccountIdentity(credentialsInput.value);
    formHost.querySelector('#gs-share-hint').innerHTML = email
      ? `Поделитесь Google Sheet с <code>${gsEsc(email)}</code>. Для import-only достаточно Viewer; для status write-back нужен Editor.`
      : 'Вставьте корректный Service Account JSON — здесь появится email, которому нужно открыть доступ к таблице.';
  });
  formHost.querySelector('#gs-close-connect').onclick = () => { formHost.innerHTML = ''; };
  formHost.querySelector('#gs-inspect').onclick = async () => {
    result.innerHTML = '<div class="operator-result">Проверяю доступ к Spreadsheet…</div>';
    save.disabled = true;
    try {
      const credentials = JSON.parse(credentialsInput.value);
      const spreadsheetId = String(form.elements.spreadsheetId.value || '').trim();
      const inspection = await googleSheetsApi('/api/google-sheets/inspect', {
        method: 'POST', body: JSON.stringify({ spreadsheetId, credentials })
      });
      const select = form.elements.sheetName;
      select.innerHTML = inspection.sheets.map((name) => `<option value="${gsEsc(name)}">${gsEsc(name)}</option>`).join('');
      sheetWrap.classList.remove('hidden');
      writeBackWrap.classList.remove('hidden');
      verified = JSON.stringify({ spreadsheetId, credentials });
      result.innerHTML = `<div class="operator-result ok"><strong>Доступ подтверждён.</strong> ${gsEsc(inspection.spreadsheetTitle)} · листов: ${inspection.sheets.length}</div>`;
      save.disabled = false;
    } catch (error) {
      verified = '';
      result.innerHTML = `<div class="operator-result error">${gsEsc(error instanceof Error ? error.message : String(error))}</div>`;
    }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      const credentials = JSON.parse(credentialsInput.value);
      const spreadsheetId = String(form.elements.spreadsheetId.value || '').trim();
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
      result.innerHTML = `<div class="operator-result error">${gsEsc(error instanceof Error ? error.message : String(error))}</div>`;
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
      card.innerHTML = '<strong>Google Sheets</strong><span>Реальный one-way connector: Preview → Import new/changed rows → DRAFT.</span><button id="gs-open-connect" class="secondary" type="button">Подключить</button>';
    }
    const host = document.createElement('section');
    host.id = 'operator-google-sheets-live';
    host.className = 'operator-section gs-live-section';
    host.innerHTML = `<div class="operator-page-head"><div><h3>Google Sheets</h3><p>Publikator читает schema v3 из выбранного листа. Google Sheets остаётся источником, а после Apply каноническое состояние живёт в Publikator.</p></div><a class="button-link secondary" href="/api/content-plan/v3/template.xlsx" download>Скачать XLSX шаблон</a></div><div id="gs-connect-form-host"></div><div id="gs-connectors-list"><div class="muted">Загрузка connectors…</div></div>`;
    layout.after(host);
    card?.querySelector('#gs-open-connect')?.addEventListener('click', () => renderGoogleConnectForm(host));
    await loadGoogleConnectors(host);
  } catch (error) {
    const host = document.querySelector('#operator-google-sheets-live');
    if (host) host.innerHTML = `<div class="operator-result error">${gsEsc(error instanceof Error ? error.message : String(error))}</div>`;
  } finally {
    googleSheetsMountBusy = false;
  }
}

const googleSheetsObserver = new MutationObserver(() => mountGoogleSheets().catch(() => {}));
googleSheetsObserver.observe(document.body, { childList: true, subtree: true });
setTimeout(() => mountGoogleSheets().catch(() => {}), 0);
