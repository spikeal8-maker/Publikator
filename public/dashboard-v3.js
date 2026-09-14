const dashboardView = document.querySelector('#view');
const dashboardTitle = document.querySelector('#page-title');
const dashboardApp = document.querySelector('#app');
let dashboardRendering = false;
let dashboardScheduled = false;

function dashboardEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

async function dashboardRequest(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function localDashboardWindow() {
  const todayFrom = new Date();
  todayFrom.setHours(0, 0, 0, 0);
  const todayTo = new Date(todayFrom);
  todayTo.setDate(todayTo.getDate() + 1);
  const weekTo = new Date(todayFrom);
  weekTo.setDate(weekTo.getDate() + 7);
  return { todayFrom: todayFrom.toISOString(), todayTo: todayTo.toISOString(), weekTo: weekTo.toISOString() };
}

const STATUS_META = {
  DRAFT: ['✎', 'Черновик', 'neutral'],
  READY: ['✓', 'Готово', 'warning'],
  PUBLISHING: ['↗', 'Публикуется', 'info'],
  PUBLISHED: ['✓', 'Опубликовано', 'success'],
  PARTIAL: ['◐', 'Частично', 'danger'],
  FAILED: ['!', 'Ошибка', 'danger'],
  RETRY: ['↻', 'Повтор', 'warning'],
  RECOVERY_NEEDED: ['!', 'Нужно восстановление', 'danger'],
  IDEA: ['○', 'Идея', 'neutral'],
  IN_REVIEW: ['◌', 'На проверке', 'info'],
  APPROVED: ['✓', 'Одобрено', 'success']
};

function dashboardStatus(value) {
  const key = String(value || 'DRAFT');
  const [icon, label, tone] = STATUS_META[key] || ['•', key, 'neutral'];
  return `<span class="status-chip" data-tone="${tone}"><span aria-hidden="true">${icon}</span>${dashboardEscape(label)}</span>`;
}

function dashboardTime(value) {
  if (!value) return 'Без точного времени';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? dashboardEscape(value) : dashboardEscape(date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }));
}

function dashboardPlatforms(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean).join(' · ') || 'Площадки не выбраны';
}

function dashboardThumbnail(item) {
  return item.thumbnail_path
    ? `<img class="dashboard-v3-thumb" src="/public-media/${dashboardEscape(item.thumbnail_path)}" alt="">`
    : '<div class="dashboard-v3-thumb empty" aria-hidden="true">◇</div>';
}

function dashboardItem(item, badgeValue = item.status) {
  return `<button type="button" class="dashboard-v3-item" data-post-id="${dashboardEscape(item.id)}">
    ${dashboardThumbnail(item)}
    <span class="dashboard-v3-item-main"><strong>${dashboardEscape(item.title)}</strong><span class="dashboard-v3-meta">${dashboardEscape(item.project_name)} · ${dashboardTime(item.scheduled_at_utc)} · ${dashboardEscape(dashboardPlatforms(item.platforms))}</span></span>
    <span class="dashboard-v3-item-side">${dashboardStatus(badgeValue)}<span class="dashboard-v3-meta">${dashboardEscape(item.publication_kind || 'FEED')} / ${dashboardEscape(item.content_format || 'IMAGE')}</span></span>
  </button>`;
}

function dashboardList(items, emptyText, badgeSelector) {
  return items.length ? items.map((item) => dashboardItem(item, badgeSelector ? badgeSelector(item) : item.status)).join('') : `<div class="dashboard-v3-empty">${dashboardEscape(emptyText)}</div>`;
}

function dashboardMetric(label, value, note, tone = 'neutral') {
  return `<article class="dashboard-v3-metric" data-tone="${tone}"><div>${dashboardEscape(label)}</div><strong>${Number(value || 0)}</strong><span>${dashboardEscape(note)}</span></article>`;
}

function openDashboardInspector(postId) {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'open-post';
  trigger.dataset.id = postId;
  trigger.hidden = true;
  document.body.append(trigger);
  trigger.click();
  trigger.remove();
}

async function renderEditorialDashboard() {
  if (dashboardRendering || !dashboardView || !dashboardTitle || !dashboardApp) return;
  if (dashboardApp.classList.contains('hidden') || dashboardTitle.textContent?.trim() !== 'Обзор') return;
  dashboardRendering = true;
  try {
    const bounds = localDashboardWindow();
    const query = new URLSearchParams(bounds);
    const data = await dashboardRequest(`/api/editorial-dashboard?${query}`);
    const platformSummary = data.platformDistribution.length
      ? data.platformDistribution.map((item) => `<span class="dashboard-v3-platform">${dashboardEscape(item.platform)} · ${Number(item.count)}</span>`).join('')
      : '<span class="dashboard-v3-platform">Нет запланированных площадок</span>';
    const events = data.recentEvents.length
      ? data.recentEvents.map((item) => `<div class="dashboard-v3-event" data-level="${dashboardEscape(item.level)}"><span>${dashboardTime(item.created_at)}</span><strong>${dashboardEscape(item.event_type)}</strong><span>${dashboardEscape(item.message)}</span></div>`).join('')
      : '<div class="dashboard-v3-empty">Событий пока нет</div>';

    dashboardView.innerHTML = `<div class="dashboard-v3-root">
      <div class="dashboard-v3-metrics">
        ${dashboardMetric('Сегодня', data.metrics.today, 'публикаций с точным временем')}
        ${dashboardMetric('7 дней', data.metrics.next7Days, 'публикаций в ближайшем окне')}
        ${dashboardMetric('Нужно проверить', data.metrics.needsReview, `готово к публикации: ${data.metrics.ready}`, 'warning')}
        ${dashboardMetric('Проблемы', data.metrics.problems, 'ошибки и recovery-состояния', data.metrics.problems ? 'danger' : 'neutral')}
      </div>
      <div class="dashboard-v3-columns">
        <section class="dashboard-v3-panel"><header><h2>Сегодня</h2></header><div class="dashboard-v3-list">${dashboardList(data.todayItems, 'На сегодня публикаций с точным временем нет')}</div></section>
        <section class="dashboard-v3-panel"><header><h2>7 дней · площадки</h2></header><div class="dashboard-v3-platforms">${platformSummary}</div><div class="dashboard-v3-events">${events}</div></section>
      </div>
      <div class="dashboard-v3-attention">
        <section class="dashboard-v3-panel"><div class="dashboard-v3-subhead">Нужно проверить</div><div class="dashboard-v3-list">${dashboardList(data.reviewItems, 'Нет материалов, требующих редакционной проверки', (item) => item.editorial_stage)}</div></section>
        <section class="dashboard-v3-panel"><div class="dashboard-v3-subhead">Проблемы</div><div class="dashboard-v3-list">${dashboardList(data.problemItems, 'Проблем публикации не обнаружено', (item) => item.status === 'FAILED' || item.status === 'PARTIAL' ? item.status : 'RECOVERY_NEEDED')}</div></section>
      </div>
    </div>`;
    dashboardView.querySelectorAll('[data-post-id]').forEach((button) => button.addEventListener('click', () => openDashboardInspector(button.dataset.postId)));
  } catch (error) {
    if (dashboardTitle.textContent?.trim() === 'Обзор') dashboardView.innerHTML = `<div class="card error">${dashboardEscape(error instanceof Error ? error.message : String(error))}</div>`;
  } finally {
    dashboardRendering = false;
  }
}

function scheduleDashboardRender() {
  if (dashboardScheduled) return;
  dashboardScheduled = true;
  setTimeout(() => {
    dashboardScheduled = false;
    if (dashboardTitle?.textContent?.trim() === 'Обзор' && !dashboardView?.querySelector('.dashboard-v3-root')) renderEditorialDashboard();
  }, 0);
}

const dashboardObserver = new MutationObserver(() => {
  if (dashboardRendering) return;
  if (dashboardTitle?.textContent?.trim() === 'Обзор' && !dashboardView?.querySelector('.dashboard-v3-root')) scheduleDashboardRender();
});
if (dashboardView) dashboardObserver.observe(dashboardView, { childList: true });
if (dashboardTitle) dashboardObserver.observe(dashboardTitle, { childList: true, subtree: true, characterData: true });
if (dashboardApp) dashboardObserver.observe(dashboardApp, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.nav[data-view="dashboard"]')) scheduleDashboardRender();
}, true);
setTimeout(() => renderEditorialDashboard(), 0);
