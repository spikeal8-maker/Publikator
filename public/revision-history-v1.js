import { publicationFormatLabel, scheduleModeLabel, sourceLabel, statusLabel } from './presentation-labels.js';

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? esc(value) : esc(date.toLocaleString());
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.code = payload?.code || null;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function revisionMarkers(item) {
  const markers = [];
  if (item.isCurrent) markers.push('<span class="badge">текущая</span>');
  if (item.isReadyRevision) markers.push('<span class="badge READY">READY snapshot</span>');
  if (item.restoredFromContentVersion) markers.push(`<span class="badge">восстановлена из версии ${Number(item.restoredFromContentVersion)}</span>`);
  return markers.join(' ');
}

function historyListMarkup(items) {
  if (!items.length) return '<div class="muted">История изменений пока пуста.</div>';
  const result = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const previous = index > 0 ? items[index - 1] : null;
    if (previous && previous.contentVersion - item.contentVersion > 1) {
      result.push(`<div class="revision-history-gap">Исторический разрыв: версии ${item.contentVersion + 1}–${previous.contentVersion - 1} отсутствуют</div>`);
    }
    result.push(`<button type="button" class="revision-history-item" data-revision-id="${esc(item.id)}">
      <span><strong>Версия ${Number(item.contentVersion)}</strong> · ${formatTime(item.createdAt)}</span>
      <span class="small">${esc(sourceLabel(item.actorSource))} · ${esc(statusLabel(item.editorialStage))}</span>
      <span class="revision-history-markers">${revisionMarkers(item)}</span>
    </button>`);
  }
  return result.join('');
}

function diffLinesMarkup(diff) {
  if (!diff) return '<div class="muted">Нет данных сравнения.</div>';
  if (diff.mode === 'fallback') {
    return `<div class="revision-fallback"><div><strong>Было</strong><pre>${esc(diff.before)}</pre></div><div><strong>Сейчас</strong><pre>${esc(diff.after)}</pre></div></div>`;
  }
  return `<pre class="revision-line-diff">${diff.lines.map((line) => {
    const prefix = line.type === 'added' ? '+ ' : line.type === 'removed' ? '− ' : '  ';
    return `<span class="revision-line ${esc(line.type)}">${esc(prefix + line.text)}</span>`;
  }).join('\n')}</pre>`;
}

function publicationDiffMarkup(diff) {
  const publication = diff.publication;
  const fields = [
    ['Режим', scheduleModeLabel(publication.scheduleMode.before), scheduleModeLabel(publication.scheduleMode.after)],
    ['Дата', publication.scheduledAtUtc.before || '—', publication.scheduledAtUtc.after || '—'],
    ['Часовой пояс', publication.scheduleTimezone.before || '—', publication.scheduleTimezone.after || '—'],
    ['Формат', publicationFormatLabel(publication.publicationKind.before, publication.contentFormat.before),
      publicationFormatLabel(publication.publicationKind.after, publication.contentFormat.after)]
  ];
  return `<dl class="revision-field-diff">${fields.map(([label, before, after]) =>
    `<div><dt>${esc(label)}</dt><dd><span>${esc(before)}</span><span>→</span><span>${esc(after)}</span></dd></div>`).join('')}</dl>`;
}

function targetDiffMarkup(diff, revision) {
  const names = new Map((revision.targets || []).map((target) => [
    target.accountId,
    target.accountMissing ? `${target.accountId} (удалена)` : `${target.platform || ''} · ${target.accountName || target.accountId}`
  ]));
  const label = (accountId) => names.get(accountId) || accountId;
  const rows = [];
  for (const target of diff.targets.added) rows.push(`<li>Добавлена площадка: ${esc(label(target.accountId))}</li>`);
  for (const target of diff.targets.removed) rows.push(`<li>Удалена площадка: ${esc(label(target.accountId))}</li>`);
  for (const target of diff.targets.changed) {
    const before = target.before.overrideText || 'основной текст';
    const after = target.after.overrideText || 'основной текст';
    rows.push(`<li>Изменена площадка ${esc(label(target.accountId))}: ${esc(before)} → ${esc(after)}</li>`);
  }
  return rows.length ? `<ul class="revision-change-list">${rows.join('')}</ul>` : '<div class="muted">Площадки не изменились.</div>';
}

function mediaDiffMarkup(diff, revision) {
  const mediaNames = new Map((revision.media || []).map((item) => [item.id, item.originalName || item.id]));
  const before = (diff.media.before || []).map((item) => `${item.role}: ${mediaNames.get(item.mediaId) || item.mediaId}`).join(' → ') || 'нет';
  const after = (diff.media.after || []).map((item) => `${item.role}: ${item.mediaId}`).join(' → ') || 'нет';
  return `<div class="revision-media-diff"><div><strong>Версия:</strong> ${esc(before)}</div><div><strong>Сейчас:</strong> ${esc(after)}</div></div>`;
}

function detailMarkup(diff) {
  const revision = diff.revision;
  const compatibility = diff.restoreCompatibility;
  const restore = compatibility.canRestore
    ? '<button type="button" class="primary revision-restore">Восстановить эту версию</button>'
    : `<div class="revision-restore-blocked">${esc(compatibility.reason || 'Восстановление недоступно.')}</div>`;

  return `<div class="revision-detail" data-selected-revision="${esc(revision.id)}">
    <div class="revision-detail-head">
      <div><h3>Версия ${Number(revision.contentVersion)}</h3><div class="small muted">${formatTime(revision.createdAt)} · ${esc(sourceLabel(revision.actorSource))} · ${esc(statusLabel(revision.editorialStage))}</div></div>
      <div>${revisionMarkers(revision)}</div>
    </div>
    <section class="card revision-section"><h3>Текст</h3>
      <div class="revision-title-diff"><strong>Заголовок</strong><div>${esc(diff.text.title.before)}</div><div>→ ${esc(diff.text.title.after)}</div></div>
      <strong>Основной текст</strong>
      ${diffLinesMarkup(diff.text.body.diff)}
    </section>
    <section class="card revision-section"><h3>Публикация</h3>${publicationDiffMarkup(diff)}</section>
    <section class="card revision-section"><h3>Площадки</h3>${targetDiffMarkup(diff, revision)}</section>
    <section class="card revision-section"><h3>Медиа</h3>${mediaDiffMarkup(diff, revision)}
      <div class="small ${compatibility.canRestore ? 'muted' : 'error'}">${esc(compatibility.canRestore ? 'Набор медиа совместим с полным восстановлением.' : compatibility.reason || '')}</div>
    </section>
    <section class="revision-restore-area">
      ${restore}
      ${compatibility.canRestore ? '<div class="small muted">Будет создана новая версия. Публикация вернётся в черновик и потребует повторной проверки.</div>' : ''}
    </section>
  </div>`;
}

export async function openRevisionHistory(post, { onRestored } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal revision-history-overlay';
  overlay.innerHTML = `<div class="modal-card revision-history-modal">
    <div class="revision-history-head"><div><div class="small muted">${esc(post.title)}</div><h2>История изменений</h2></div><button type="button" class="secondary revision-history-close">Закрыть</button></div>
    <div class="revision-history-layout">
      <aside><div class="revision-history-list"></div><button type="button" class="secondary revision-history-more hidden">Показать ещё</button></aside>
      <main class="revision-history-detail"><div class="muted">Выберите версию для сравнения с текущим материалом.</div></main>
    </div>
    <div class="error revision-history-error"></div>
  </div>`;
  document.body.append(overlay);

  const listHost = overlay.querySelector('.revision-history-list');
  const detailHost = overlay.querySelector('.revision-history-detail');
  const moreButton = overlay.querySelector('.revision-history-more');
  const errorBox = overlay.querySelector('.revision-history-error');
  let items = [];
  let nextBeforeVersion = null;
  let currentDiff = null;

  const close = () => overlay.remove();
  overlay.querySelector('.revision-history-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });

  const renderList = () => {
    listHost.innerHTML = historyListMarkup(items);
    moreButton?.classList.toggle('hidden', !nextBeforeVersion);
  };

  const loadPage = async (reset = false) => {
    if (reset) {
      items = [];
      nextBeforeVersion = null;
    }
    const suffix = nextBeforeVersion ? `&beforeVersion=${encodeURIComponent(nextBeforeVersion)}` : '';
    const payload = await requestJson(`/api/posts/${encodeURIComponent(post.id)}/revisions?limit=50${suffix}`);
    items.push(...payload.items);
    nextBeforeVersion = payload.nextBeforeVersion;
    renderList();
  };

  const selectRevision = async (revisionId) => {
    if (errorBox) errorBox.textContent = '';
    currentDiff = await requestJson(`/api/posts/${encodeURIComponent(post.id)}/revisions/${encodeURIComponent(revisionId)}/diff`);
    detailHost.innerHTML = detailMarkup(currentDiff);
    overlay.querySelectorAll('.revision-history-item').forEach((button) => button.classList.toggle('active', button.dataset.revisionId === revisionId));
  };

  listHost?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('.revision-history-item') : null;
    if (!button?.dataset.revisionId) return;
    selectRevision(button.dataset.revisionId).catch((error) => {
      if (errorBox) errorBox.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  moreButton?.addEventListener('click', () => loadPage(false).catch((error) => {
    if (errorBox) errorBox.textContent = error instanceof Error ? error.message : String(error);
  }));

  detailHost?.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('.revision-restore') : null;
    if (!button || !currentDiff) return;
    if (!window.confirm('Восстановить эту версию как новую? Материал вернётся в черновик и потребует повторной проверки.')) return;
    button.disabled = true;
    if (errorBox) errorBox.textContent = '';
    try {
      const result = await requestJson(
        `/api/posts/${encodeURIComponent(post.id)}/revisions/${encodeURIComponent(currentDiff.revision.id)}/restore`,
        { method: 'POST', body: JSON.stringify({ expectedContentVersion: currentDiff.currentContentVersion }) }
      );
      close();
      await onRestored?.(result);
    } catch (error) {
      if (errorBox) {
        errorBox.textContent = error?.code === 'REVISION_CONFLICT'
          ? 'Материал уже изменён. Обновите историю и повторите.'
          : error instanceof Error ? error.message : String(error);
      }
      button.disabled = false;
    }
  });

  try {
    await loadPage(true);
  } catch (error) {
    if (errorBox) errorBox.textContent = error instanceof Error ? error.message : String(error);
  }
}
