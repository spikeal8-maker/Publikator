import { statusLabel } from './presentation-labels.js';

const EDITORIAL_VIEWS = {
  active: { label: 'Активные', api: '/api/editorial/posts?view=active' },
  archive: { label: 'Архив', api: '/api/editorial/posts?view=archive' },
  trash: { label: 'Корзина', api: '/api/editorial/posts?view=trash' }
};

let editorialView = 'active';
let bypassInspectorOnce = false;
let enhancementBusy = false;

function editorialEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

async function editorialRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function editorialBadge(value) {
  const raw = String(value ?? '');
  return `<span class="badge ${editorialEscape(raw)}" data-raw-status="${editorialEscape(raw)}" data-presentation-owner="editorial">${editorialEscape(statusLabel(raw))}</span>`;
}

function formatEditorialTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? editorialEscape(value) : editorialEscape(date.toLocaleString());
}

function lifecycleListRows(rows) {
  return rows.map((post) => `<tr>
    <td><strong>${editorialEscape(post.title)}</strong><div class="small muted">${editorialEscape(String(post.body || '').slice(0, 100))}</div></td>
    <td>${editorialEscape(post.project_name)}</td>
    <td>${Number(post.media_count || 0)}</td>
    <td>${editorialEscape(post.schedule_mode)}</td>
    <td><div class="editorial-badges">${editorialBadge(post.editorial_stage)} ${editorialBadge(post.status)}</div></td>
    <td><button class="secondary open-post" data-id="${editorialEscape(post.id)}">Открыть</button></td>
  </tr>`).join('') || '<tr><td colspan="6">Здесь пока пусто</td></tr>';
}

async function filterLegacyActiveRows() {
  const table = document.querySelector('#view table.table');
  if (!table) return;
  const active = await editorialRequest(EDITORIAL_VIEWS.active.api);
  const allowed = new Set(active.map((post) => post.id));
  table.querySelectorAll('tbody .open-post').forEach((button) => {
    if (!allowed.has(button.dataset.id)) button.closest('tr')?.remove();
  });
  if (!table.querySelector('tbody tr')) table.querySelector('tbody').innerHTML = '<tr><td colspan="6">Публикаций пока нет</td></tr>';
  table.dataset.editorialRenderedView = 'active';
}

async function renderInactiveList(viewName) {
  const table = document.querySelector('#view table.table');
  if (!table) return;
  const rows = await editorialRequest(EDITORIAL_VIEWS[viewName].api);
  const tbody = table.querySelector('tbody');
  if (tbody) tbody.innerHTML = lifecycleListRows(rows);
  table.dataset.editorialRenderedView = viewName;
}

function syncFilterButtons() {
  document.querySelectorAll('.editorial-filter[data-editorial-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.editorialView === editorialView);
  });
}

async function selectEditorialView(viewName) {
  if (!EDITORIAL_VIEWS[viewName]) return;
  editorialView = viewName;
  syncFilterButtons();
  if (viewName === 'active') {
    document.querySelector('.nav[data-view="posts"]')?.click();
    return;
  }
  await renderInactiveList(viewName);
}

async function enhanceContentScreen() {
  if (enhancementBusy) return;
  if (document.querySelector('#page-title')?.textContent !== 'Контент') return;
  const table = document.querySelector('#view table.table');
  if (!table) return;
  enhancementBusy = true;
  try {
    if (!document.querySelector('.editorial-filter-bar')) {
      const bar = document.createElement('div');
      bar.className = 'editorial-filter-bar';
      bar.innerHTML = Object.entries(EDITORIAL_VIEWS)
        .map(([key, value]) => `<button type="button" class="secondary editorial-filter" data-editorial-view="${key}">${value.label}</button>`)
        .join('');
      table.before(bar);
      bar.querySelectorAll('.editorial-filter').forEach((button) => button.addEventListener('click', () => {
        selectEditorialView(button.dataset.editorialView).catch(showEditorialPageError);
      }));
    }
    syncFilterButtons();
    if (table.dataset.editorialRenderedView === editorialView) return;
    if (editorialView === 'active') await filterLegacyActiveRows();
    else await renderInactiveList(editorialView);
  } finally {
    enhancementBusy = false;
  }
}

function inspectorMedia(post) {
  if (!post.media?.length) return '<div class="inspector-media-host"><div class="inspector-empty-media">Нет медиа</div></div>';
  const fallback = `<div class="inspector-media-grid">${post.media.map((media, index) => `<figure>
    <img src="/public-media/${editorialEscape(media.relative_path)}" alt="">
    <figcaption>#${index + 1} · ${media.width || '?'}×${media.height || '?'}</figcaption>
  </figure>`).join('')}</div>`;
  return `<div class="inspector-media-host">${fallback}</div>`;
}

function inspectorTargets(post) {
  return `<div class="inspector-targets">${post.targets.map((target) => `<div class="inspector-target">
    <div><strong>${editorialEscape(target.platform)}</strong> · ${editorialEscape(target.account_name)}</div>
    <div>${editorialBadge(target.state)} ${target.enabled ? '<span class="small muted">выбрано</span>' : '<span class="small muted">не выбрано</span>'}</div>
    ${target.last_error ? `<div class="small error">${editorialEscape(target.last_error)}</div>` : ''}
  </div>`).join('') || '<div class="muted">Площадки не выбраны</div>'}</div>`;
}

function inspectorEvents(post) {
  return `<div class="inspector-events">${post.recentEvents.map((item) => `<div class="inspector-event">
    <span class="small muted">${formatEditorialTime(item.created_at)}</span>
    <strong>${editorialEscape(item.event_type)}</strong>
    <span>${editorialEscape(item.message)}</span>
  </div>`).join('') || '<div class="muted">Событий пока нет</div>'}</div>`;
}

function actionButtons(post) {
  const buttons = [];
  if (post.actions.edit) buttons.push('<button type="button" class="primary inspector-edit">Редактировать</button>');
  if (post.actions.archive) buttons.push('<button type="button" class="secondary inspector-archive">В архив</button>');
  if (post.actions.trash) buttons.push('<button type="button" class="secondary danger inspector-trash">В корзину</button>');
  if (post.actions.restore) buttons.push('<button type="button" class="secondary inspector-restore">Восстановить</button>');
  if (post.actions.deletePermanently) buttons.push('<button type="button" class="secondary danger inspector-delete-permanent">Удалить навсегда</button>');
  return buttons.join('');
}

async function refreshEditorialCollection() {
  if (editorialView === 'active') {
    document.querySelector('.nav[data-view="posts"]')?.click();
  } else {
    await renderInactiveList(editorialView);
  }
}

function legacyEditor(postId) {
  const button = [...document.querySelectorAll('.open-post')].find((item) => item.dataset.id === postId);
  if (!button) throw new Error('Сначала вернитесь в «Активные», чтобы редактировать пост');
  bypassInspectorOnce = true;
  button.click();
}

async function openContentInspector(postId) {
  const post = await editorialRequest(`/api/editorial/posts/${encodeURIComponent(postId)}`);
  const overlay = document.createElement('div');
  overlay.className = 'modal editorial-inspector-overlay';
  overlay.innerHTML = `<div class="modal-card editorial-inspector">
    <div class="inspector-head">
      <div><div class="small muted">${editorialEscape(post.project_name)}</div><h2>${editorialEscape(post.title)}</h2></div>
      <div class="editorial-badges">${editorialBadge(post.editorial_stage)} ${editorialBadge(post.status)}</div>
    </div>
    ${inspectorMedia(post)}
    <div class="inspector-grid">
      <section class="card"><h3>Публикация</h3><div class="inspector-body">${editorialEscape(post.body)}</div></section>
      <section class="card"><h3>Параметры</h3>
        <dl class="inspector-meta">
          <div><dt>Режим</dt><dd>${editorialEscape(post.schedule_mode)}</dd></div>
          <div><dt>Дата</dt><dd>${formatEditorialTime(post.scheduled_at_utc || post.scheduled_at)}</dd></div>
          <div><dt>Timezone</dt><dd>${editorialEscape(post.schedule_timezone || '—')}</dd></div>
          <div><dt>Формат</dt><dd>${editorialEscape(post.publication_kind)} / ${editorialEscape(post.content_format)}</dd></div>
          <div><dt>Версия</dt><dd>${Number(post.content_version)}</dd></div>
          <div><dt>Источник</dt><dd>${editorialEscape(post.source_type || 'manual')}</dd></div>
        </dl>
      </section>
    </div>
    <section class="card inspector-section"><h3>Площадки</h3>${inspectorTargets(post)}</section>
    <section class="card inspector-section"><h3>Последние события</h3>${inspectorEvents(post)}</section>
    <div class="row-actions inspector-actions">${actionButtons(post)}<button type="button" class="secondary inspector-close">Закрыть</button></div>
    <div class="error inspector-error"></div>
  </div>`;
  document.body.append(overlay);
  const mediaCleanup = window.PublikatorMediaViewer?.mount?.(overlay.querySelector('.inspector-media-host'), post) || (() => {});
  const close = () => { mediaCleanup(); overlay.remove(); };
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('.inspector-close')?.addEventListener('click', close);
  overlay.querySelector('.inspector-edit')?.addEventListener('click', () => {
    try { close(); legacyEditor(post.id); } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
  });

  const mutate = async (action, method = 'POST', extra = {}) => {
    const errorBox = overlay.querySelector('.inspector-error');
    if (errorBox) errorBox.textContent = '';
    try {
      await editorialRequest(`/api/posts/${encodeURIComponent(post.id)}/${action}`, {
        method,
        body: JSON.stringify({ expectedContentVersion: post.content_version, ...extra })
      });
      close();
      await refreshEditorialCollection();
    } catch (error) {
      if (errorBox) errorBox.textContent = error instanceof Error ? error.message : String(error);
    }
  };

  overlay.querySelector('.inspector-archive')?.addEventListener('click', () => mutate('archive'));
  overlay.querySelector('.inspector-trash')?.addEventListener('click', () => {
    if (window.confirm('Переместить публикацию в корзину? Она перестанет участвовать в публикации.')) mutate('trash');
  });
  overlay.querySelector('.inspector-restore')?.addEventListener('click', () => mutate('restore'));
  overlay.querySelector('.inspector-delete-permanent')?.addEventListener('click', () => {
    if (window.confirm('Удалить пост навсегда из Publikator? Это действие нельзя отменить. Внешние соцсети не затрагиваются.')) {
      mutate('permanent', 'DELETE', { confirm: true });
    }
  });
}

function showEditorialPageError(error) {
  const view = document.querySelector('#view');
  if (!view) return;
  let box = view.querySelector('.editorial-page-error');
  if (!box) {
    box = document.createElement('div');
    box.className = 'card error editorial-page-error';
    view.prepend(box);
  }
  box.textContent = error instanceof Error ? error.message : String(error);
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest('.open-post');
  if (!button?.dataset.id) return;
  if (bypassInspectorOnce) {
    bypassInspectorOnce = false;
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  openContentInspector(button.dataset.id).catch(showEditorialPageError);
}, true);

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.nav[data-view="posts"]')) editorialView = 'active';
}, true);

const editorialObserver = new MutationObserver(() => {
  enhanceContentScreen().catch(showEditorialPageError);
});
editorialObserver.observe(document.body, { childList: true, subtree: true });
enhanceContentScreen().catch(showEditorialPageError);
