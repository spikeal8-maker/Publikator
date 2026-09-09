import type { Platform } from '../db.js';
import { requireString, responseJson } from './types.js';
import { vkCall } from './vk.js';

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

async function vkTest(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
  const accessToken = requireString(credentials, 'accessToken');
  const groupId = requireString(credentials, 'groupId').replace(/^-/, '');
  const apiVersion = typeof credentials.apiVersion === 'string' && credentials.apiVersion.trim() ? credentials.apiVersion.trim() : '5.199';
  const server = await vkCall('photos.getWallUploadServer', { access_token: accessToken, v: apiVersion, group_id: groupId });
  if (!server?.upload_url) throw new Error('VK: токен не дал upload_url для стены сообщества');
  return {
    ok: true,
    platform: 'vk',
    identity: `group ${groupId}`,
    destination: `https://vk.com/club${groupId}`,
    details: { apiVersion, wallUploadReady: true }
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
