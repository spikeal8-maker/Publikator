const releaseNav = document.querySelector('#release-nav');
const releaseView = document.querySelector('#view');
const releaseTitle = document.querySelector('#page-title');

const RELEASE_PLATFORM_NAMES = {
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
  instagram: 'Instagram'
};

async function releaseApi(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.reload();
    throw new Error('Требуется вход');
  }
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function releaseEsc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}

function releaseDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function statusText(status) {
  if (status === 'PASS') return 'LIVE PASS';
  if (status === 'FAIL') return 'FAIL';
  return 'Не проверено';
}

function acceptanceCard(row, gate) {
  const name = RELEASE_PLATFORM_NAMES[row.platform] || row.platform;
  const commitSha = row.commitSha || gate.appBuildSha || '';
  return `<article class="release-card" data-platform="${releaseEsc(row.platform)}">
    <div class="release-card-head">
      <div><h3>${releaseEsc(name)}</h3><div class="small muted">Реальный тест внешнего API</div></div>
      <span class="release-status ${releaseEsc(row.status.toLowerCase())}">${releaseEsc(statusText(row.status))}</span>
    </div>
    <label>Тестовый аккаунт / канал
      <input class="release-account" type="text" maxlength="200" value="${releaseEsc(row.accountName || '')}" placeholder="Например, ASSA Lab test">
    </label>
    <label>Commit SHA проверенного build
      <input class="release-sha" type="text" maxlength="40" value="${releaseEsc(commitSha)}" placeholder="40 символов Git SHA">
    </label>
    <label>Заметки / фактический результат
      <textarea class="release-notes" maxlength="5000" placeholder="Что проверено, что заметили, причина FAIL">${releaseEsc(row.notes || '')}</textarea>
    </label>
    <div class="small muted">Последняя live-проверка: ${releaseEsc(releaseDate(row.testedAt))}</div>
    <div class="release-actions">
      <button class="primary release-pass" type="button">Зафиксировать LIVE PASS</button>
      <button class="secondary danger release-fail" type="button">Зафиксировать FAIL</button>
      <button class="secondary release-reset" type="button">Сбросить</button>
    </div>
    <div class="release-card-error error"></div>
  </article>`;
}

function renderGateSummary(gate) {
  const blockerItems = gate.blockers.map((item) => `<li>${releaseEsc(item)}</li>`).join('');
  const warningItems = gate.warnings.map((item) => `<li>${releaseEsc(item)}</li>`).join('');
  return `<section class="release-summary ${gate.releaseReady ? 'ready' : 'blocked'}">
    <div>
      <div class="release-kicker">Target ${releaseEsc(gate.targetVersion)}</div>
      <h2>${gate.releaseReady ? 'Runtime/live gate пройден' : 'V1 пока заблокирован'}</h2>
      <p>${gate.releaseReady
        ? 'Все live evidence согласованы. Перед tag/release остаётся проверить automated CI на том же commit SHA.'
        : 'Publikator не позволит считать release готовым, пока ниже остаются блокирующие условия.'}</p>
    </div>
    <dl class="release-facts">
      <div><dt>Запущенный build</dt><dd><code>${releaseEsc(gate.appBuildSha || 'APP_BUILD_SHA не задан')}</code></dd></div>
      <div><dt>Acceptance commit</dt><dd><code>${releaseEsc(gate.acceptanceCommitSha || 'не согласован')}</code></dd></div>
      <div><dt>Последний acceptance</dt><dd>${releaseEsc(releaseDate(gate.latestAcceptanceAt))}</dd></div>
      <div><dt>Последний backup</dt><dd>${gate.latestBackup ? `${releaseEsc(gate.latestBackup.name)}<br><span class="small muted">${releaseEsc(releaseDate(gate.latestBackup.createdAt))}</span>` : 'нет'}</dd></div>
      <div><dt>Backup после acceptance</dt><dd>${gate.backupAfterAcceptance ? '<strong class="release-ok">да</strong>' : '<strong class="release-bad">нет</strong>'}</dd></div>
      <div><dt>Automated CI</dt><dd>проверяется в GitHub перед тегом</dd></div>
    </dl>
    ${blockerItems ? `<div class="release-blockers"><h3>Что блокирует выпуск</h3><ul>${blockerItems}</ul></div>` : ''}
    ${warningItems ? `<div class="release-warnings"><h3>Предупреждения</h3><ul>${warningItems}</ul></div>` : ''}
  </section>`;
}

async function saveAcceptance(card, status) {
  const platform = card.dataset.platform;
  const accountName = card.querySelector('.release-account').value.trim();
  const commitSha = card.querySelector('.release-sha').value.trim();
  const notes = card.querySelector('.release-notes').value.trim();
  const errorBox = card.querySelector('.release-card-error');
  errorBox.textContent = '';

  let confirmation = null;
  if (status === 'PASS') {
    confirmation = window.prompt(
      `PASS означает, что ${RELEASE_PLATFORM_NAMES[platform] || platform} реально проверен по docs/LIVE_INTEGRATION_CHECKLIST.md на указанном commit.\n\nВведите LIVE PASS:`
    );
    if (confirmation === null) return;
  }
  if (status === 'FAIL' && !notes) {
    errorBox.textContent = 'Для FAIL сначала запишите фактическую причину в заметках.';
    return;
  }
  if (status === 'NOT_TESTED' && !window.confirm('Сбросить сохранённый live acceptance этой площадки?')) return;

  card.querySelectorAll('button,input,textarea').forEach((element) => { element.disabled = true; });
  try {
    await releaseApi(`/api/release-gate/${encodeURIComponent(platform)}`, {
      method: 'PUT',
      body: JSON.stringify({ status, accountName, commitSha, notes, confirmation })
    });
    await renderReleaseGate();
  } catch (error) {
    card.querySelectorAll('button,input,textarea').forEach((element) => { element.disabled = false; });
    errorBox.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function renderReleaseGate() {
  releaseTitle.textContent = 'Release gate';
  releaseView.innerHTML = '<div class="muted">Проверка release evidence, диагностики и backup…</div>';
  try {
    const gate = await releaseApi('/api/release-gate');
    releaseView.innerHTML = `${renderGateSummary(gate)}
      <div class="release-help card">
        <strong>Это не автоматический тест соцсетей.</strong>
        <span>PASS ставится только после фактической проверки тестового Telegram/VK/MAX/Instagram по <code>docs/LIVE_INTEGRATION_CHECKLIST.md</code>. Mock/E2E CI не считается live acceptance.</span>
      </div>
      <div class="release-grid">${gate.acceptance.map((row) => acceptanceCard(row, gate)).join('')}</div>`;

    releaseView.querySelectorAll('.release-card').forEach((card) => {
      card.querySelector('.release-pass').addEventListener('click', () => saveAcceptance(card, 'PASS'));
      card.querySelector('.release-fail').addEventListener('click', () => saveAcceptance(card, 'FAIL'));
      card.querySelector('.release-reset').addEventListener('click', () => saveAcceptance(card, 'NOT_TESTED'));
    });
  } catch (error) {
    releaseView.innerHTML = `<div class="card error">${releaseEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

releaseNav?.addEventListener('click', async () => {
  document.querySelectorAll('.nav').forEach((item) => item.classList.remove('active'));
  releaseNav.classList.add('active');
  await renderReleaseGate();
});
