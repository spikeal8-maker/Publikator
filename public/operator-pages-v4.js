import { statusLabel } from './presentation-labels.js';
import { mountRichTextEditor, plainTextToRichDocument } from './rich-text-editor-v1.js';

const operatorView = document.querySelector('#view');
const operatorTitle = document.querySelector('#page-title');
const operatorApp = document.querySelector('#app');
let operatorRouting = false;
let operatorInitialRouted = false;
let operatorSourceFile = null;
let operatorSourcePreview = null;
let operatorSourcePreviewId = '';

async function operatorApi(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body === undefined || options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {})
    }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.reload();
    throw new Error('Требуется вход');
  }
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function operatorEsc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

const OPERATOR_PLATFORM = {
  telegram: { label: 'Telegram', note: 'Бот публикует в конкретный канал или чат.' },
  vk: { label: 'VK', note: 'Публикация идёт на стену конкретной группы.' },
  max: { label: 'MAX', note: 'Бот публикует в конкретный чат или канал.' },
  instagram: { label: 'Instagram', note: 'Публикация в профессиональный аккаунт Instagram.' }
};

function telegramDestination(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^https?:\/\/t\.me\/([A-Za-z0-9_]+)\/?$/i);
  return match ? `@${match[1]}` : raw;
}

function vkGroupId(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:club)?(\d+)\/?$/i);
  if (!match) throw new Error('VK: укажите числовой ID группы или адрес вида vk.com/club123456');
  return match[1];
}

function credentialFields(platform) {
  if (platform === 'telegram') return `
    <label class="full">Токен бота<input name="botToken" type="password" autocomplete="off" required placeholder="123456:ABC…"><span class="operator-field-help">Токен из BotFather. Он хранится зашифрованно.</span></label>
    <label class="full">Куда публиковать<input name="chatId" required placeholder="@my_channel или https://t.me/my_channel"><span class="operator-field-help">Укажите канал/чат. Бот должен иметь право публиковать туда.</span></label>`;
  if (platform === 'vk') return `
    <label class="full">Access token<input name="accessToken" type="password" autocomplete="off" required><span class="operator-field-help">Токен с правами, достаточными для публикации от имени группы.</span></label>
    <label class="full">Куда публиковать<input name="groupId" required placeholder="123456789 или https://vk.com/club123456789"><span class="operator-field-help">Числовой ID группы. API version Publikator подставит автоматически.</span></label>`;
  if (platform === 'max') return `
    <label class="full">Токен бота<input name="accessToken" type="password" autocomplete="off" required><span class="operator-field-help">Токен MAX-бота.</span></label>
    <label class="full">Куда публиковать<input name="chatId" required placeholder="ID чата / канала"><span class="operator-field-help">Укажите точный ID назначения, где бот имеет право писать.</span></label>`;
  return `
    <label class="full">Access token<input name="accessToken" type="password" autocomplete="off" required></label>
    <label>Instagram User ID<input name="igUserId" required placeholder="Professional account ID"></label>
    <label>Graph API version<input name="graphVersion" required placeholder="vXX.X"></label>`;
}

function credentialsFromForm(platform, form) {
  const data = new FormData(form);
  if (platform === 'telegram') return { botToken: String(data.get('botToken') || '').trim(), chatId: telegramDestination(data.get('chatId')) };
  if (platform === 'vk') return { accessToken: String(data.get('accessToken') || '').trim(), groupId: vkGroupId(data.get('groupId')), apiVersion: '5.199' };
  if (platform === 'max') return { accessToken: String(data.get('accessToken') || '').trim(), chatId: String(data.get('chatId') || '').trim() };
  return { accessToken: String(data.get('accessToken') || '').trim(), igUserId: String(data.get('igUserId') || '').trim(), graphVersion: String(data.get('graphVersion') || '').trim() };
}

function renderSocialConnectForm(platform) {
  const host = document.querySelector('#operator-social-connect');
  if (!host) return;
  const meta = OPERATOR_PLATFORM[platform];
  host.innerHTML = `<div class="operator-section">
    <div class="operator-page-head"><div><h3>Подключить ${meta.label}</h3><p>${meta.note}</p></div><button id="operator-close-connect" class="secondary" type="button">Закрыть</button></div>
    <form id="operator-social-form" class="operator-form">
      <label class="full">Название подключения<input name="name" required placeholder="Например: Основной канал"><span class="operator-field-help">Это название будет видно при выборе площадки у публикации.</span></label>
      ${credentialFields(platform)}
      <div class="operator-secret-note">Секреты вводятся только здесь, на вашем Publikator. В интерфейсе они обратно не показываются.</div>
      <div id="operator-connect-result" class="operator-test-result"></div>
      <div class="row-actions full"><button id="operator-test-connect" class="secondary" type="button">Проверить подключение</button><button id="operator-save-connect" class="primary" type="submit" disabled>Сохранить подключение</button></div>
    </form>
  </div>`;
  const form = host.querySelector('#operator-social-form');
  const result = host.querySelector('#operator-connect-result');
  const save = host.querySelector('#operator-save-connect');
  let verifiedFingerprint = '';
  const invalidate = () => { verifiedFingerprint = ''; save.disabled = true; result.innerHTML = ''; };
  form.querySelectorAll('input').forEach((input) => input.addEventListener('input', invalidate));
  host.querySelector('#operator-close-connect').onclick = () => { host.innerHTML = ''; };
  host.querySelector('#operator-test-connect').onclick = async () => {
    result.innerHTML = '<div class="operator-result">Проверяю токен и назначение через API…</div>';
    save.disabled = true;
    try {
      const credentials = credentialsFromForm(platform, form);
      const checked = await operatorApi('/api/accounts/test', { method: 'POST', body: JSON.stringify({ platform, credentials }) });
      verifiedFingerprint = JSON.stringify(credentials);
      result.innerHTML = `<div class="operator-result ok"><strong>Подключение работает.</strong><br>${operatorEsc(checked.identity)} → <strong>${operatorEsc(checked.destination)}</strong></div>`;
      save.disabled = false;
    } catch (error) {
      verifiedFingerprint = '';
      result.innerHTML = `<div class="operator-result error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
    }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      const credentials = credentialsFromForm(platform, form);
      if (!verifiedFingerprint || verifiedFingerprint !== JSON.stringify(credentials)) throw new Error('Сначала нажмите «Проверить подключение» после последнего изменения полей.');
      result.innerHTML = '<div class="operator-result">Повторно проверяю доступ перед сохранением…</div>';
      const checked = await operatorApi('/api/accounts/test', { method: 'POST', body: JSON.stringify({ platform, credentials }) });
      const data = new FormData(form);
      await operatorApi('/api/accounts', { method: 'POST', body: JSON.stringify({ platform, name: String(data.get('name') || '').trim(), credentials }) });
      result.innerHTML = `<div class="operator-result ok">Сохранено: ${operatorEsc(checked.identity)} → ${operatorEsc(checked.destination)}</div>`;
      setTimeout(() => renderSocialsPage(), 250);
    } catch (error) {
      result.innerHTML = `<div class="operator-result error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
    }
  };
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function renderSocialsPage() {
  operatorTitle.textContent = 'Соцсети';
  operatorView.innerHTML = '<div class="muted">Загрузка подключений…</div>';
  try {
    const accounts = await operatorApi('/api/accounts');
    operatorView.innerHTML = `<div class="operator-page">
      <div class="operator-page-head"><div><h2>Соцсети</h2><p>Подключите площадку, проверьте токен и укажите конкретный канал, группу или чат. Сохранить можно только проверенное подключение.</p></div></div>
      <div class="operator-platform-grid">${Object.entries(OPERATOR_PLATFORM).map(([key, meta]) => `<div class="operator-platform-card" data-platform="${key}"><strong>${meta.label}</strong><span>${meta.note}</span><button class="secondary operator-add-platform" type="button" data-platform="${key}">Подключить</button></div>`).join('')}</div>
      <div id="operator-social-connect"></div>
      <section class="operator-section"><h3>Подключённые площадки</h3><p>«Проверить» ничего не публикует: только подтверждает учётную запись и назначение.</p>
        <div class="operator-connection-list">${accounts.length ? accounts.map((account) => `<div class="operator-connection" data-account-id="${operatorEsc(account.id)}"><span class="operator-platform-badge">${operatorEsc(account.platform)}</span><div class="operator-connection-main"><strong>${operatorEsc(account.name)}</strong><span>${account.enabled ? 'Включено' : 'Отключено'} · назначение можно подтвердить кнопкой «Проверить»</span><div class="operator-account-result"></div></div><div class="operator-connection-actions"><button class="secondary operator-test-account" type="button">Проверить</button><button class="secondary operator-toggle-account" type="button" data-enabled="${account.enabled ? '1' : '0'}">${account.enabled ? 'Отключить' : 'Включить'}</button></div></div>`).join('') : '<div class="operator-empty">Пока нет ни одного подключения. Выберите площадку выше.</div>'}</div>
      </section>
    </div>`;
    operatorView.querySelectorAll('.operator-add-platform').forEach((button) => button.addEventListener('click', () => renderSocialConnectForm(button.dataset.platform)));
    operatorView.querySelectorAll('.operator-test-account').forEach((button) => button.addEventListener('click', async () => {
      const row = button.closest('.operator-connection');
      const out = row.querySelector('.operator-account-result');
      out.innerHTML = '<div class="operator-result">Проверяю…</div>';
      try {
        const checked = await operatorApi(`/api/accounts/${encodeURIComponent(row.dataset.accountId)}/test`, { method: 'POST' });
        out.innerHTML = `<div class="operator-result ok">${operatorEsc(checked.identity)} → <strong>${operatorEsc(checked.destination)}</strong></div>`;
      } catch (error) {
        out.innerHTML = `<div class="operator-result error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
      }
    }));
    operatorView.querySelectorAll('.operator-toggle-account').forEach((button) => button.addEventListener('click', async () => {
      const row = button.closest('.operator-connection');
      await operatorApi(`/api/accounts/${encodeURIComponent(row.dataset.accountId)}`, { method: 'PATCH', body: JSON.stringify({ enabled: button.dataset.enabled !== '1' }) });
      await renderSocialsPage();
    }));
  } catch (error) {
    operatorView.innerHTML = `<div class="card error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function sourceSummary(summary = {}) {
  const items = [
    ['Всего', summary.totalRows], ['Новые', summary.newRows], ['Обновления', summary.updateRows],
    ['Без изменений', summary.unchangedRows], ['Конфликты', summary.conflicts], ['Ошибки', summary.errors]
  ];
  return `<div class="operator-source-summary">${items.map(([label, value]) => `<div class="operator-source-metric"><strong>${Number(value || 0)}</strong><span>${label}</span></div>`).join('')}</div>`;
}

function sourcePreviewRows(validation) {
  const rows = (validation.rows || []).slice(0, 100);
  if (!rows.length) return '';
  return `<div class="operator-preview-table"><table class="table"><thead><tr><th>Строка</th><th>Результат</th><th>Материал</th><th>Проект</th><th>Площадки</th><th>Что исправить</th></tr></thead><tbody>${rows.map((row) => {
    const normalized = row.normalized;
    return `<tr><td>${Number(row.rowNumber || 0)}</td><td><span class="operator-classification ${operatorEsc(row.classification)}" data-raw-classification="${operatorEsc(row.classification)}">${operatorEsc(statusLabel(row.classification))}</span></td><td>${normalized ? operatorEsc(normalized.title) : '—'}</td><td>${normalized ? operatorEsc(normalized.project) : '—'}</td><td>${normalized ? operatorEsc((normalized.targets || []).map((target) => `${target.platform}: ${target.name}`).join(', ') || '—') : '—'}</td><td class="small error">${operatorEsc((row.errors || []).join('; '))}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

async function previewSourceFile() {
  const sourceId = String(document.querySelector('#operator-source-id')?.value || '').trim();
  const result = document.querySelector('#operator-source-result');
  const apply = document.querySelector('#operator-source-apply');
  if (!sourceId) { result.innerHTML = '<div class="operator-result error">Задайте ID источника.</div>'; return; }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sourceId)) { result.innerHTML = '<div class="operator-result error">ID источника: только A-Z, a-z, 0-9, точка, подчёркивание, двоеточие или дефис.</div>'; return; }
  if (!operatorSourceFile) { result.innerHTML = '<div class="operator-result error">Выберите CSV или XLSX.</div>'; return; }
  operatorSourcePreview = null;
  operatorSourcePreviewId = '';
  apply.disabled = true;
  result.innerHTML = '<div class="operator-result">Проверяю таблицу без изменения базы…</div>';
  try {
    const data = new FormData();
    data.set('file', operatorSourceFile);
    const validation = await operatorApi(`/api/content-plan/v3/import/preview?sourceId=${encodeURIComponent(sourceId)}`, { method: 'POST', body: data });
    operatorSourcePreview = validation;
    operatorSourcePreviewId = sourceId;
    localStorage.setItem('publikator.operator.sourceId', sourceId);
    result.innerHTML = `<div class="operator-result ${validation.canApply ? 'ok' : 'error'}"><strong>${validation.canApply ? 'Таблица готова к применению.' : 'Применение заблокировано.'}</strong> Preview ничего не публикует наружу.</div>${sourceSummary(validation.summary)}${sourcePreviewRows(validation)}`;
    apply.disabled = !validation.canApply;
  } catch (error) {
    result.innerHTML = `<div class="operator-result error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

async function applySourceFile() {
  const sourceId = String(document.querySelector('#operator-source-id')?.value || '').trim();
  const result = document.querySelector('#operator-source-result');
  const apply = document.querySelector('#operator-source-apply');
  if (!operatorSourceFile || !operatorSourcePreview?.canApply || operatorSourcePreviewId !== sourceId) {
    result.innerHTML = '<div class="operator-result error">После изменения файла или ID источника выполните preview заново.</div>';
    return;
  }
  if (!window.confirm('Применить проверенную таблицу? Новые записи создаются как DRAFT; автоматической публикации наружу не будет.')) return;
  apply.disabled = true;
  result.innerHTML = '<div class="operator-result">Применяю проверенный источник…</div>';
  try {
    const data = new FormData();
    data.set('file', operatorSourceFile);
    const applied = await operatorApi(`/api/content-plan/v3/import/apply?sourceId=${encodeURIComponent(sourceId)}`, {
      method: 'POST', body: data,
      headers: { 'x-publikator-content-plan': 'IMPORT', 'x-content-plan-sha256': operatorSourcePreview.fileSha256 }
    });
    result.innerHTML = `<div class="operator-result ok"><strong>Источник применён.</strong> Создано: ${Number(applied.created || 0)}, обновлено: ${Number(applied.updated || 0)}, без изменений: ${Number(applied.unchanged || 0)}, архивировано: ${Number(applied.archived || 0)}, в корзину: ${Number(applied.trashed || 0)}.</div><div class="row-actions" style="margin-top:10px"><button id="operator-open-content-after-import" class="primary" type="button">Открыть контент</button></div>`;
    document.querySelector('#operator-open-content-after-import').onclick = () => operatorGo('/content');
    operatorSourcePreview = null;
    operatorSourcePreviewId = '';
  } catch (error) {
    apply.disabled = false;
    result.innerHTML = `<div class="operator-result error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}


const INTEGRATION_API_UI_SCOPES = [
  ['content:draft:write', 'Создание и редактирование DRAFT'],
  ['content:read', 'Чтение Integration API публикаций'],
  ['schedule:write', 'Изменение расписания'],
  ['approval:request', 'Отправка на проверку']
];

function integrationTokenModal(token) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay integration-token-modal';
  overlay.innerHTML = `<div class="modal-card">
    <h2>Скопируйте ключ сейчас</h2>
    <p>После закрытия он больше не будет показан.</p>
    <label>API token<input class="integration-token-once" type="text" readonly value="${operatorEsc(token)}"></label>
    <div class="row-actions">
      <button class="primary integration-token-copy" type="button">Копировать</button>
      <button class="secondary integration-token-close" type="button">Закрыть</button>
    </div>
  </div>`;
  const input = overlay.querySelector('.integration-token-once');
  const close = () => {
    input.value = '';
    overlay.remove();
  };
  overlay.querySelector('.integration-token-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      overlay.querySelector('.integration-token-copy').textContent = 'Скопировано';
    } catch {
      input.select();
    }
  };
  overlay.querySelector('.integration-token-close').onclick = close;
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  document.body.append(overlay);
}

function integrationKeyForm() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay integration-key-form-modal';
  overlay.innerHTML = `<div class="modal-card">
    <h2>Новый API-ключ</h2>
    <form class="operator-form integration-key-form">
      <label class="full">Название<input name="name" required maxlength="120" placeholder="AI publisher bot"></label>
      <div class="full"><span class="rich-text-label">Scopes</span>
        <div class="target-picker">${INTEGRATION_API_UI_SCOPES.map(([scope, label]) =>
          `<label class="target-check"><input type="checkbox" name="scope" value="${operatorEsc(scope)}"> ${operatorEsc(label)} <code>${operatorEsc(scope)}</code></label>`
        ).join('')}</div>
      </div>
      <div class="integration-key-form-error error full"></div>
      <div class="row-actions full">
        <button class="primary" type="submit">Создать</button>
        <button class="secondary integration-key-form-close" type="button">Отмена</button>
      </div>
    </form>
  </div>`;
  const form = overlay.querySelector('.integration-key-form');
  const close = () => overlay.remove();
  overlay.querySelector('.integration-key-form-close').onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const error = overlay.querySelector('.integration-key-form-error');
    error.textContent = '';
    try {
      const data = new FormData(form);
      const scopes = [...form.querySelectorAll('input[name="scope"]:checked')].map((input) => input.value);
      const created = await operatorApi('/api/integration-keys', {
        method: 'POST',
        body: JSON.stringify({ name: String(data.get('name') || '').trim(), scopes })
      });
      const token = String(created.token || '');
      close();
      await loadIntegrationApiKeys();
      integrationTokenModal(token);
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
    }
  };
  document.body.append(overlay);
}

function integrationKeyRows(keys) {
  if (!keys.length) return '<tr><td colspan="7">API-ключей пока нет</td></tr>';
  return keys.map((key) => `<tr data-api-key-id="${operatorEsc(key.id)}">
    <td><strong>${operatorEsc(key.name)}</strong></td>
    <td><code>${operatorEsc(key.prefix)}</code></td>
    <td class="small">${operatorEsc((key.scopes || []).join(', '))}</td>
    <td class="small">${operatorEsc(new Date(key.createdAt).toLocaleString())}</td>
    <td class="small">${key.lastUsedAt ? operatorEsc(new Date(key.lastUsedAt).toLocaleString()) : '—'}</td>
    <td>${key.revokedAt ? '<span class="badge">Отозван</span>' : '<span class="badge ok">Активен</span>'}</td>
    <td><div class="row-actions">
      ${key.revokedAt ? '' : '<button class="secondary integration-key-rotate" type="button">Rotate</button><button class="secondary danger integration-key-revoke" type="button">Revoke</button>'}
    </div></td>
  </tr>`).join('');
}

async function loadIntegrationApiKeys() {
  const host = document.querySelector('#operator-integration-api');
  if (!host) return;
  const body = host.querySelector('tbody');
  const result = host.querySelector('.integration-api-result');
  try {
    const response = await operatorApi('/api/integration-keys');
    const keys = response.keys || [];
    body.innerHTML = integrationKeyRows(keys);
    body.querySelectorAll('.integration-key-rotate').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('[data-api-key-id]');
        if (!window.confirm('Rotate API-ключ? Старый token сразу перестанет работать.')) return;
        try {
          const rotated = await operatorApi(`/api/integration-keys/${encodeURIComponent(row.dataset.apiKeyId)}/rotate`, { method: 'POST', body: '{}' });
          const token = String(rotated.token || '');
          await loadIntegrationApiKeys();
          integrationTokenModal(token);
        } catch (failure) {
          result.textContent = failure instanceof Error ? failure.message : String(failure);
        }
      };
    });
    body.querySelectorAll('.integration-key-revoke').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('[data-api-key-id]');
        if (!window.confirm('Отозвать API-ключ?')) return;
        try {
          await operatorApi(`/api/integration-keys/${encodeURIComponent(row.dataset.apiKeyId)}/revoke`, { method: 'POST', body: '{}' });
          await loadIntegrationApiKeys();
        } catch (failure) {
          result.textContent = failure instanceof Error ? failure.message : String(failure);
        }
      };
    });
  } catch (failure) {
    result.textContent = failure instanceof Error ? failure.message : String(failure);
  }
}

async function renderSourcesPage() {
  operatorTitle.textContent = 'Источники / Интеграции';
  operatorView.innerHTML = '<div class="muted">Загрузка источников…</div>';
  try {
    const schema = await operatorApi('/api/content-plan/v3/schema');
    const savedSourceId = localStorage.getItem('publikator.operator.sourceId') || 'content-plan';
    operatorSourceFile = null;
    operatorSourcePreview = null;
    operatorSourcePreviewId = '';
    operatorView.innerHTML = `<div class="operator-page">
      <div class="operator-page-head"><div><h2>Источники / Интеграции</h2><p>Загружайте контент пачками из Excel/CSV или подключайте Google Sheets. Повторная версия одного набора обновляет строки вместо создания дублей.</p></div></div>
      <div class="operator-source-layout">
        <section class="operator-section"><h3>Таблица Excel / CSV</h3><p>Скачайте русский шаблон, заполните лист «Публикации», затем сначала проверьте файл. Импорт станет доступен только после успешной проверки этой же версии.</p>
          <div class="operator-form"><label class="full">Название набора<input id="operator-source-id" value="${operatorEsc(savedSourceId)}" pattern="[A-Za-z0-9._:-]{1,128}" required><span class="operator-field-help">Например: social-plan. Используйте одно название для повторных версий одной и той же таблицы.</span></label></div>
          <div class="operator-actions" style="margin:14px 0"><a class="button-link secondary" href="/api/content-plan/v3/template.xlsx" download>Скачать шаблон XLSX</a></div>
          <label class="operator-drop"><input id="operator-source-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><strong>Выбрать CSV / XLSX</strong><span id="operator-source-file-name">Файл не выбран</span></label>
          <div class="operator-actions" style="margin-top:14px"><button id="operator-source-preview" class="primary" type="button" disabled>1. Проверить таблицу</button><button id="operator-source-apply" class="secondary" type="button" disabled>2. Импортировать</button></div>
          <div id="operator-source-result"></div>
        </section>
        <aside class="operator-section"><h3>Подключения</h3><p>Здесь показаны доступные способы загрузки контента и внешних медиа.</p>
          <div class="operator-connector-card"><strong>Excel / CSV</strong><span>Работает. Повторная загрузка обновляет существующие строки без дублей.</span></div>
          <div class="operator-connector-card" style="margin-top:10px"><strong>Google Sheets</strong><span>Подключение и автоматизация доступны ниже на этой странице.</span></div>
          <div class="operator-connector-card" style="margin-top:10px"><strong>Google Drive / Яндекс Диск</strong><span>Поддерживаются как источники изображений для Google Sheets; файлы после импорта сохраняются локально в Publikator.</span></div>
        </aside>
      </div>
      <section class="operator-section" id="operator-integration-api">
        <div class="operator-page-head"><div><h3>Integration API</h3><p>Создайте Bearer API key для бота или AI. Полный token показывается только один раз.</p></div><button id="operator-new-api-key" class="primary" type="button">+ Новый API-ключ</button></div>
        <table class="table"><thead><tr><th>Название</th><th>Prefix</th><th>Scopes</th><th>Создан</th><th>Последнее использование</th><th>Статус</th><th>Действия</th></tr></thead><tbody><tr><td colspan="7">Загрузка…</td></tr></tbody></table>
        <div class="integration-api-result error"></div>
      </section>
    </div>`;
    const file = document.querySelector('#operator-source-file');
    const preview = document.querySelector('#operator-source-preview');
    const apply = document.querySelector('#operator-source-apply');
    const sourceIdInput = document.querySelector('#operator-source-id');
    const invalidate = () => { operatorSourcePreview = null; operatorSourcePreviewId = ''; apply.disabled = true; document.querySelector('#operator-source-result').innerHTML = ''; };
    sourceIdInput.addEventListener('input', invalidate);
    file.addEventListener('change', () => {
      operatorSourceFile = file.files?.[0] || null;
      invalidate();
      document.querySelector('#operator-source-file-name').textContent = operatorSourceFile ? `${operatorSourceFile.name} · ${(operatorSourceFile.size / 1024).toFixed(1)} КБ` : 'Файл не выбран';
      preview.disabled = !operatorSourceFile;
    });
    preview.onclick = previewSourceFile;
    apply.onclick = applySourceFile;
    document.querySelector('#operator-new-api-key').onclick = integrationKeyForm;
    await loadIntegrationApiKeys();
  } catch (error) {
    operatorView.innerHTML = `<div class="card error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}


const REUSABLE_TEMPLATE_TYPES = ['SNIPPET','CTA','SIGNATURE','HASHTAG_SET'];
const REUSABLE_TEMPLATE_META = {
  SNIPPET: { label: 'Фрагмент', plural: 'Фрагменты' },
  CTA: { label: 'CTA', plural: 'CTA' },
  SIGNATURE: { label: 'Подпись', plural: 'Подписи' },
  HASHTAG_SET: { label: 'Набор хэштегов', plural: 'Хэштеги' }
};

function isReusableTemplateType(value) {
  return REUSABLE_TEMPLATE_TYPES.includes(String(value || ''));
}

function templateTargetSummary(template, accountsById) {
  if (template.targetAccountIds === null) return 'По умолчанию проекта';
  if (!template.targetAccountIds.length) return 'Не выбраны';
  return template.targetAccountIds.map((accountId) => {
    const account = accountsById.get(accountId);
    return account ? `${OPERATOR_PLATFORM[account.platform]?.label || account.platform} / ${account.name}` : `Недоступен / ${accountId}`;
  }).join(', ');
}

async function renderTemplateEditor(templateId = null) {
  operatorTitle.textContent = 'Шаблоны';
  operatorView.innerHTML = '<div class="muted">Загрузка шаблона…</div>';
  try {
    const [templates, projects, accounts] = await Promise.all([
      operatorApi('/api/templates'),
      operatorApi('/api/projects'),
      operatorApi('/api/accounts')
    ]);
    const template = templateId ? templates.find((item) => item.id === templateId) : null;
    if (templateId && !template) throw new Error('Шаблон не найден');
    const selectedTargets = new Set(template?.targetAccountIds || []);
    const useProjectDefaults = template?.targetAccountIds === null || !template;
    operatorView.innerHTML = `<div class="operator-page">
      <div class="operator-page-head"><div><h2>${template ? 'Редактировать шаблон' : 'Новый шаблон'}</h2><p>Шаблон хранит снимок текста и настроек. Созданная публикация дальше живёт независимо.</p></div><button id="operator-template-back" class="secondary" type="button">К шаблонам</button></div>
      <form id="operator-template-form" class="operator-form">
        <label>Название<input name="name" required value="${operatorEsc(template?.name || '')}" placeholder="Например: Анонс урока"></label>
        <label>Key<input name="key" required pattern="[A-Za-z0-9._:-]{1,128}" value="${operatorEsc(template?.key || '')}" placeholder="lesson-announcement"><span class="operator-field-help">Стабильный ключ для будущих интеграций.</span></label>
        <label>Проект<select name="projectId">${projects.map((project) => `<option value="${operatorEsc(project.id)}" ${template?.projectId === project.id ? 'selected' : ''}>${operatorEsc(project.name)}</option>`).join('')}</select></label>
        <label>Тип публикации<select name="publicationKind"><option value="FEED">Пост / FEED</option><option value="SHORT" ${template?.publicationKind === 'SHORT' ? 'selected' : ''}>Короткое видео / SHORT</option><option value="STORY" ${template?.publicationKind === 'STORY' ? 'selected' : ''}>История / STORY</option></select></label>
        <label>Формат<select name="contentFormat"><option value="TEXT_ONLY">Только текст</option><option value="IMAGE" ${!template || template?.contentFormat === 'IMAGE' ? 'selected' : ''}>Изображение</option><option value="CAROUSEL" ${template?.contentFormat === 'CAROUSEL' ? 'selected' : ''}>Карусель</option><option value="VIDEO" ${template?.contentFormat === 'VIDEO' ? 'selected' : ''}>Видео</option><option value="VERTICAL_VIDEO" ${template?.contentFormat === 'VERTICAL_VIDEO' ? 'selected' : ''}>Вертикальное видео</option><option value="STORY_SEQUENCE" ${template?.contentFormat === 'STORY_SEQUENCE' ? 'selected' : ''}>Серия историй</option></select></label>
        <label>Режим публикации<select name="scheduleMode"><option value="MANUAL">Вручную</option><option value="QUEUE" ${template?.scheduleMode === 'QUEUE' ? 'selected' : ''}>Очередь</option><option value="AT" ${template?.scheduleMode === 'AT' ? 'selected' : ''}>Указать время после создания</option></select><span class="operator-field-help">Шаблон не хранит абсолютную будущую дату.</span></label>
        <div class="full rich-text-field"><span class="rich-text-label">Текст</span><div id="operator-template-rich" data-template-rich-editor></div></div>
        <div class="full"><label class="target-check"><input id="operator-template-project-defaults" type="checkbox" ${useProjectDefaults ? 'checked' : ''}> Использовать площадки проекта по умолчанию</label>
          <div class="target-picker" id="operator-template-targets">${accounts.map((account) => `<label class="target-check"><input type="checkbox" name="templateTarget" value="${operatorEsc(account.id)}" ${selectedTargets.has(account.id) ? 'checked' : ''}> ${operatorEsc(OPERATOR_PLATFORM[account.platform]?.label || account.platform)} — ${operatorEsc(account.name)}${account.enabled ? '' : ' · отключено'}</label>`).join('') || '<span class="muted">Нет подключённых соцсетей</span>'}</div>
        </div>
        <div id="operator-template-error" class="error full"></div>
        <div class="row-actions full"><button class="primary" type="submit">Сохранить</button><button id="operator-template-cancel" class="secondary" type="button">Отмена</button></div>
      </form>
    </div>`;
    const form = operatorView.querySelector('#operator-template-form');
    const richEditor = mountRichTextEditor(form.querySelector('[data-template-rich-editor]'), {
      document: template?.bodyRich || plainTextToRichDocument('')
    });
    const defaults = form.querySelector('#operator-template-project-defaults');
    const syncTargetMode = () => form.querySelectorAll('input[name="templateTarget"]').forEach((input) => { input.disabled = defaults.checked; });
    defaults.addEventListener('change', syncTargetMode);
    syncTargetMode();
    operatorView.querySelector('#operator-template-back').onclick = renderTemplatesPage;
    operatorView.querySelector('#operator-template-cancel').onclick = renderTemplatesPage;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const error = form.querySelector('#operator-template-error');
      error.textContent = '';
      try {
        const data = new FormData(form);
        const payload = {
          name: String(data.get('name') || '').trim(),
          key: String(data.get('key') || '').trim(),
          projectId: String(data.get('projectId') || ''),
          bodyRich: richEditor.getDocument(),
          publicationKind: String(data.get('publicationKind') || 'FEED'),
          contentFormat: String(data.get('contentFormat') || 'IMAGE'),
          scheduleMode: String(data.get('scheduleMode') || 'MANUAL'),
          targetAccountIds: defaults.checked ? null : [...form.querySelectorAll('input[name="templateTarget"]:checked')].map((input) => input.value)
        };
        await operatorApi(template ? `/api/templates/${encodeURIComponent(template.id)}` : '/api/templates', {
          method: template ? 'PATCH' : 'POST',
          body: JSON.stringify(payload)
        });
        await renderTemplatesPage();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : String(failure);
      }
    };
  } catch (error) {
    operatorView.innerHTML = `<div class="card error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}


async function renderReusableBlockEditor(templateId = null, requestedType = 'SNIPPET') {
  operatorTitle.textContent = 'Шаблоны';
  operatorView.innerHTML = '<div class="muted">Загрузка заготовки…</div>';
  try {
    const [templates, projects] = await Promise.all([
      operatorApi('/api/templates'),
      operatorApi('/api/projects')
    ]);
    const template = templateId ? templates.find((item) => item.id === templateId) : null;
    if (templateId && !template) throw new Error('Заготовка не найдена');
    const templateType = template?.templateType || requestedType;
    if (!isReusableTemplateType(templateType)) throw new Error('Неверный тип заготовки');
    const meta = REUSABLE_TEMPLATE_META[templateType];

    operatorView.innerHTML = `<div class="operator-page">
      <div class="operator-page-head"><div><h2>${template ? 'Редактировать' : 'Новая'}: ${operatorEsc(meta.label)}</h2><p>Заготовка хранит canonical rich text. После вставки в публикацию это обычная копия текста.</p></div><button id="operator-template-back" class="secondary" type="button">К шаблонам</button></div>
      <form id="operator-reusable-form" class="operator-form">
        <label>Название<input name="name" required value="${operatorEsc(template?.name || '')}" placeholder="Например: Записаться на курс"></label>
        <label>Key<input name="key" required pattern="[A-Za-z0-9._:-]{1,128}" value="${operatorEsc(template?.key || '')}" placeholder="course-cta"></label>
        <label>Проект<select name="projectId">${projects.map((project) => `<option value="${operatorEsc(project.id)}" ${template?.projectId === project.id ? 'selected' : ''}>${operatorEsc(project.name)}</option>`).join('')}</select></label>
        <label>Тип<input value="${operatorEsc(meta.label)}" disabled></label>
        <div class="full rich-text-field"><span class="rich-text-label">Текст</span><div data-reusable-rich-editor></div></div>
        <div id="operator-template-error" class="error full"></div>
        <div class="row-actions full"><button class="primary" type="submit">Сохранить</button><button id="operator-template-cancel" class="secondary" type="button">Отмена</button></div>
      </form>
    </div>`;

    const form = operatorView.querySelector('#operator-reusable-form');
    const richEditor = mountRichTextEditor(form.querySelector('[data-reusable-rich-editor]'), {
      document: template?.bodyRich || plainTextToRichDocument('')
    });
    operatorView.querySelector('#operator-template-back').onclick = renderTemplatesPage;
    operatorView.querySelector('#operator-template-cancel').onclick = renderTemplatesPage;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const error = form.querySelector('#operator-template-error');
      error.textContent = '';
      try {
        const data = new FormData(form);
        const payload = {
          name: String(data.get('name') || '').trim(),
          key: String(data.get('key') || '').trim(),
          projectId: String(data.get('projectId') || ''),
          bodyRich: richEditor.getDocument(),
          ...(template ? {} : { templateType })
        };
        await operatorApi(template ? `/api/templates/${encodeURIComponent(template.id)}` : '/api/templates', {
          method: template ? 'PATCH' : 'POST',
          body: JSON.stringify(payload)
        });
        await renderTemplatesPage();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : String(failure);
      }
    };
  } catch (error) {
    operatorView.innerHTML = `<div class="card error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

async function renderTemplatesPage() {
  operatorTitle.textContent = 'Шаблоны';
  operatorView.innerHTML = '<div class="muted">Загрузка шаблонов…</div>';
  try {
    const [templates, accounts] = await Promise.all([operatorApi('/api/templates'), operatorApi('/api/accounts')]);
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const postTemplates = templates.filter((template) => template.templateType === 'POST');
    const reusableBlocks = templates.filter((template) => isReusableTemplateType(template.templateType));

    operatorView.innerHTML = `<div class="operator-page">
      <div class="operator-page-head"><div><h2>Шаблоны</h2><p>Создавайте повторно используемые заготовки. При создании публикации текст и настройки копируются снимком.</p></div></div>

      <section class="operator-section" data-template-section="post-templates">
        <div class="operator-page-head"><div><h3>Шаблоны публикаций</h3><p>Полные снимки текста и настроек для создания нового DRAFT.</p></div><button id="operator-new-template" class="primary" type="button">+ Новый шаблон</button></div>
        <table class="table"><thead><tr><th>Название</th><th>Key</th><th>Проект</th><th>Тип</th><th>Площадки</th><th>Изменён</th><th>Действия</th></tr></thead>
        <tbody>${postTemplates.map((template) => `<tr data-template-id="${operatorEsc(template.id)}"><td><strong>${operatorEsc(template.name)}</strong></td><td>${operatorEsc(template.key)}</td><td>${operatorEsc(template.projectName || template.projectId)}</td><td>POST</td><td class="small">${operatorEsc(templateTargetSummary(template, accountsById))}</td><td class="small">${operatorEsc(new Date(template.updatedAt).toLocaleString())}</td><td><div class="row-actions"><button class="primary operator-template-create-post" type="button">Создать публикацию</button><button class="secondary operator-template-edit" type="button">Редактировать</button><button class="secondary danger operator-template-delete" type="button">Удалить</button></div></td></tr>`).join('') || '<tr><td colspan="7">Шаблонов пока нет</td></tr>'}</tbody></table>
      </section>

      <section class="operator-section" data-template-section="reusable-blocks">
        <div class="operator-page-head"><div><h3>Заготовки</h3><p>Фрагменты canonical rich text для ручной вставки в основной текст публикации.</p></div><div class="row-actions">
          <button class="secondary operator-new-block" data-template-type="SNIPPET" type="button">+ Фрагмент</button>
          <button class="secondary operator-new-block" data-template-type="CTA" type="button">+ CTA</button>
          <button class="secondary operator-new-block" data-template-type="SIGNATURE" type="button">+ Подпись</button>
          <button class="secondary operator-new-block" data-template-type="HASHTAG_SET" type="button">+ Хэштеги</button>
        </div></div>
        <table class="table"><thead><tr><th>Название</th><th>Key</th><th>Проект</th><th>Тип</th><th>Превью текста</th><th>Изменён</th><th>Действия</th></tr></thead>
        <tbody>${reusableBlocks.map((template) => `<tr data-template-id="${operatorEsc(template.id)}"><td><strong>${operatorEsc(template.name)}</strong></td><td>${operatorEsc(template.key)}</td><td>${operatorEsc(template.projectName || template.projectId)}</td><td>${operatorEsc(REUSABLE_TEMPLATE_META[template.templateType]?.label || template.templateType)}</td><td class="small">${operatorEsc(String(template.bodyPlain || '').slice(0, 160))}</td><td class="small">${operatorEsc(new Date(template.updatedAt).toLocaleString())}</td><td><div class="row-actions"><button class="secondary operator-template-edit" type="button">Редактировать</button><button class="secondary danger operator-template-delete" type="button">Удалить</button></div></td></tr>`).join('') || '<tr><td colspan="7">Заготовок пока нет</td></tr>'}</tbody></table>
      </section>

      <div id="operator-template-result"></div>
    </div>`;

    operatorView.querySelector('#operator-new-template').onclick = () => renderTemplateEditor();
    operatorView.querySelectorAll('.operator-new-block').forEach((button) => {
      button.onclick = () => renderReusableBlockEditor(null, button.dataset.templateType);
    });
    operatorView.querySelectorAll('.operator-template-edit').forEach((button) => {
      button.onclick = () => {
        const templateId = button.closest('tr').dataset.templateId;
        const template = templates.find((item) => item.id === templateId);
        if (isReusableTemplateType(template?.templateType)) renderReusableBlockEditor(templateId);
        else renderTemplateEditor(templateId);
      };
    });
    operatorView.querySelectorAll('.operator-template-delete').forEach((button) => button.onclick = async () => {
      const row = button.closest('tr');
      const template = templates.find((item) => item.id === row.dataset.templateId);
      const noun = isReusableTemplateType(template?.templateType) ? 'заготовку' : 'шаблон';
      if (!window.confirm(`Удалить ${noun} «${template?.name || ''}»?`)) return;
      await operatorApi(`/api/templates/${encodeURIComponent(row.dataset.templateId)}`, { method: 'DELETE' });
      await renderTemplatesPage();
    });
    operatorView.querySelectorAll('.operator-template-create-post').forEach((button) => button.onclick = async () => {
      const row = button.closest('tr');
      button.disabled = true;
      try {
        const created = await operatorApi(`/api/templates/${encodeURIComponent(row.dataset.templateId)}/create-post`, { method: 'POST', body: '{}' });
        if (created.warnings?.length) {
          window.alert(`Публикация создана. Недоступные площадки пропущены: ${created.warnings.map((warning) => warning.accountId).join(', ')}`);
        }
        operatorGo('/content');
      } catch (error) {
        button.disabled = false;
        operatorView.querySelector('#operator-template-result').innerHTML = `<div class="operator-result error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
      }
    });
  } catch (error) {
    operatorView.innerHTML = `<div class="card error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

const CUSTOM_ROUTES = new Map([
  ['/socials', renderSocialsPage],
  ['/sources', renderSourcesPage],
  ['/templates', renderTemplatesPage]
]);
const LEGACY_ROUTES = new Map([
  ['/overview', '.nav[data-view="dashboard"]'],
  ['/calendar', '#calendar-nav'],
  ['/content', '.nav[data-view="posts"]'],
  ['/library', '#content-library-nav'],
  ['/projects', '.nav[data-view="projects"]'],
  ['/schedule', '.nav[data-view="schedules"]'],
  ['/journal', '.nav[data-view="events"]'],
  ['/backups', '.nav[data-view="backups"]'],
  ['/diagnostics', '#diagnostics-nav']
]);

function operatorSetActive(path) {
  document.querySelectorAll('.nav').forEach((item) => item.classList.toggle('active', item.dataset.route === path));
}
function operatorNormalizePath(path) {
  return CUSTOM_ROUTES.has(path) || LEGACY_ROUTES.has(path) ? path : '/overview';
}
async function operatorRenderCustom(path, updateHistory = true) {
  if (updateHistory && window.location.pathname !== path) history.pushState({}, '', path);
  operatorSetActive(path);
  operatorView.innerHTML = '<div class="muted">Загрузка…</div>';
  await CUSTOM_ROUTES.get(path)();
  window.dispatchEvent(new CustomEvent('publikator:operator-route-rendered', { detail: { path } }));
}
function operatorGo(path, replace = false) {
  const normalized = operatorNormalizePath(path);
  if (CUSTOM_ROUTES.has(normalized)) {
    if (replace) history.replaceState({}, '', normalized);
    operatorRenderCustom(normalized, !replace);
    return;
  }
  if (replace) history.replaceState({}, '', normalized);
  else if (window.location.pathname !== normalized) history.pushState({}, '', normalized);
  const button = document.querySelector(LEGACY_ROUTES.get(normalized));
  if (!button) return;
  operatorRouting = true;
  button.click();
  operatorRouting = false;
  operatorSetActive(normalized);
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest('.nav[data-route]');
  if (!button || operatorRouting) return;
  const path = operatorNormalizePath(button.dataset.route || '/overview');
  if (CUSTOM_ROUTES.has(path)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    operatorRenderCustom(path, true);
  } else {
    if (window.location.pathname !== path) history.pushState({}, '', path);
    setTimeout(() => operatorSetActive(path), 0);
  }
}, true);

window.addEventListener('popstate', () => {
  if (!operatorApp?.classList.contains('hidden')) operatorGo(window.location.pathname, true);
});

function operatorRouteWhenVisible() {
  if (!operatorApp || operatorApp.classList.contains('hidden')) { operatorInitialRouted = false; return; }
  if (operatorInitialRouted) return;
  operatorInitialRouted = true;
  const normalized = operatorNormalizePath(window.location.pathname);
  operatorGo(normalized, true);
}
const operatorAppObserver = new MutationObserver(operatorRouteWhenVisible);
if (operatorApp) operatorAppObserver.observe(operatorApp, { attributes: true, attributeFilter: ['class'] });
setTimeout(operatorRouteWhenVisible, 0);
