import type { Platform } from '../db.js';
import { PlatformError, requireString, responseJson } from './types.js';
import { normalizeVkCommunityId, normalizeVkUserId, vkCall, vkDestinationKind } from './vk.js';

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
  'VK: Этот токен является токеном сообщества. Для публикации обычных постов с изображениями нужен User access token VK.';

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
    throw error;
  }
}

async function vkTest(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const accessToken = requireString(credentials, 'accessToken');
  const apiVersion = vkApiVersion(credentials);
  const common = { access_token: accessToken, v: apiVersion };
  const kind = vkDestinationKind(credentials);

  const users = await vkUserOnlyCall('users.get', { ...common, fields: 'screen_name' });
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
