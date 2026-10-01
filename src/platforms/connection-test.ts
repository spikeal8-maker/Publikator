import type { Platform } from '../db.js';
import { PlatformError, requireString, responseJson } from './types.js';
import { normalizeVkCommunityId, normalizeVkUserId, vkCall, vkDestinationKind } from './vk.js';

export type VkMethodState = 'CONFIRMED' | 'DENIED' | 'UNAVAILABLE' | 'NOT_CHECKED' | 'NOT_IMPLEMENTED';

export type VkMethodCheck = {
  method: string;
  state: VkMethodState;
  reason: string;
};

export type VkTokenInspection = {
  valid: true;
  authKind: 'COMMUNITY' | 'USER';
  identity: string;
  permissions?: string[];
  groupId?: string;
  groupName?: string;
  groupScreenName?: string;
  userId?: string;
  userScreenName?: string;
  methods?: VkMethodCheck[];
};

export type ConnectionTestResult = {
  ok: true;
  platform: Platform;
  identity: string;
  destination: string;
  details?: Record<string, unknown>;
};

async function telegramTest(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const botToken = requireString(credentials, 'botToken');
  const chatId = requireString(credentials, 'chatId');
  const base = `https://api.telegram.org/bot${botToken}`;

  const meResponse = await fetch(`${base}/getMe`, { signal: AbortSignal.timeout(15000) });
  const me = await responseJson(meResponse, 'Telegram getMe');
  if (!me.ok || !me.result?.id) throw new Error(`Telegram: ${me.description || 'не удалось получить данные бота'}`);

  const chatParams = new URLSearchParams({ chat_id: chatId });
  const chatResponse = await fetch(`${base}/getChat?${chatParams}`, { signal: AbortSignal.timeout(15000) });
  const chat = await responseJson(chatResponse, 'Telegram getChat');
  if (!chat.ok) throw new Error(`Telegram: ${chat.description || 'канал недоступен'}`);

  const memberParams = new URLSearchParams({ chat_id: chatId, user_id: String(me.result.id) });
  const memberResponse = await fetch(`${base}/getChatMember?${memberParams}`, { signal: AbortSignal.timeout(15000) });
  const member = await responseJson(memberResponse, 'Telegram getChatMember');
  if (!member.ok) throw new Error(`Telegram: ${member.description || 'не удалось проверить права бота'}`);
  const status = String(member.result?.status || '');
  if (!['administrator','creator'].includes(status)) throw new Error('Telegram: бот должен быть администратором канала');
  if (member.result?.can_post_messages === false) throw new Error('Telegram: у бота нет права публиковать сообщения в канале');

  const identity = me.result.username ? `@${me.result.username}` : String(me.result.first_name || me.result.id);
  const destination = chat.result?.title || chat.result?.username || String(chat.result?.id || chatId);
  return { ok: true, platform: 'telegram', identity, destination, details: { status } };
}

async function maxTest(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const accessToken = requireString(credentials, 'accessToken');
  const chatId = requireString(credentials, 'chatId');
  const headers = { Authorization: accessToken };

  const meResponse = await fetch('https://platform-api2.max.ru/me', { headers, signal: AbortSignal.timeout(15000) });
  const me = await responseJson(meResponse, 'MAX GET /me');
  if (!me?.user_id) throw new Error('MAX: API не вернул идентификатор бота');

  const memberResponse = await fetch(`https://platform-api2.max.ru/chats/${encodeURIComponent(chatId)}/members/me`, { headers, signal: AbortSignal.timeout(15000) });
  const member = await responseJson(memberResponse, 'MAX GET /chats/{chatId}/members/me');
  const permissions = Array.isArray(member?.permissions) ? member.permissions.map(String) : [];
  if (!member?.is_owner && (!member?.is_admin || !permissions.includes('write'))) {
    throw new Error('MAX: бот должен быть администратором канала с правом write');
  }

  return {
    ok: true,
    platform: 'max',
    identity: me.username ? `@${me.username}` : String(me.first_name || me.user_id),
    destination: chatId,
    details: { isAdmin: Boolean(member?.is_admin), permissions }
  };
}

function vkApiVersion(credentials: Record<string, unknown>): string {
  return typeof credentials.apiVersion === 'string' && credentials.apiVersion.trim() ? credentials.apiVersion.trim() : '5.199';
}

function vkCommunityReference(credentials: Record<string, unknown>): string {
  let raw = requireString(credentials, 'groupId').trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).pathname.split('/').filter(Boolean)[0] || '';
    } catch {
      throw new Error('VK: некорректная ссылка сообщества');
    }
  }
  raw = raw.replace(/^@/, '');
  if (/^(?:-?\d+|(?:club|public|event)\d+)$/i.test(raw)) return normalizeVkCommunityId(raw);
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) throw new Error('VK: некорректный ID или короткое имя сообщества');
  return raw;
}

function vkGroupFromResponse(response: any): any {
  if (Array.isArray(response)) return response[0];
  if (Array.isArray(response?.groups)) return response.groups[0];
  if (Array.isArray(response?.items)) return response.items[0];
  return null;
}

function vkDisplayName(entity: any, fallback: string): string {
  const name = typeof entity?.name === 'string' ? entity.name.trim() : '';
  if (name) return name;
  const personalName = [entity?.first_name, entity?.last_name].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim();
  return personalName || fallback;
}

const VK_USER_TOKEN_REQUIRED =
  'VK: Этот токен является токеном сообщества. Для публикации обычных постов с изображениями нужен User access token VK. Используйте «Подключить через VK».';

function isVkIpBoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof PlatformError && Number(error.code) === 5
    && /another ip address|other ip address/i.test(message);
}

const VK_IP_BOUND_MESSAGE =
  'VK отклонил ключ: он привязан к другому IP-адресу. Ключ можно сохранить, но проверка с этого компьютера сейчас не пройдёт.';

function isVkGroupAuthorizationError(error: unknown): boolean {
  if (error instanceof PlatformError && Number(error.code) === 27) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Group authorization failed|method is unavailable with group auth/i.test(message);
}

async function vkUserOnlyCall(method: string, params: Record<string, string>): Promise<any> {
  try {
    return await vkCall(method, params);
  } catch (error) {
    if (isVkGroupAuthorizationError(error)) throw new Error(VK_USER_TOKEN_REQUIRED);
    if (isVkIpBoundError(error)) throw new Error(VK_IP_BOUND_MESSAGE);
    throw error;
  }
}

function vkMethodFailure(method: string, error: unknown): VkMethodCheck {
  const reason = error instanceof Error ? error.message : String(error);
  const platformUnavailable = error instanceof PlatformError
    && (error.retryable || error.outcomeUnknown || error.status === 408
      || (error.status !== undefined && error.status >= 500));
  const transportUnavailable = /timeout|timed out|aborted|fetch failed|network|ECONN|EAI_AGAIN|ENOTFOUND/i.test(reason);
  return {
    method,
    state: platformUnavailable || transportUnavailable ? 'UNAVAILABLE' : 'DENIED',
    reason
  };
}

function vkMethodConfirmed(method: string, reason: string): VkMethodCheck {
  return { method, state: 'CONFIRMED', reason };
}

function vkMethodNotChecked(method: string, reason: string): VkMethodCheck {
  return { method, state: 'NOT_CHECKED', reason };
}

function vkMethodNotImplemented(method: string, reason: string): VkMethodCheck {
  return { method, state: 'NOT_IMPLEMENTED', reason };
}

export async function inspectVkToken(credentials: Record<string, unknown>): Promise<VkTokenInspection> {
  const accessToken = requireString(credentials, 'accessToken');
  const common = { access_token: accessToken, v: vkApiVersion(credentials) };

  let groupProbeError: unknown;
  try {
    const permissions = await vkCall('groups.getTokenPermissions', common);
    if (permissions && typeof permissions === 'object') {
      const names = Array.isArray(permissions.permissions)
        ? permissions.permissions
          .map((permission: any) => String(permission?.name || '').trim())
          .filter(Boolean)
        : [];
      let group: any = null;
      const methods: VkMethodCheck[] = [
        vkMethodConfirmed('groups.getTokenPermissions', 'VK вернул permissions для ключа сообщества.')
      ];
      try {
        const reference = typeof credentials.groupId === 'string' && credentials.groupId.trim()
          ? vkCommunityReference(credentials)
          : '';
        const response = await vkCall('groups.getById', {
          ...common,
          ...(reference ? { group_id: reference } : {}),
          fields: 'screen_name'
        });
        group = vkGroupFromResponse(response);
        if (group?.id) {
          methods.push(vkMethodConfirmed(
            'groups.getById',
            'VK вернул данные группы. Это подтверждает чтение объекта, но не владение группой и не право публикации.'
          ));
        } else {
          methods.push({ method: 'groups.getById', state: 'DENIED', reason: 'VK не вернул группу.' });
        }
      } catch (error) {
        methods.push(vkMethodFailure('groups.getById', error));
      }
      const groupId = group?.id ? normalizeVkCommunityId(group.id) : undefined;
      const groupName = groupId ? vkDisplayName(group, `club${groupId}`) : undefined;
      const groupScreenName = typeof group?.screen_name === 'string' && group.screen_name.trim()
        ? group.screen_name.trim()
        : undefined;
      return {
        valid: true,
        authKind: 'COMMUNITY',
        identity: groupName || 'Ключ сообщества VK',
        permissions: names,
        methods,
        ...(groupId ? { groupId, groupName, groupScreenName } : {})
      };
    }
  } catch (error) {
    groupProbeError = error;
  }

  try {
    const users = await vkCall('users.get', { ...common, fields: 'screen_name' });
    const user = Array.isArray(users) ? users[0] : null;
    if (!user?.id) throw new Error('VK: не удалось определить владельца пользовательского ключа');
    const userId = normalizeVkUserId(user.id);
    return {
      valid: true,
      authKind: 'USER',
      identity: vkDisplayName(user, `id${userId}`),
      userId,
      userScreenName: typeof user.screen_name === 'string' && user.screen_name.trim()
        ? user.screen_name.trim()
        : `id${userId}`,
      methods: [vkMethodConfirmed('users.get', 'VK вернул владельца пользовательского ключа.')]
    };
  } catch (error) {
    if (isVkIpBoundError(error) || isVkIpBoundError(groupProbeError)) {
      throw new Error(VK_IP_BOUND_MESSAGE);
    }
    if (groupProbeError instanceof PlatformError && (groupProbeError.retryable || groupProbeError.outcomeUnknown)) {
      throw new Error('VK: проверка ключа временно недоступна. Повторите позже.');
    }
    if (error instanceof PlatformError && Number(error.code) === 5
      && groupProbeError instanceof PlatformError && Number(groupProbeError.code) === 5) {
      throw new Error('VK: ключ недействителен или срок его действия истёк.');
    }
    throw error;
  }
}

export async function checkVkConnection(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const apiVersion = vkApiVersion(credentials);
  const applicationLimits: VkMethodCheck[] = [
    vkMethodNotChecked('wall.post', 'Проверка подключения не создаёт реальную публикацию.'),
    vkMethodNotImplemented(
      'photos.getUploadServer / photos.save',
      'Альбомный upload-path из рабочего n8n в Publikator пока не реализован и этой проверкой не доказывается.'
    ),
    vkMethodNotImplemented(
      'stories.getPhotoUploadServer / stories.save',
      'Stories не реализованы в рамках KEY-02.'
    )
  ];

  try {
    const strict = await vkTest(credentials);
    const details = strict.details || {};
    const kind = String(details.destinationKind || vkDestinationKind(credentials));
    const methods: VkMethodCheck[] = [
      vkMethodConfirmed('users.get', 'VK вернул владельца пользовательского ключа.'),
      ...(kind === 'COMMUNITY'
        ? [vkMethodConfirmed(
          'groups.getById',
          'VK вернул публичные данные выбранной группы. Это не доказывает владение группой и не подтверждает право wall.post.'
        )]
        : []),
      vkMethodConfirmed('photos.getWallUploadServer', 'VK выдал upload_url для wall-photo path.'),
      ...applicationLimits
    ];
    return {
      ...strict,
      details: {
        ...details,
        keyValidity: 'CONFIRMED',
        permissions: [],
        permissionsSource: 'NOT_CONFIRMED_FOR_USER_KEY',
        destinationStatus: 'CONFIRMED',
        destinationOwnershipConfirmed: kind === 'PERSONAL',
        publishReady: true,
        methods
      }
    };
  } catch (strictError) {
    const inspection = await inspectVkToken(credentials);

    if (inspection.authKind === 'COMMUNITY') {
      const groupId = inspection.groupId;
      const screenName = inspection.groupScreenName || (groupId ? `club${groupId}` : '');
      return {
        ok: true,
        platform: 'vk',
        identity: inspection.identity,
        destination: screenName ? `https://vk.com/${screenName}` : (inspection.groupName || 'Сообщество не определено'),
        details: {
          apiVersion,
          keyValidity: 'CONFIRMED',
          authKind: 'COMMUNITY',
          permissions: inspection.permissions || [],
          permissionsSource: 'groups.getTokenPermissions',
          credentialOnly: true,
          destinationKind: 'COMMUNITY',
          destinationStatus: groupId ? 'RESOLVED' : 'NOT_CONFIRMED',
          ...(groupId ? { destinationId: groupId } : {}),
          ...(inspection.groupName ? { destinationName: inspection.groupName } : {}),
          ...(screenName ? { destinationScreenName: screenName } : {}),
          destinationOwnershipConfirmed: false,
          wallPhotoReady: false,
          wallUploadReady: false,
          wallPostNotExecuted: true,
          publishReady: false,
          methods: [
            ...(inspection.methods || []),
            vkMethodNotChecked(
              'photos.getWallUploadServer',
              'Ключ сообщества сохранён как ограниченный credential; текущий wall-photo preflight Publikator требует USER key.'
            ),
            ...applicationLimits
          ]
        }
      };
    }

    const authenticatedUserId = inspection.userId!;
    const authenticatedUserName = inspection.identity;
    const kind = vkDestinationKind(credentials);
    const common = { access_token: requireString(credentials, 'accessToken'), v: apiVersion };
    const methods: VkMethodCheck[] = [...(inspection.methods || [])];

    let destinationId = authenticatedUserId;
    let destinationName = authenticatedUserName;
    let destinationScreenName = inspection.userScreenName || `id${authenticatedUserId}`;
    let destinationStatus: VkMethodState = 'CONFIRMED';
    let destinationOwnershipConfirmed = true;

    if (kind === 'COMMUNITY') {
      destinationOwnershipConfirmed = false;
      try {
        const reference = vkCommunityReference(credentials);
        const groupResponse = await vkCall('groups.getById', { ...common, group_id: reference, fields: 'screen_name' });
        const group = vkGroupFromResponse(groupResponse);
        if (!group?.id) throw new Error('VK: сообщество не найдено или ответ не содержит ID');
        destinationId = normalizeVkCommunityId(group.id);
        destinationName = vkDisplayName(group, `club${destinationId}`);
        destinationScreenName = typeof group.screen_name === 'string' && group.screen_name.trim()
          ? group.screen_name.trim()
          : `club${destinationId}`;
        methods.push(vkMethodConfirmed(
          'groups.getById',
          'VK вернул публичные данные выбранной группы. Это не доказывает владение группой и не подтверждает право wall.post.'
        ));
      } catch (error) {
        const failed = vkMethodFailure('groups.getById', error);
        methods.push(failed);
        destinationStatus = failed.state;
        destinationId = '';
        destinationName = String(credentials.groupId || 'Сообщество не проверено');
        destinationScreenName = '';
      }
    }

    let wallPhotoReady = false;
    if (destinationStatus === 'CONFIRMED') {
      try {
        const server = await vkUserOnlyCall('photos.getWallUploadServer', {
          ...common,
          ...(kind === 'COMMUNITY' ? { group_id: destinationId } : {})
        });
        if (!server?.upload_url) throw new Error('VK: метод не вернул upload_url');
        wallPhotoReady = true;
        methods.push(vkMethodConfirmed('photos.getWallUploadServer', 'VK выдал upload_url для wall-photo path.'));
      } catch (error) {
        methods.push(vkMethodFailure('photos.getWallUploadServer', error));
      }
    } else {
      methods.push(vkMethodNotChecked(
        'photos.getWallUploadServer',
        'Метод не запускался, потому что выбранный адресат не был подтверждён.'
      ));
    }

    const destination = destinationScreenName ? `https://vk.com/${destinationScreenName}` : destinationName;
    const publishReady = wallPhotoReady && destinationStatus === 'CONFIRMED';
    return {
      ok: true,
      platform: 'vk',
      identity: kind === 'PERSONAL'
        ? `Личная страница · ${authenticatedUserName}`
        : `Сообщество · ${destinationName}`,
      destination,
      details: {
        apiVersion,
        keyValidity: 'CONFIRMED',
        authKind: 'USER',
        permissions: [],
        permissionsSource: 'NOT_CONFIRMED_FOR_USER_KEY',
        authenticatedUserId,
        authenticatedUserName,
        destinationKind: kind,
        destinationStatus,
        ...(destinationId ? { destinationId } : {}),
        destinationName,
        ...(destinationScreenName ? { destinationScreenName } : {}),
        destinationOwnershipConfirmed,
        wallPhotoReady,
        wallUploadReady: wallPhotoReady,
        wallPostNotExecuted: true,
        publishReady,
        initialPreflightError: strictError instanceof Error ? strictError.message : String(strictError),
        methods: [...methods, ...applicationLimits]
      }
    };
  }
}

async function vkTest(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const accessToken = requireString(credentials, 'accessToken');
  const apiVersion = vkApiVersion(credentials);
  const common = { access_token: accessToken, v: apiVersion };
  const kind = vkDestinationKind(credentials);

  let users: any;
  try {
    users = await vkUserOnlyCall('users.get', { ...common, fields: 'screen_name' });
  } catch (error) {
    if (error instanceof Error && error.message === VK_USER_TOKEN_REQUIRED) throw error;
    // users.get accepts group tokens in VK's schema, so its failure alone
    // cannot classify the token. This group-only method can.
    let communityToken = false;
    try {
      const permissions = await vkCall('groups.getTokenPermissions', common);
      communityToken = Boolean(permissions);
    } catch {
      // Preserve the original VK error for invalid/expired keys or outages.
    }
    if (communityToken) throw new Error(VK_USER_TOKEN_REQUIRED);
    throw error;
  }
  const authenticatedUser = Array.isArray(users) ? users[0] : null;
  if (!authenticatedUser?.id) throw new Error('VK: users.get не вернул владельца User access token');
  const authenticatedUserId = normalizeVkUserId(authenticatedUser.id);
  const authenticatedUserName = vkDisplayName(authenticatedUser, `id${authenticatedUserId}`);

  if (kind === 'PERSONAL') {
    if (credentials.userId !== undefined && credentials.userId !== null && String(credentials.userId).trim()) {
      const configuredUserId = normalizeVkUserId(credentials.userId);
      if (configuredUserId !== authenticatedUserId) {
        throw new Error(`VK: access token принадлежит id${authenticatedUserId}, а подключение настроено на id${configuredUserId}`);
      }
    }
    const server = await vkUserOnlyCall('photos.getWallUploadServer', common);
    if (!server?.upload_url) throw new Error('VK: токен не дал upload_url для личной стены');
    const screenName = typeof authenticatedUser.screen_name === 'string' && authenticatedUser.screen_name.trim()
      ? authenticatedUser.screen_name.trim()
      : `id${authenticatedUserId}`;
    return {
      ok: true,
      platform: 'vk',
      identity: `Личная страница · ${authenticatedUserName}`,
      destination: `https://vk.com/${screenName}`,
      details: {
        apiVersion,
        authKind: 'USER',
        authenticatedUserId,
        authenticatedUserName,
        destinationKind: 'PERSONAL',
        destinationId: authenticatedUserId,
        destinationName: authenticatedUserName,
        destinationScreenName: screenName,
        wallPhotoReady: true,
        wallUploadReady: true,
        wallPostNotExecuted: true
      }
    };
  }

  const reference = vkCommunityReference(credentials);
  const groupResponse = await vkCall('groups.getById', { ...common, group_id: reference, fields: 'screen_name' });
  const group = vkGroupFromResponse(groupResponse);
  if (!group?.id) throw new Error('VK: сообщество не найдено или токен не имеет к нему доступа');
  const groupId = normalizeVkCommunityId(group.id);
  const server = await vkUserOnlyCall('photos.getWallUploadServer', { ...common, group_id: groupId });
  if (!server?.upload_url) throw new Error('VK: токен не дал upload_url для стены сообщества');
  const name = vkDisplayName(group, `club${groupId}`);
  const screenName = typeof group.screen_name === 'string' && group.screen_name.trim() ? group.screen_name.trim() : `club${groupId}`;
  return {
    ok: true,
    platform: 'vk',
    identity: `Сообщество · ${name}`,
    destination: `https://vk.com/${screenName}`,
    details: {
      apiVersion,
      authKind: 'USER',
      authenticatedUserId,
      authenticatedUserName,
      destinationKind: 'COMMUNITY',
      destinationId: groupId,
      destinationName: name,
      destinationScreenName: screenName,
      wallPhotoReady: true,
      wallUploadReady: true,
      wallPostNotExecuted: true
    }
  };
}

async function instagramTest(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const accessToken = requireString(credentials, 'accessToken');
  const igUserId = requireString(credentials, 'igUserId');
  const graphVersion = requireString(credentials, 'graphVersion');
  const params = new URLSearchParams({ fields: 'id,username', access_token: accessToken });
  const response = await fetch(`https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(igUserId)}?${params}`, { signal: AbortSignal.timeout(15000) });
  const body = await responseJson(response, 'Instagram account check');
  if (!body?.id) throw new Error('Instagram: аккаунт не найден или токен не имеет доступа');
  return {
    ok: true,
    platform: 'instagram',
    identity: body.username ? `@${body.username}` : String(body.id),
    destination: String(body.id),
    details: { graphVersion }
  };
}

export async function testConnection(platform: Platform, credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  if (platform === 'telegram') return telegramTest(credentials);
  if (platform === 'max') return maxTest(credentials);
  if (platform === 'vk') return vkTest(credentials);
  return instagramTest(credentials);
}
