function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function mediaUrl(relativePath) {
  return `/public-media/${String(relativePath || '').split('/').map(encodeURIComponent).join('/')}`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function formatDuration(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function publicationMediaProjection(post) {
  const media = Array.isArray(post?.media) ? post.media : [];
  const byId = new Map(media.map((item) => [item.id, item]));
  const posterIds = new Set(
    media
      .filter((item) => String(item?.mime_type || '').startsWith('video/') && item.poster_asset_id)
      .map((item) => item.poster_asset_id)
  );
  const items = media
    .filter((item) => !posterIds.has(item.id))
    .map((item) => ({
      ...item,
      isVideo: String(item?.mime_type || '').startsWith('video/'),
      poster: item.poster_asset_id ? byId.get(item.poster_asset_id) || null : null
    }));
  return { items, posterIds, byId };
}

async function requestJson(url, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(isFormData ? {} : options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function errorBox(form) {
  return form.closest('.modal-card')?.querySelector('#post-error') || null;
}

function setError(form, message = '') {
  const box = errorBox(form);
  if (box) box.textContent = message;
}

function currentVersion(form) {
  const value = Number(form.dataset.contentVersion);
  if (!Number.isInteger(value) || value < 1) throw new Error('Версия поста не загружена');
  return value;
}

function reopenEditor(postId) {
 if(window.publikatorReopenEditor)return window.publikatorReopenEditor(postId);
 const modal=document.querySelector('.modal-card #post-form')?.closest('.modal');modal?.remove();
 return window.publikatorPostEditor?.(postId);
}

function mediaItemHtml(item) {
  const dimensions = item.width && item.height ? `${item.width}×${item.height}` : 'размеры —';
  if (item.isVideo) {
    const poster = item.poster ? ` poster="${escapeHtml(mediaUrl(item.poster.relative_path))}"` : '';
    return `<span class="video-authoring-item is-video" data-authoring-media-id="${escapeHtml(item.id)}">
      <video src="${escapeHtml(mediaUrl(item.relative_path))}"${poster} controls playsinline preload="metadata"></video>
      <div class="video-authoring-meta"><strong>Видео</strong><span>${escapeHtml(item.original_name || 'video.mp4')}</span><span>${escapeHtml(dimensions)} · ${escapeHtml(formatDuration(item.duration_ms))} · ${escapeHtml(formatBytes(item.size_bytes))}</span><span>${escapeHtml(item.video_codec || 'H.264')}${item.audio_codec ? ` / ${escapeHtml(item.audio_codec)}` : ' / без аудио'}</span></div>
      <button type="button" class="secondary danger delete-authoring-media" data-id="${escapeHtml(item.id)}">Удалить видео</button>
    </span>`;
  }
  return `<span class="video-authoring-item" data-authoring-media-id="${escapeHtml(item.id)}">
    <img src="${escapeHtml(mediaUrl(item.relative_path))}" alt="${escapeHtml(item.original_name || '')}">
    <div class="video-authoring-meta"><strong>Изображение</strong><span>${escapeHtml(item.original_name || '')}</span><span>${escapeHtml(dimensions)} · ${escapeHtml(formatBytes(item.size_bytes))}</span></div>
    <button type="button" class="secondary danger delete-authoring-media" data-id="${escapeHtml(item.id)}">Удалить</button>
  </span>`;
}

function bindDeleteButtons(form, post) {
  form.querySelectorAll('.delete-authoring-media').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        setError(form, '');
        const result = await requestJson(`/api/media/${encodeURIComponent(button.dataset.id)}`, {
          method: 'DELETE',
          headers: { 'x-content-version': String(currentVersion(form)) }
        });
        form.dataset.contentVersion = String(result.contentVersion);
        reopenEditor(post.id);
      } catch (error) {
        setError(form, error instanceof Error ? error.message : String(error));
      }
    });
  });
}

function renderAuthoringMedia(form, post) {
  const list = form.querySelector('.media-list');
  const fileInput = form.querySelector('#media-file');
  if (!list || !fileInput) return;
  const { items } = publicationMediaProjection(post);
  list.classList.add('video-authoring-list');
  list.innerHTML = items.map(mediaItemHtml).join('') || '<div class="muted small">Медиа пока не добавлено.</div>';
  bindDeleteButtons(form, post);

  fileInput.accept = 'image/*,video/mp4';
  fileInput.multiple = true;
  const hasVideo = items.some((item) => item.isVideo);
  fileInput.disabled = hasVideo;
  fileInput.title = hasVideo ? 'Video v1 содержит один ролик. Сначала удалите текущее видео.' : 'JPEG/PNG/WebP или MP4 H.264 + AAC';

  let actions=form.querySelector('.sp-media-actions');
  if(!actions){
   actions=document.createElement('div');actions.className='sp-media-actions';
   actions.innerHTML='<button type="button" class="secondary sp-add-photos">+ Добавить фото</button><button type="button" class="secondary sp-add-video">+ Добавить видео</button><span class="small muted" data-media-count></span><input id="editor-video-file" type="file" accept="video/mp4" hidden>';
   list.before(actions);
   actions.querySelector('.sp-add-photos').onclick=()=>{fileInput.accept='image/*';fileInput.multiple=true;fileInput.click();};
   actions.querySelector('.sp-add-video').onclick=()=>actions.querySelector('#editor-video-file').click();
   actions.querySelector('#editor-video-file').onchange=event=>form.uploadPublicationFiles?.([...event.target.files]);
  }
  actions.querySelector('[data-media-count]').textContent=items.length+' файлов';
  actions.querySelector('.sp-add-photos').disabled=hasVideo;
  actions.querySelector('.sp-add-video').disabled=items.length>0;
  actions.querySelector('.sp-add-video').title=items.length?'Для видео создайте отдельную публикацию или удалите фотографии':'Выбрать MP4 (H.264, AAC или без звука)';
  const mediaBlock = list.parentElement;
  const heading = mediaBlock?.querySelector(':scope > strong');
  if (heading) heading.textContent = 'Медиа';
  let help = form.querySelector('.video-authoring-help');
  if (!help) {
    help = document.createElement('div');
    help.className = 'video-authoring-help muted small';
    const host=[...form.querySelectorAll('.ui-editor-section-title')].find(node=>node.querySelector('strong')?.textContent==='Медиа')?.querySelector('.editor-help > div');
    if(host)host.append(help);else fileInput.before(help);
  }
  help.textContent = hasVideo
    ? 'Один MP4 (H.264, AAC или без аудио). Чтобы заменить ролик, сначала удалите текущий.'
    : items.length
      ? 'Можно добавлять изображения. Для MP4 публикация должен быть без других медиа.'
      : 'Изображения или MP4: H.264, AAC либо без аудио. Обложка создаётся автоматически.';
}

function previewMarkup(post) {
  const { items } = publicationMediaProjection(post);
  if (!items.length) return `<div class="platform-preview-media empty">${post.content_format === 'TEXT_ONLY' ? 'Только текст · без вложений' : 'Медиа обязательно'}</div>`;
  const first = items[0];
  const rest = items.length - 1;
  if (first.isVideo) {
    const posterSrc = first.poster ? mediaUrl(first.poster.relative_path) : '';
    return `<div class="platform-preview-media video-authoring-preview">${posterSrc ? `<img src="${escapeHtml(posterSrc)}" alt="">` : '<div class="video-authoring-placeholder">VIDEO</div>'}<span class="video-authoring-badge">▶ Видео</span></div>`;
  }
  return `<div class="platform-preview-media"><img src="${escapeHtml(mediaUrl(first.relative_path))}" alt=""><span class="media-count ${rest > 0 ? '' : 'hidden'}">+${rest}</span></div>`;
}

function syncPlatformPreviews(form, post) {
  const format = form.querySelector('select[name="postFormat"]');
  const isTextOnly = format ? format.value === 'TEXT_ONLY' : post.content_format === 'TEXT_ONLY';
  const previewPost = { ...post, content_format: isTextOnly ? 'TEXT_ONLY' : 'IMAGE' };
  const { items } = publicationMediaProjection(post);
  const first = items[0];
  form.querySelectorAll('.platform-editor-card').forEach((card) => {
    const preview = card.querySelector('.platform-preview-media');
    if (preview) {
      const replacement = document.createElement('div');
      replacement.innerHTML = previewMarkup(previewPost);
      const next = replacement.firstElementChild;
      if (next && preview.outerHTML !== next.outerHTML) preview.replaceWith(next);
    }
    const warning = card.querySelector('.platform-warning');
    if (!warning) return;
    if (!items.length) {
      const message = isTextOnly
        ? 'Текстовый пост без вложений. Доступность выбранной площадки проверяется перед отправкой.'
        : 'Добавьте медиа — без него READY запрещён.';
      if (warning.textContent !== message) warning.textContent = message;
      warning.classList.remove('hidden');
    } else if (first?.isVideo) {
      const message = 'Видео сохранено. Возможность отправки на эту площадку проверяется capability preflight перед READY.';
      if (warning.textContent !== message) warning.textContent = message;
      warning.classList.remove('hidden');
    }
  });
}

const editorStates = new WeakMap();
let activePostId = null;
let syncQueued = false;

function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    const form = document.querySelector('.modal-card #post-form');
    const state = form ? editorStates.get(form) : null;
    if (form && state) syncPlatformPreviews(form, state.post);

    const toolbarMessage = [...document.querySelectorAll('.toolbar .muted')]
      .find((node) => node.textContent?.includes('Пост без изображения'));
    if (toolbarMessage) toolbarMessage.textContent = 'Для формата «С медиа» добавьте вложения. Для текста выберите «Только текст».';
  });
}

async function enhanceEditor(form, postId) {
  if (form.dataset.videoAuthoringEnhanced === '1') return;
  const post = await requestJson(`/api/posts/${encodeURIComponent(postId)}`);
  if (!form.isConnected) return;
  form.dataset.videoAuthoringEnhanced = '1';
  editorStates.set(form, { post });
  renderAuthoringMedia(form, post);
  const availability=await requestJson('/api/platform-capabilities').catch(()=>null);
  if(form.isConnected&&availability){
   const supported=(availability.capabilities||[]).filter(item=>item.supportsVideo).map(item=>({telegram:'Telegram',vk:'VK',max:'MAX',instagram:'Instagram'})[item.platform]||item.platform);
   const note=document.createElement('div');note.className='sp-video-availability';
   note.textContent=supported.length?'Отправка видео: '+supported.join(', ')+'.':'MP4 можно сохранить и посмотреть. Отправка видео на площадки пока не подключена.';
   form.querySelector('.sp-media-actions')?.after(note);
  }

  const fileInput = form.querySelector('#media-file');
  const uploadFiles=async(files)=>{
   if(!files.length||form.dataset.mediaBusy==='1')return;
   form.dataset.mediaBusy='1';
   const controls=[...form.querySelectorAll('button[type="submit"],#mark-ready,#publish-now,.sp-media-actions button,.delete-authoring-media,.move-media')];
   const previous=controls.map(button=>button.disabled);controls.forEach(button=>button.disabled=true);
   try{
    setError(form,'');
    const projection=publicationMediaProjection(post);
    if(projection.items.some(item=>item.isVideo))throw new Error('Видеопубликация содержит один ролик. Сначала удалите текущее видео.');
    if(files.some(file=>file.type==='video/mp4')&&(files.length!==1||projection.items.length))throw new Error('Видео добавляется отдельно от фотографий. Создайте отдельную публикацию или удалите фотографии.');
    for(const [index,file] of files.entries()){
     const isVideo=file.type==='video/mp4';
     if(!isVideo&&!String(file.type).startsWith('image/'))throw new Error('Выберите изображения или MP4.');
     setError(form,'Загрузка '+(index+1)+' из '+files.length+'…');
     const data=new FormData();data.set('file',file,file.name);
     const result=await requestJson('/api/posts/'+encodeURIComponent(post.id)+(isVideo?'/video':'/media'),{method:'POST',body:data,headers:{'x-content-version':String(currentVersion(form))}});
     form.dataset.contentVersion=String(result.contentVersion);
    }
    setError(form,'');reopenEditor(post.id);
   }catch(error){
    setError(form,(error instanceof Error?error.message:String(error))+' Уже загруженные файлы сохранены. Закройте и откройте публикацию, чтобы увидеть их.');
   }finally{
    form.dataset.mediaBusy='';controls.forEach((button,index)=>button.disabled=previous[index]);if(fileInput)fileInput.value='';
   }
  };
  // The shared controls are rendered below after uploadFiles has been initialized.
  form.uploadPublicationFiles=uploadFiles;
  if(fileInput)fileInput.onchange=()=>uploadFiles([...fileInput.files||[]]);
  const rerenderTriggers = form.querySelectorAll('textarea, input[name="accountId"], select[name="postFormat"]');
  rerenderTriggers.forEach((node) => node.addEventListener('input', queueSync));
  rerenderTriggers.forEach((node) => node.addEventListener('change', queueSync));
  queueSync();
}

function tryEnhanceVisibleEditor() {
  const form = document.querySelector('.modal-card #post-form');
  const postId=form?.hasAttribute('data-post-id')?form.dataset.postId:activePostId;
  if (!form || !postId) {
    queueSync();
    return;
  }
  if (form.dataset.videoAuthoringEnhanced !== '1') {
    enhanceEditor(form, postId).catch((error) => {
      setError(form, `Не удалось загрузить video authoring: ${error instanceof Error ? error.message : String(error)}`);
    });
  } else {
    queueSync();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const openButton = target?.closest('.open-post');
    if (openButton?.dataset.id) activePostId = openButton.dataset.id;
    if (target?.closest('#new-post')) activePostId = null;
  }, true);

  const observer = new MutationObserver(() => tryEnhanceVisibleEditor());
  observer.observe(document.body, { childList: true, subtree: true });
  tryEnhanceVisibleEditor();
}
