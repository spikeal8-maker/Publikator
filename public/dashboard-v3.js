import { mountOverviewChart } from './overview-chart.js';
import { publicationFormatLabel, statusLabel } from './presentation-labels.js';

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

const STATUS_VISUAL = {
  DRAFT: ['✎', 'neutral'],
  READY: ['✓', 'warning'],
  PUBLISHING: ['↗', 'info'],
  PUBLISHED: ['✓', 'success'],
  PARTIAL: ['◐', 'danger'],
  FAILED: ['!', 'danger'],
  RETRY: ['↻', 'warning'],
  RECOVERY_NEEDED: ['!', 'danger'],
  IDEA: ['○', 'neutral'],
  IN_REVIEW: ['◌', 'info'],
  APPROVED: ['✓', 'success']
};

function dashboardStatus(value) {
  const key = String(value || 'DRAFT');
  const [icon, tone] = STATUS_VISUAL[key] || ['•', 'neutral'];
  return `<span class="status-chip" data-tone="${tone}"><span aria-hidden="true">${icon}</span>${dashboardEscape(statusLabel(key))}</span>`;
}

function dashboardTime(value) {
  if (!value) return 'Без точного времени';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? dashboardEscape(value) : dashboardEscape(date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }));
}

function dashboardPlatforms(value) {
  return String(value || '').split(',').map((item) => ({telegram:'Telegram',vk:'VK',max:'MAX',instagram:'Instagram'})[item.trim()] || item.trim()).filter(Boolean).join(' · ') || 'Площадки не выбраны';
}

function dashboardThumbnail(item) {
  return item.thumbnail_path
    ? `<img class="dashboard-v3-thumb" src="/public-media/${dashboardEscape(item.thumbnail_path)}" alt="">`
    : '<div class="dashboard-v3-thumb empty" aria-hidden="true">◇</div>';
}

function dashboardItem(item, badgeValue = item.status) {
  const reason = !item.platforms ? 'Выберите площадку' : ['IDEA','DRAFT','IN_REVIEW'].includes(item.editorial_stage) ? 'Проверьте материал' : '';
  return `<button type="button" class="dashboard-v3-item" data-post-id="${dashboardEscape(item.id)}">
    ${dashboardThumbnail(item)}
    <span class="dashboard-v3-item-main"><strong>${dashboardEscape(item.title)}</strong><span class="dashboard-v3-meta">${dashboardEscape(item.project_name)} · ${dashboardTime(item.scheduled_at_utc)} · ${dashboardEscape(dashboardPlatforms(item.platforms))}</span></span>
    <span class="dashboard-v3-item-side">${dashboardStatus(badgeValue)}<span class="dashboard-v3-meta">${dashboardEscape(reason || ({TEXT_ONLY:'Текст',IMAGE:'Фото',CAROUSEL:'Альбом',VIDEO:'Видео'})[item.content_format] || publicationFormatLabel(item.publication_kind, item.content_format))}</span></span>
  </button>`;
}

function dashboardList(items, emptyText, badgeSelector) {
  return items.length ? items.map((item) => dashboardItem(item, badgeSelector ? badgeSelector(item) : item.status)).join('') : `<div class="dashboard-v3-empty">${dashboardEscape(emptyText)}</div>`;
}

function dashboardMetric(label, value, note, tone = 'neutral', section = 'today') {
  return `<button type="button" class="dashboard-v3-metric" data-tone="${tone}" data-dashboard-section="${section}"><div>${dashboardEscape(label)}<span aria-hidden="true">↗</span></div><strong>${Number(value || 0)}</strong><span>${dashboardEscape(note)}</span></button>`;
}
function dashboardHelp(title, text) {
  return `<details class="overview-help"><summary aria-label="Подсказка: ${dashboardEscape(title)}">i</summary><div><strong>${dashboardEscape(title)}</strong><p>${dashboardEscape(text)}</p></div></details>`;
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
    if (dashboardTitle.textContent?.trim() !== 'Обзор' || dashboardApp.classList.contains('hidden')) return;
    const platformSummary = data.platformDistribution.length
      ? data.platformDistribution.map((item) => `<span class="dashboard-v3-platform">${dashboardEscape(dashboardPlatforms(item.platform))} · ${Number(item.count)}</span>`).join('')
      : '<span class="dashboard-v3-platform">Нет запланированных площадок</span>';
    const upcoming = data.weekItems || data.todayItems;
    dashboardView.innerHTML = `<div class="dashboard-v3-root overview-v1">
      <section class="dashboard-v3-panel overview-chart" id="overview-chart" aria-label="Графики публикаций"></section>
      <div class="dashboard-v3-metrics">
        ${dashboardMetric('Сегодня', data.metrics.today, 'по расписанию', 'neutral', 'today')}
        ${dashboardMetric('7 дней', data.metrics.next7Days, 'в контент-плане', 'neutral', 'upcoming')}
        ${dashboardMetric('Нужно проверить', data.metrics.needsReview, 'материалов ждут решения', 'warning', 'review')}
        ${dashboardMetric('Проблемы', data.metrics.problems, data.metrics.problems ? 'нужно ваше внимание' : 'всё в порядке', data.metrics.problems ? 'danger' : 'neutral', 'problems')}
      </div>
      <div class="overview-grid">
        <section class="dashboard-v3-panel overview-upcoming" id="overview-upcoming"><header><div><h2>Ближайшие публикации</h2><span>Готово к отправке: ${Number(data.metrics.ready || 0)}</span></div>${dashboardHelp('Ближайшие публикации','Материалы с точной датой в ближайшие семь дней. Нажмите на публикацию, чтобы проверить текст, медиа и получателей. Для изменения времени откройте календарь.')}<button type="button" class="overview-calendar">Календарь ↗</button></header><div class="dashboard-v3-list">${dashboardList(upcoming, 'Ближайших публикаций пока нет. Создайте материал и назначьте время.')}</div></section>
        <div class="overview-side">
          <section class="dashboard-v3-panel" id="overview-problems"><header><h2>Состояние публикаций</h2>${dashboardHelp('Проблемы','Здесь появляются ошибки отправки и результаты, которые требуют проверки. При неизвестном результате сначала проверьте площадку: повторная отправка может создать дубликат.')}</header>${data.problemItems.length ? dashboardList(data.problemItems,'',item => item.status === 'FAILED' || item.status === 'PARTIAL' ? item.status : 'RECOVERY_NEEDED') : '<div class="overview-clear"><span aria-hidden="true">✓</span><div><strong>Всё в порядке</strong><p>Ошибок отправки нет</p></div></div>'}</section>
          <section class="dashboard-v3-panel"><header><h2>Площадки · 7 дней</h2>${dashboardHelp('Площадки','Количество запланированных отправок по площадкам. Одна публикация для двух площадок учитывается в каждой из них. Это план, а не число подключённых аккаунтов.')}</header><div class="dashboard-v3-platforms">${platformSummary}</div><button type="button" class="overview-sources">Источники и синхронизация ↗</button></section>
        </div>
        <section class="dashboard-v3-panel overview-review" id="overview-review"><header><div><h2>Требуют внимания</h2><span>Следующий шаг для каждого материала</span></div>${dashboardHelp('Редакционная проверка','Черновики, идеи и материалы на проверке. Откройте карточку, выберите получателей, проверьте текст и вложения, затем сохраните или запланируйте отправку. Без точного времени материал не попадёт в календарь.')}</header><div class="dashboard-v3-list">${dashboardList(data.reviewItems, 'Все материалы проверены.', item => item.editorial_stage)}</div></section>
      </div>
    </div>`;
    const navigate = (id) => document.querySelector(id)?.click();
    mountOverviewChart(dashboardView.querySelector('#overview-chart'), {request:dashboardRequest,createPublication:()=>navigate('#quick-compose-nav'),help:dashboardHelp});
    dashboardView.querySelector('.overview-calendar').onclick = () => navigate('#calendar-nav');
    dashboardView.querySelector('.overview-sources').onclick = () => navigate('#sources-nav');
    dashboardView.querySelectorAll('[data-dashboard-section]').forEach(button => button.onclick = () => {
      const section = button.dataset.dashboardSection;
      if (section === 'today' || section === 'upcoming') { navigate('#calendar-nav'); return; }
      const panel = dashboardView.querySelector('#overview-' + section);
      panel?.scrollIntoView({block:'start',behavior:'smooth'});
      panel?.setAttribute('tabindex','-1'); panel?.focus({preventScroll:true});
    });
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
