const DEFAULT_STORY_DURATION_MS = 5000;

function viewerEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function mediaUrl(relativePath) {
  return `/public-media/${String(relativePath || '').split('/').map(encodeURIComponent).join('/')}`;
}

export function formatViewerBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function formatViewerDuration(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function buildViewerModel(post) {
  const media = Array.isArray(post?.media) ? post.media : [];
  const relations = Array.isArray(post?.contentMedia) ? post.contentMedia : [];
  const byId = new Map(media.map((item) => [item.id, item]));
  const related = relations.length
    ? relations.map((relation) => {
        const asset = byId.get(relation.media_id);
        return asset ? { ...asset, role: relation.role, preview_duration_ms: relation.preview_duration_ms, relation_order: relation.sort_order } : null;
      }).filter(Boolean)
    : media.map((asset, index) => ({ ...asset, role: null, preview_duration_ms: null, relation_order: index }));
  const items = related.filter((item) => item.role !== 'poster').map((item) => {
    const isVideo = String(item.mime_type || '').startsWith('video/');
    const poster = item.poster_asset_id ? byId.get(item.poster_asset_id) : null;
    return {
      ...item,
      isVideo,
      src: mediaUrl(item.relative_path),
      posterSrc: poster ? mediaUrl(poster.relative_path) : null,
      previewDurationMs: Number(item.preview_duration_ms || (isVideo ? item.duration_ms : DEFAULT_STORY_DURATION_MS) || DEFAULT_STORY_DURATION_MS)
    };
  });
  const format = post?.content_format || 'IMAGE';
  const kind = post?.publication_kind || 'FEED';
  const mode = format === 'STORY_SEQUENCE' ? 'story'
    : format === 'CAROUSEL' ? 'carousel'
      : ['VIDEO', 'VERTICAL_VIDEO'].includes(format) ? 'video'
        : format === 'IMAGE' ? 'image' : 'empty';
  return {
    mode,
    kind,
    format,
    phoneFrame: kind === 'SHORT' || kind === 'STORY' || format === 'VERTICAL_VIDEO' || format === 'STORY_SEQUENCE',
    items
  };
}

function viewerMeta(item, index, total) {
  if (!item) return '';
  const dimensions = item.width && item.height ? `${item.width}×${item.height}` : 'размеры —';
  const duration = item.isVideo ? ` · ${formatViewerDuration(item.duration_ms)}` : '';
  const codec = item.isVideo && item.video_codec ? ` · ${viewerEscape(item.video_codec)}` : '';
  return `${index + 1}/${total} · ${viewerEscape(dimensions)} · ${formatViewerBytes(item.size_bytes)}${duration}${codec}`;
}

function progressMarkup(count) {
  return `<div class="viewer-story-progress">${Array.from({ length: count }, (_, index) =>
    `<span class="viewer-progress-track" data-progress-index="${index}"><i></i></span>`).join('')}</div>`;
}

export function mountMediaViewer(root, post) {
  if (!root) return () => {};
  const model = buildViewerModel(post);
  if (!model.items.length) {
    root.innerHTML = '<div class="inspector-empty-media">Нет медиа</div>';
    return () => {};
  }

  let index = 0;
  let zoom = 1;
  let fit = true;
  let timer = null;
  let activeVideo = null;

  root.innerHTML = `<div class="media-viewer ${model.phoneFrame ? 'is-phone' : ''} ${model.mode === 'story' ? 'is-story' : ''}" tabindex="0">
    ${model.mode === 'story' ? progressMarkup(model.items.length) : ''}
    <div class="viewer-stage-wrap">
      <button type="button" class="viewer-nav viewer-prev" aria-label="Предыдущий кадр">‹</button>
      <div class="viewer-stage"><div class="viewer-media"></div></div>
      <button type="button" class="viewer-nav viewer-next" aria-label="Следующий кадр">›</button>
    </div>
    <div class="viewer-toolbar">
      <div class="viewer-meta"></div>
      <div class="viewer-tools">
        <button type="button" class="secondary viewer-zoom-out" title="Уменьшить">−</button>
        <button type="button" class="secondary viewer-zoom-in" title="Увеличить">+</button>
        <button type="button" class="secondary viewer-fit">Fit</button>
        <button type="button" class="secondary viewer-actual">1:1</button>
        <button type="button" class="secondary viewer-fullscreen">На весь экран</button>
      </div>
    </div>
  </div>`;

  const shell = root.querySelector('.media-viewer');
  const stage = root.querySelector('.viewer-stage');
  const mediaHost = root.querySelector('.viewer-media');
  const meta = root.querySelector('.viewer-meta');
  const prev = root.querySelector('.viewer-prev');
  const next = root.querySelector('.viewer-next');
  const zoomIn = root.querySelector('.viewer-zoom-in');
  const zoomOut = root.querySelector('.viewer-zoom-out');
  const fitButton = root.querySelector('.viewer-fit');
  const actualButton = root.querySelector('.viewer-actual');
  const fullscreenButton = root.querySelector('.viewer-fullscreen');

  const clearPlayback = () => {
    if (timer) window.clearTimeout(timer);
    timer = null;
    if (activeVideo) {
      activeVideo.pause();
      activeVideo = null;
    }
  };

  const applyImageTransform = () => {
    const image = mediaHost?.querySelector('img');
    if (!image) return;
    image.classList.toggle('actual-size', !fit);
    image.style.transform = `scale(${zoom})`;
  };

  const updateProgress = (fraction = 0) => {
    if (model.mode !== 'story') return;
    root.querySelectorAll('.viewer-progress-track').forEach((track, progressIndex) => {
      const fill = track.querySelector('i');
      if (!fill) return;
      fill.style.width = progressIndex < index ? '100%' : progressIndex > index ? '0%' : `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    });
  };

  const move = (delta) => {
    if (model.items.length < 2) return;
    index = (index + delta + model.items.length) % model.items.length;
    render();
  };

  const render = () => {
    clearPlayback();
    zoom = 1;
    fit = true;
    const item = model.items[index];
    if (meta) meta.textContent = viewerMeta(item, index, model.items.length);
    if (prev) prev.hidden = model.items.length < 2;
    if (next) next.hidden = model.items.length < 2;
    if (zoomIn) zoomIn.hidden = item.isVideo;
    if (zoomOut) zoomOut.hidden = item.isVideo;
    if (fitButton) fitButton.hidden = item.isVideo;
    if (actualButton) actualButton.hidden = item.isVideo;
    updateProgress(0);

    if (item.isVideo) {
      mediaHost.innerHTML = `<video class="viewer-video" src="${viewerEscape(item.src)}" ${item.posterSrc ? `poster="${viewerEscape(item.posterSrc)}"` : ''} controls playsinline preload="metadata"></video>`;
      const video = mediaHost.querySelector('video');
      activeVideo = video;
      if (model.mode === 'story') {
        video.addEventListener('timeupdate', () => {
          const duration = Number(video.duration || 0);
          if (duration > 0) updateProgress(video.currentTime / duration);
        });
        video.addEventListener('ended', () => move(1), { once: true });
        video.play().catch(() => undefined);
      }
    } else {
      mediaHost.innerHTML = `<img class="viewer-image" src="${viewerEscape(item.src)}" alt="${viewerEscape(item.original_name || '')}">`;
      applyImageTransform();
      if (model.mode === 'story') {
        const started = performance.now();
        const duration = Math.max(1000, Number(item.previewDurationMs || DEFAULT_STORY_DURATION_MS));
        const tick = (now) => {
          if (!mediaHost.querySelector('.viewer-image')) return;
          const fraction = Math.min(1, (now - started) / duration);
          updateProgress(fraction);
          if (fraction < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        timer = window.setTimeout(() => move(1), duration);
      }
    }
  };

  prev?.addEventListener('click', () => move(-1));
  next?.addEventListener('click', () => move(1));
  zoomIn?.addEventListener('click', () => { zoom = Math.min(4, zoom + 0.25); applyImageTransform(); });
  zoomOut?.addEventListener('click', () => { zoom = Math.max(0.25, zoom - 0.25); applyImageTransform(); });
  fitButton?.addEventListener('click', () => { fit = true; zoom = 1; applyImageTransform(); });
  actualButton?.addEventListener('click', () => { fit = false; zoom = 1; applyImageTransform(); });
  fullscreenButton?.addEventListener('click', () => stage?.requestFullscreen?.());
  shell?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') move(-1);
    if (event.key === 'ArrowRight') move(1);
  });

  render();
  return clearPlayback;
}

if (typeof window !== 'undefined') {
  window.PublikatorMediaViewer = { buildViewerModel, mount: mountMediaViewer, formatViewerBytes, formatViewerDuration };
}
