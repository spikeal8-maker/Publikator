const releaseNav = document.querySelector('#release-readiness-nav');
const releaseView = document.querySelector('#view');
const releasePageTitle = document.querySelector('#page-title');

async function releaseApi(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
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

function statusLabel(status) {
  if (status === 'pass') return 'PASS';
  if (status === 'warning') return 'WARN';
  if (status === 'block') return 'BLOCK';
  return 'LIVE';
}

function checkCard(item) {
  return `<article class="card release-check-card ${releaseEsc(item.status)}">
    <div class="release-check-head">
      <h3>${releaseEsc(item.title)}</h3>
      <span class="release-status ${releaseEsc(item.status)}">${statusLabel(item.status)}</span>
    </div>
    <p>${releaseEsc(item.message)}</p>
    <div class="small muted"><code>${releaseEsc(item.id)}</code></div>
  </article>`;
}

async function renderReleaseReadiness() {
  releasePageTitle.textContent = 'Готовность V1';
  releaseView.innerHTML = '<div class="muted">Формирование release-readiness отчёта…</div>';

  try {
    const report = await releaseApi('/api/release-readiness');
    const automatedClass = report.automatedReady ? 'ready' : 'blocked';
    const automatedTitle = report.automatedReady ? 'Automated RC gate пройден' : 'Automated RC gate заблокирован';
    const blockers = report.automatedBlockers || [];
    const livePlatforms = report.liveAcceptance?.requiredPlatforms || [];

    releaseView.innerHTML = `
      <div class="release-hero-grid">
        <section class="card release-gate ${automatedClass}">
          <div class="release-kicker">Release candidate ${releaseEsc(report.releaseCandidate)}</div>
          <h2>${releaseEsc(automatedTitle)}</h2>
          <p>${report.automatedReady
            ? 'Локальные автоматические проверки runtime не содержат блокеров.'
            : 'До RC/live acceptance необходимо устранить перечисленные технические блокеры.'}</p>
          ${blockers.length ? `<ul class="release-blockers">${blockers.map((item) => `<li>${releaseEsc(item)}</li>`).join('')}</ul>` : ''}
        </section>

        <section class="card release-gate live-required">
          <div class="release-kicker">Stable V1</div>
          <h2>Live acceptance обязателен</h2>
          <p>${releaseEsc(report.liveAcceptance?.message || 'Требуется ручная проверка внешних API.')}</p>
          <div class="release-platforms">${livePlatforms.map((platform) => `<span>${releaseEsc(platform)}</span>`).join('')}</div>
          <div class="small muted">Checklist: <code>${releaseEsc(report.liveAcceptance?.checklist || 'docs/LIVE_INTEGRATION_CHECKLIST.md')}</code></div>
        </section>
      </div>

      <div class="release-toolbar">
        <div class="small muted">Снимок: ${releaseEsc(releaseDate(report.generatedAt))}</div>
        <div class="row-actions">
          <button id="release-refresh" class="secondary" type="button">Обновить</button>
          <a class="button-link primary" href="/api/release-readiness/report.json">Скачать JSON-отчёт</a>
        </div>
      </div>

      <div class="release-check-grid">
        ${(report.checks || []).map(checkCard).join('')}
      </div>

      <section class="card release-policy">
        <h3>Почему V1 пока не объявляется готовым автоматически</h3>
        <p>Mock/E2E доказывают внутреннюю логику Publikator, но не могут доказать текущие права реальных аккаунтов, модерацию, сетевую доступность или фактическое поведение Telegram/VK/MAX/Instagram. Поэтому <code>stableV1Ready</code> намеренно остаётся <code>false</code> до ручного release acceptance.</p>
      </section>`;

    document.querySelector('#release-refresh')?.addEventListener('click', renderReleaseReadiness);
  } catch (error) {
    releaseView.innerHTML = `<div class="card error">${releaseEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

releaseNav?.addEventListener('click', async () => {
  document.querySelectorAll('.nav').forEach((item) => item.classList.remove('active'));
  releaseNav.classList.add('active');
  await renderReleaseReadiness();
});
