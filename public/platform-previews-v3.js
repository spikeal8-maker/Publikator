const PLATFORM_LABELS = {
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
  instagram: 'Instagram'
};

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function duration(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return null;
  const total = Math.round(Number(ms) / 1000);
  const min = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function primaryMedia(preview) {
  return (preview.media || []).filter((item) => item.role !== 'poster');
}

function mediaElement(item, vertical) {
  if (!item) return '<div class="platform-preview-empty">Без media</div>';
  const cls = vertical ? 'platform-preview-media vertical' : 'platform-preview-media';
  const poster = item.posterUrl ? ` poster="${esc(item.posterUrl)}"` : '';
  const body = item.mimeType?.startsWith('video/')
    ? `<video controls preload="metadata"${poster}><source src="${esc(item.url)}" type="${esc(item.mimeType)}"></video>`
    : `<img src="${esc(item.url)}" alt="">`;
  return `<div class="${cls}">${body}${vertical ? '<div class="platform-safe-zone safe-top">safe zone</div><div class="platform-safe-zone safe-bottom">safe zone</div>' : ''}</div>`;
}

function carousel(preview) {
  const items = primaryMedia(preview);
  if (items.length < 2) return '';
  return `<div class="platform-preview-strip">${items.map((item, index) => `<div class="platform-preview-thumb">
    ${item.mimeType?.startsWith('video/') ? `<video muted preload="metadata"${item.posterUrl ? ` poster="${esc(item.posterUrl)}"` : ''}></video>` : `<img src="${esc(item.url)}" alt="">`}
    <span>${index + 1}</span>
  </div>`).join('')}</div>`;
}

function issueList(preview) {
  if (!preview.issues?.length) return '<div class="platform-preview-ok">Preflight: OK</div>';
  return `<div class="platform-preview-issues">${preview.issues.map((issue) => `<div class="platform-preview-issue ${esc(issue.severity)}">
    <strong>${issue.severity === 'error' ? 'Ошибка' : 'Предупреждение'}</strong>
    <span>${esc(issue.message)}</span>
    <code>${esc(issue.code)}</code>
  </div>`).join('')}</div>`;
}

function caption(preview) {
  return `<div class="platform-preview-caption">${esc(preview.text || '') || '<span class="muted">Без текста</span>'}</div>`;
}

function card(preview) {
  const items = primaryMedia(preview);
  const first = items[0];
  const vertical = Boolean(preview.verticalSafeZone);
  const media = mediaElement(first, vertical);
  const text = caption(preview);
  const content = preview.captionPlacement === 'above' ? `${text}${media}` : `${media}${text}`;
  const videoDuration = duration(preview.videoDurationMs);
  return `<article class="platform-preview-card platform-${esc(preview.platform)} ${preview.enabled ? '' : 'disabled'}">
    <header class="platform-preview-head">
      <div><strong>${esc(PLATFORM_LABELS[preview.platform] || preview.platform)}</strong><span>${esc(preview.accountName)}</span></div>
      <span class="badge">${preview.enabled ? 'выбрано' : 'не выбрано'}</span>
    </header>
    <div class="platform-preview-meta">
      <span>${esc(preview.publicationKind)} / ${esc(preview.contentFormat)}</span>
      <span>${preview.mediaCount} media${videoDuration ? ` · ${videoDuration}` : ''}</span>
      <span>${esc(preview.targetState)}</span>
    </div>
    <div class="platform-preview-client ${vertical ? 'phone' : ''}">${content}${carousel(preview)}</div>
    ${issueList(preview)}
  </article>`;
}

function mount(host, postId) {
  if (!host) return () => {};
  let disposed = false;
  host.innerHTML = '<div class="muted">Загрузка platform previews…</div>';
  fetch(`/api/posts/${encodeURIComponent(postId)}/platform-previews`, { credentials: 'same-origin' })
    .then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      return payload;
    })
    .then((payload) => {
      if (disposed) return;
      const previews = payload.previews || [];
      host.innerHTML = previews.length
        ? `<div class="platform-preview-note">Предпросмотр учитывает resolved rendition и preflight, но не имитирует pixel-perfect интерфейс соцсети.</div><div class="platform-preview-grid">${previews.map(card).join('')}</div>`
        : '<div class="muted">Площадки для предпросмотра отсутствуют</div>';
    })
    .catch((error) => {
      if (!disposed) host.innerHTML = `<div class="error">${esc(error instanceof Error ? error.message : String(error))}</div>`;
    });
  return () => { disposed = true; host.innerHTML = ''; };
}

window.PublikatorPlatformPreviews = { mount };
