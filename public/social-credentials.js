export function socialCredentialFields(platform) {
  if (platform === 'telegram') return `
    <label class="full">Токен бота<input name="botToken" type="password" autocomplete="off" required placeholder="123456:ABC…"><span class="operator-field-help">Токен из BotFather. Он хранится зашифрованно.</span></label>
    <label class="full">Куда публиковать<input name="chatId" required placeholder="@my_channel или https://t.me/my_channel"><span class="operator-field-help">Укажите канал или чат. Бот должен иметь право публиковать туда.</span></label>`;
  if (platform === 'vk') return `
    <div class="full">
      <div>Куда публиковать?</div>
      <label class="target-check"><input type="radio" name="destinationKind" value="PERSONAL" checked> Личная страница</label>
      <label class="target-check"><input type="radio" name="destinationKind" value="COMMUNITY"> Сообщество</label>
    </div>
    <label class="full">Access token<input name="accessToken" type="password" autocomplete="off" required></label>
    <label class="full hidden" data-vk-community-field>Сообщество / ID<input name="groupId" placeholder="123456789, club123456789 или ссылка VK"></label>
    <div class="full muted small" data-vk-personal-hint>Личная страница определяется по владельцу access token через официальный VK API.</div>
    <label>API version<input name="apiVersion" required value="5.199"></label>`;
  if (platform === 'max') return `
    <label class="full">Токен бота<input name="accessToken" type="password" autocomplete="off" required></label>
    <label class="full">Куда публиковать<input name="chatId" required placeholder="ID чата / канала"></label>`;
  return `
    <label class="full">Access token<input name="accessToken" type="password" autocomplete="off" required></label>
    <label>Instagram User ID<input name="igUserId" required placeholder="Professional account ID"></label>
    <label>Graph API version<input name="graphVersion" required placeholder="vXX.X"></label>`;
}

export function syncVkDestinationFields(form) {
  const groupField = form.querySelector('[data-vk-community-field]');
  const groupInput = form.querySelector('input[name="groupId"]');
  const personalHint = form.querySelector('[data-vk-personal-hint]');
  if (!groupField || !groupInput) return () => undefined;

  const sync = () => {
    const kind = String(new FormData(form).get('destinationKind') || 'PERSONAL');
    const community = kind === 'COMMUNITY';
    groupField.classList.toggle('hidden', !community);
    groupInput.required = community;
    personalHint?.classList.toggle('hidden', community);
  };
  form.querySelectorAll('input[name="destinationKind"]').forEach((input) => input.addEventListener('change', sync));
  sync();
  return sync;
}

function telegramDestination(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^https?:\/\/t\.me\/([A-Za-z0-9_]+)\/?$/i);
  return match ? `@${match[1]}` : raw;
}

export function socialCredentialsFromForm(platform, form) {
  const data = new FormData(form);
  if (platform === 'telegram') {
    return {
      botToken: String(data.get('botToken') || '').trim(),
      chatId: telegramDestination(data.get('chatId'))
    };
  }
  if (platform === 'vk') {
    const destinationKind = String(data.get('destinationKind') || 'PERSONAL').trim().toUpperCase();
    const credentials = {
      accessToken: String(data.get('accessToken') || '').trim(),
      apiVersion: String(data.get('apiVersion') || '').trim() || '5.199',
      destinationKind
    };
    if (destinationKind === 'COMMUNITY') credentials.groupId = String(data.get('groupId') || '').trim();
    return credentials;
  }
  if (platform === 'max') {
    return {
      accessToken: String(data.get('accessToken') || '').trim(),
      chatId: String(data.get('chatId') || '').trim()
    };
  }
  return {
    accessToken: String(data.get('accessToken') || '').trim(),
    igUserId: String(data.get('igUserId') || '').trim(),
    graphVersion: String(data.get('graphVersion') || '').trim()
  };
}

export function verifiedSocialCredentialsFromTest(platform, form, checked) {
  const credentials = socialCredentialsFromForm(platform, form);
  if (platform !== 'vk') return credentials;

  const details = checked?.details || {};
  const requestedKind = String(credentials.destinationKind || '').toUpperCase();
  const checkedKind = String(details.destinationKind || '').toUpperCase();
  if (!['PERSONAL', 'COMMUNITY'].includes(checkedKind) || checkedKind !== requestedKind) {
    throw new Error('VK: проверенное назначение не совпадает с выбранным назначением');
  }

  const destinationId = String(details.destinationId || '').trim();
  if (!destinationId) throw new Error('VK: проверка не вернула ID назначения');

  const apiVersion = String(details.apiVersion || credentials.apiVersion || '5.199').trim();
  const verified = {
    accessToken: credentials.accessToken,
    apiVersion,
    destinationKind: checkedKind
  };
  if (checkedKind === 'PERSONAL') verified.userId = destinationId;
  else verified.groupId = destinationId;

  const destinationName = String(details.destinationName || '').trim();
  if (destinationName) verified.destinationName = destinationName;
  return verified;
}
