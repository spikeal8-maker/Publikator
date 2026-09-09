const PLATFORM_NAMES = {
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
  instagram: 'Instagram'
};

const IMMUTABLE_POST_STATUSES = new Set(['PUBLISHING', 'PARTIAL', 'PUBLISHED']);
let activePostId = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[char]);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function targetCheckbox(form, accountId) {
  return [...form.querySelectorAll('input[name="accountId"]')]
    .find((input) => input.value === accountId) || null;
}

function localDateTimeValue(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function mediaPreviewHtml(post) {
  if (!post.media?.length) {
    return '<div class="platform-preview-media empty">Изображение обязательно</div>';
  }
  const first = post.media[0];
  const rest = post.media.length - 1;
  return `<div class="platform-preview-media"><img src="/public-media/${escapeHtml(first.relative_path)}" alt=""><span class="media-count ${rest > 0 ? '' : 'hidden'}">+${rest}</span></div>`;
}

function platformWarning(target, post) {
  if (!post.media?.length) return 'Добавьте хотя бы одно изображение — без него READY запрещён.';
  if (target.platform === 'instagram' && post.media.length !== 1) {
    return 'Текущий Instagram-адаптер публикует ровно одно изображение.';
  }
  return '';
}

function targetCardHtml(target, post) {
  const platformName = PLATFORM_NAMES[target.platform] || target.platform;
  const override = target.override_text || '';
  const warning = platformWarning(target, post);
  return `<article class="platform-editor-card" data-target-id="${escapeHtml(target.id)}" data-account-id="${escapeHtml(target.account_id)}" data-platform="${escapeHtml(target.platform)}">
    <div class="platform-editor-head">
      <div>
        <strong>${escapeHtml(platformName)}</strong>
        <div class="small muted">${escapeHtml(target.account_name)}</div>
      </div>
      <div class="platform-head-badges">
        <span class="badge platform-selection">${target.enabled ? 'Выбрано' : 'Не выбрано'}</span>
        <span class="badge text-mode">${override ? 'Свой текст' : 'Базовый текст'}</span>
      </div>
    </div>
    <div class="platform-editor-body">
      <label class="platform-text-label">Текст для ${escapeHtml(platformName)}
        <textarea class="platform-text" maxlength="20000" placeholder="Пусто = использовать базовый текст">${escapeHtml(override)}</textarea>
      </label>
      <div class="platform-editor-meta">
        <span class="small muted"><span class="resolved-count">0</span> символов в публикации</span>
        <div class="row-actions">
          <button type="button" class="secondary reset-platform-text">Базовый текст</button>
          <button type="button" class="secondary save-platform-text">Сохранить вариант</button>
        </div>
      </div>
      <div class="platform-save-state small muted"></div>
      ${warning ? `<div class="platform-warning small">${escapeHtml(warning)}</div>` : ''}
    </div>
    <div class="platform-preview ${escapeHtml(target.platform)}">
      <div class="platform-preview-top">
        <span class="platform-avatar">${escapeHtml(platformName.slice(0, 1))}</span>
        <div><strong>${escapeHtml(target.account_name)}</strong><div class="small muted">Предпросмотр</div></div>
      </div>
      ${mediaPreviewHtml(post)}
      <div class="platform-preview-text"></div>
    </div>
  </article>`;
}

function setSaveState(card, message, kind = '') {
  const element = card.querySelector('.platform-save-state');
  element.textContent = message;
  element.classList.toggle('error', kind === 'error');
  element.classList.toggle('success-text', kind === 'success');
}

function renderTargetCard(card, target, post, form) {
  const baseText = form.querySelector('textarea[name="body"]')?.value || '';
  const textarea = card.querySelector('.platform-text');
  const ownText = textarea.value.trim();
  const resolvedText = ownText || baseText;
  const checkbox = targetCheckbox(form, target.account_id);
  const selected = checkbox ? checkbox.checked : Boolean(target.enabled);

  card.classList.toggle('platform-disabled', !selected);
  card.querySelector('.platform-selection').textContent = selected ? 'Выбрано' : 'Не выбрано';
  card.querySelector('.text-mode').textContent = ownText ? 'Свой текст' : 'Базовый текст';
  card.querySelector('.resolved-count').textContent = String(resolvedText.length);
  card.querySelector('.platform-preview-text').textContent = resolvedText || 'Текст публикации пока пуст.';

  const warning = card.querySelector('.platform-warning');
  if (warning && target.platform === 'instagram') {
    warning.classList.toggle('hidden', post.media?.length === 1);
  }
}

function lockPublishedEditor(form, post, section) {
  if (!IMMUTABLE_POST_STATUSES.has(post.status)) return;
  section.insertAdjacentHTML('afterbegin', `<div class="editor-lock-notice">Пост имеет статус ${escapeHtml(post.status)}. Контент и площадки зафиксированы; доступны только безопасные действия восстановления для ошибочных публикаций.</div>`);
  form.querySelectorAll('input, textarea, select, button[type="submit"], #mark-ready, #publish-now, .delete-media, .save-platform-text, .reset-platform-text')
    .forEach((element) => { element.disabled = true; });
}

function enhanceScheduleField(form, post) {
  const mode = form.querySelector('select[name="scheduleMode"]');
  const input = form.querySelector('input[name="scheduledAt"]');
  if (!mode || !input) return;
  const label = input.closest('label');
  if (post.schedule_mode === 'AT' && post.scheduled_at && !input.value) input.value = localDateTimeValue(post.scheduled_at);
  const sync = () => label?.classList.toggle('hidden', mode.value !== 'AT');
  mode.addEventListener('change', sync);
  sync();
}

async function enhancePostEditor(form, postId) {
  if (form.dataset.v04Enhanced === '1') return;
  form.dataset.v04Enhanced = '1';

  const post = await requestJson(`/api/posts/${encodeURIComponent(postId)}`);
  if (!form.isConnected) return;

  const modalCard = form.closest('.modal-card');
  modalCard?.classList.add('post-editor-modal');
  enhanceScheduleField(form, post);

  const actions = form.querySelector('.row-actions.full');
  if (!actions) return;

  const section = document.createElement('section');
  section.className = 'platform-workspace full';
  section.innerHTML = `<div class="platform-workspace-head">
      <div>
        <h3>Варианты по площадкам</h3>
        <p class="muted small">Оставьте поле пустым, чтобы использовать базовый текст. Предпросмотр ориентировочный: финальный интерфейс определяется самой соцсетью.</p>
      </div>
      <span class="badge">${post.targets.length} подключений</span>
    </div>
    <div class="platform-editor-grid">
      ${post.targets.map((target) => targetCardHtml(target, post)).join('') || '<div class="card muted">Нет подключённых площадок. Добавьте их в разделе «Соцсети».</div>'}
    </div>`;
  actions.before(section);

  const baseTextarea = form.querySelector('textarea[name="body"]');
  const cards = [...section.querySelectorAll('.platform-editor-card')];
  const targetById = new Map(post.targets.map((target) => [target.id, target]));

  const rerenderAll = () => {
    for (const card of cards) {
      const target = targetById.get(card.dataset.targetId);
      if (target) renderTargetCard(card, target, post, form);
    }
  };

  baseTextarea?.addEventListener('input', rerenderAll);
  form.querySelectorAll('input[name="accountId"]').forEach((checkbox) => checkbox.addEventListener('change', rerenderAll));

  for (const card of cards) {
    const target = targetById.get(card.dataset.targetId);
    if (!target) continue;
    const textarea = card.querySelector('.platform-text');
    textarea.addEventListener('input', () => renderTargetCard(card, target, post, form));

    card.querySelector('.save-platform-text').addEventListener('click', async () => {
      try {
        setSaveState(card, 'Сохранение…');
        const text = textarea.value.trim() ? textarea.value : null;
        const result = await requestJson(`/api/posts/${encodeURIComponent(post.id)}/targets/${encodeURIComponent(target.id)}/text`, {
          method: 'PATCH',
          body: JSON.stringify({ text })
        });
        target.override_text = result.target.overrideText;
        textarea.value = result.target.overrideText || '';
        renderTargetCard(card, target, post, form);
        setSaveState(card, result.target.overrideText ? 'Отдельный текст сохранён.' : 'Используется базовый текст.', 'success');
      } catch (error) {
        setSaveState(card, error instanceof Error ? error.message : String(error), 'error');
      }
    });

    card.querySelector('.reset-platform-text').addEventListener('click', async () => {
      try {
        setSaveState(card, 'Сброс варианта…');
        const result = await requestJson(`/api/posts/${encodeURIComponent(post.id)}/targets/${encodeURIComponent(target.id)}/text`, {
          method: 'PATCH',
          body: JSON.stringify({ text: null })
        });
        target.override_text = null;
        textarea.value = '';
        renderTargetCard(card, target, post, form);
        setSaveState(card, 'Используется базовый текст.', 'success');
      } catch (error) {
        setSaveState(card, error instanceof Error ? error.message : String(error), 'error');
      }
    });
  }

  lockPublishedEditor(form, post, section);
  rerenderAll();
}

function tryEnhanceVisibleEditor() {
  const form = document.querySelector('.modal-card #post-form');
  if (!form || form.dataset.v04Enhanced === '1' || !activePostId) return;
  enhancePostEditor(form, activePostId).catch((error) => {
    const errorBox = form.closest('.modal-card')?.querySelector('#post-error');
    if (errorBox) errorBox.textContent = `Не удалось загрузить редактор площадок: ${error instanceof Error ? error.message : String(error)}`;
  });
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const openButton = target?.closest('.open-post');
  if (openButton?.dataset.id) activePostId = openButton.dataset.id;
  if (target?.closest('#new-post')) activePostId = null;
}, true);

const observer = new MutationObserver(() => tryEnhanceVisibleEditor());
observer.observe(document.body, { childList: true, subtree: true });
tryEnhanceVisibleEditor();
