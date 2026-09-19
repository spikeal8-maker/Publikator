import { renderRichText } from './rich-text-editor-v1.js';

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
    <strong>${issue.severity === 'error' ? 'Ошибка' : issue.severity === 'warning' ? 'Предупреждение' : 'Информация'}</strong>
    <span>${esc(issue.message)}</span>
    <code>${esc(issue.code)}</code>
  </div>`).join('')}</div>`;
}

function caption(preview) {
  if (preview.platform === 'telegram' || preview.platform === 'max') {
    return `<div class="platform-preview-caption rich-text-preview" data-rich-preview-target="${esc(preview.targetId)}"></div>`;
  }
  const compiled = preview.compilation?.transport?.kind === 'plain'
    ? preview.compilation.transport.text
    : preview.text;
  return `<div class="platform-preview-caption">${esc(compiled || '') || '<span class="muted">Без текста</span>'}</div>`;
}

function sourceLabel(source) {
  if (source === 'platform_override') return 'Свой rich-вариант';
  if (source === 'legacy_override') return 'Legacy plain override';
  if (source === 'legacy_rendition_plain') return 'Legacy TargetRendition plain';
  return 'Base rich text';
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
      <span class="platform-preview-source">${esc(sourceLabel(preview.textSource))}</span>
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
        ? `<div class="platform-preview-note">Предпросмотр использует тот же rich-text resolver/compiler, что preflight и publisher. Compiled MAX HTML никогда не вставляется как raw HTML.</div><div class="platform-preview-grid">${previews.map(card).join('')}</div>`
        : '<div class="muted">Площадки для предпросмотра отсутствуют</div>';
      for (const preview of previews) {
        if (preview.platform !== 'telegram' && preview.platform !== 'max') continue;
        const target = host.querySelector(`[data-rich-preview-target="${CSS.escape(String(preview.targetId))}"]`);
        if (target) renderRichText(target, preview.resolvedRichText);
      }
    })
    .catch((error) => {
      if (!disposed) host.innerHTML = `<div class="error">${esc(error instanceof Error ? error.message : String(error))}</div>`;
    });
  return () => { disposed = true; host.innerHTML = ''; };
}

let pendingPostId = null;
let activeCleanup = null;

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('.open-post') : null;
  if (!target?.dataset.id) return;
  pendingPostId = target.dataset.id;
  setTimeout(() => { if (pendingPostId === target.dataset.id) pendingPostId = null; }, 1500);
}, true);

const observer = new MutationObserver(() => {
  const inspector = document.querySelector('.editorial-inspector');
  if (!inspector || !pendingPostId || inspector.querySelector('.platform-preview-section')) return;
  const section = document.createElement('section');
  section.className = 'card inspector-section platform-preview-section';
  section.innerHTML = '<h3>Предпросмотр площадок</h3><div class="platform-preview-host"></div>';
  const targets = inspector.querySelector('.inspector-targets')?.closest('.inspector-section');
  if (targets) targets.before(section); else inspector.querySelector('.inspector-actions')?.before(section);
  activeCleanup?.();
  activeCleanup = mount(section.querySelector('.platform-preview-host'), pendingPostId);
  pendingPostId = null;
});
observer.observe(document.body, { childList: true, subtree: true });

window.PublikatorPlatformPreviews = { mount };
