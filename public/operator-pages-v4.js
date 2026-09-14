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
      ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
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
  instagram: { label: 'Instagram', note: 'Professional account через Meta Graph API.' }
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
      <div class="operator-page-head"><div><h2>Соцсети</h2><p>Здесь подключаются реальные площадки. Сначала Publikator проверяет токен и конкретное назначение, и только после успешной проверки позволяет сохранить подключение.</p></div></div>
      <div class="operator-platform-grid">${Object.entries(OPERATOR_PLATFORM).map(([key, meta]) => `<div class="operator-platform-card"><strong>${meta.label}</strong><span>${meta.note}</span><button class="secondary operator-add-platform" type="button" data-platform="${key}">Подключить</button></div>`).join('')}</div>
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
    return `<tr><td>${Number(row.rowNumber || 0)}</td><td><span class="operator-classification ${operatorEsc(row.classification)}">${operatorEsc(row.classification)}</span></td><td>${normalized ? operatorEsc(normalized.title) : '—'}</td><td>${normalized ? operatorEsc(normalized.project) : '—'}</td><td>${normalized ? operatorEsc((normalized.targets || []).map((target) => `${target.platform}: ${target.name}`).join(', ') || '—') : '—'}</td><td class="small error">${operatorEsc((row.errors || []).join('; '))}</td></tr>`;
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
      <div class="operator-page-head"><div><h2>Источники / Интеграции</h2><p>Массовый контент загружается здесь. Один и тот же ID источника связывает повторные версии таблицы: новые строки создаются, изменённые обновляются, одинаковые не дублируются.</p></div></div>
      <div class="operator-source-layout">
        <section class="operator-section"><h3>Excel / CSV · schema v${Number(schema.version || 3)}</h3><p>Скачайте шаблон, заполните строки, затем сначала выполните Preview. Apply доступен только после успешной проверки этого же файла.</p>
          <div class="operator-form"><label class="full">ID источника<input id="operator-source-id" value="${operatorEsc(savedSourceId)}" pattern="[A-Za-z0-9._:-]{1,128}" required><span class="operator-field-help">Например: asa-social-plan. Не меняйте его между версиями одной таблицы.</span></label></div>
          <div class="operator-actions" style="margin:14px 0"><a class="button-link secondary" href="/api/content-plan/v3/template.xlsx" download>Скачать шаблон XLSX</a></div>
          <label class="operator-drop"><input id="operator-source-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><strong>Выбрать CSV / XLSX</strong><span id="operator-source-file-name">Файл не выбран</span></label>
          <div class="operator-actions" style="margin-top:14px"><button id="operator-source-preview" class="primary" type="button" disabled>1. Проверить Preview</button><button id="operator-source-apply" class="secondary" type="button" disabled>2. Применить</button></div>
          <div id="operator-source-result"></div>
        </section>
        <aside class="operator-section"><h3>Подключаемые источники</h3><p>Здесь показываются только реальные интеграции, без имитации.</p>
          <div class="operator-connector-card"><strong>Файл XLSX / CSV</strong><span>Работает сейчас: schema v3, preview/apply, idempotent source identity.</span></div>
          <div class="operator-connector-card" style="margin-top:10px"><strong>Google Sheets</strong><span>Connector в текущем backend ещё не реализован. Эта страница его не подменяет загрузкой файла.</span></div>
          <div class="operator-connector-card" style="margin-top:10px"><strong>Google Drive / Яндекс Диск</strong><span>Cloud media connectors пока не включены.</span></div>
        </aside>
      </div>
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
  } catch (error) {
    operatorView.innerHTML = `<div class="card error">${operatorEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function renderTemplatesPage() {
  operatorTitle.textContent = 'Шаблоны';
  operatorView.innerHTML = `<div class="operator-page"><div class="operator-page-head"><div><h2>Шаблоны</h2><p>Раздел предусмотрен продуктовой моделью, но backend Template/Snippet в текущей реализации ещё не создан. Publikator не будет имитировать шаблоны в браузере.</p></div></div><div class="operator-empty">Сейчас создавайте и редактируйте материалы в разделе «Контент». После появления серверной сущности Template этот раздел станет рабочим без переноса данных.</div><div class="operator-actions"><button id="operator-template-content" class="primary" type="button">Открыть контент</button></div></div>`;
  document.querySelector('#operator-template-content').onclick = () => operatorGo('/content');
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
