import { maxFetch } from './max-transport.js';
import { config } from '../config.js';
import type { Platform } from '../db.js';
import {
  sanitizeCapabilityText,
  type CapabilityDestinationEvidence,
  type CapabilityMethodEvidence,
  type CapabilityRemediation,
  type ProviderPublicationEvidence,
  type PublicationFormat,
  type RuntimePrerequisiteEvidence
} from '../social-credential-capability.js';
import { checkVkPhotoUploadAccess, normalizeVkCommunityId, normalizeVkUserId, vkCall, vkDestinationKind } from './vk.js';
import { PlatformError, requireString } from './types.js';

export type InspectionCredentialValidity = 'CONFIRMED' | 'INVALID' | 'UNAVAILABLE' | 'UNKNOWN';

export type InspectionCredentialEvidence = {
  validity: InspectionCredentialValidity;
  providerType: string;
  identity: string | null;
  ownerId: string | null;
  expiresAt: string | null;
  declaredPermissions: string[];
  permissionsSource: string | null;
};

export type CredentialInspectionResult = {
  platform: Platform;
  credential: InspectionCredentialEvidence;
  destination: CapabilityDestinationEvidence | null;
  methods: CapabilityMethodEvidence[];
  publicationEvidence: Partial<Record<PublicationFormat, ProviderPublicationEvidence>>;
  runtimePrerequisiteEvidence: RuntimePrerequisiteEvidence[];
  remediation: CapabilityRemediation[];
  warnings: string[];
};

type JsonProbe =
  | { kind: 'response'; status: number; body: any }
  | { kind: 'unavailable'; machineCode: string; reason: string };

type VkProbeFailure = {
  state: CapabilityMethodEvidence['state'];
  machineCode: string;
  reason: string;
  unavailable: boolean;
};

const REQUEST_TIMEOUT_MS = 15_000;

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeText(value: unknown, maxLength = 1000): string {
  return sanitizeCapabilityText(value, maxLength);
}

function safeNullable(value: unknown, maxLength = 512): string | null {
  const text = safeText(value, maxLength);
  return text || null;
}

function nestedErrorCode(error: unknown): string {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if (seen.has(current as object)) break;
    seen.add(current as object);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase();
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

function transportFailure(error: unknown): { machineCode: string; reason: string } {
  if (error instanceof PlatformError) {
    if (error.code !== undefined && error.code !== null) {
      return { machineCode: `PROVIDER_${String(error.code).toUpperCase()}`, reason: safeText(error.message) };
    }
    if (error.status !== undefined) {
      return { machineCode: `HTTP_${error.status}`, reason: safeText(error.message) };
    }
  }
  const code = nestedErrorCode(error);
  if (code) return { machineCode: `NETWORK_${code}`, reason: safeText(error instanceof Error ? error.message : error) };
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { machineCode: 'NETWORK_TIMEOUT', reason: safeText(error instanceof Error ? error.message : error) };
  }
  if (error instanceof TypeError) {
    return { machineCode: 'NETWORK_ERROR', reason: safeText(error.message) };
  }
  return { machineCode: 'NETWORK_UNAVAILABLE', reason: safeText(error instanceof Error ? error.message : error) };
}

function isUnavailablePlatformError(error: unknown): boolean {
  if (error instanceof PlatformError) {
    return error.retryable || error.outcomeUnknown || error.status === 408 || error.status === 425
      || error.status === 429 || (error.status !== undefined && error.status >= 500);
  }
  const code = nestedErrorCode(error);
  if (['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(code)) return true;
  if (error instanceof TypeError) return true;
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

async function jsonProbe(url: string, init: RequestInit = {}): Promise<JsonProbe> {
  try {
    const fetchImpl = new URL(url).origin === 'https://platform-api2.max.ru' ? maxFetch : globalThis.fetch;
    const response = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    return { kind: 'response', status: response.status, body };
  } catch (error) {
    const failure = transportFailure(error);
    return { kind: 'unavailable', ...failure };
  }
}

function method(
  methodName: string,
  state: CapabilityMethodEvidence['state'],
  reason: string,
  evidenceSource: string,
  machineCode: string | null = null
): CapabilityMethodEvidence {
  return {
    method: methodName,
    state,
    reason: safeText(reason),
    evidenceSource,
    machineCode: machineCode ? safeText(machineCode, 128) : null
  };
}

function remediation(
  code: string,
  title: string,
  explanation: string,
  options: {
    requiredCredentialType?: string | null;
    requiredPermissions?: string[];
    steps?: string[];
  } = {}
): CapabilityRemediation {
  return {
    code,
    title: safeText(title, 512),
    explanation: safeText(explanation, 1200),
    requiredCredentialType: options.requiredCredentialType ?? null,
    requiredPermissions: [...new Set(options.requiredPermissions ?? [])].sort(stableCompare),
    steps: (options.steps ?? []).map((step) => safeText(step, 1000)),
    primaryAction: { label: 'Проверить снова', kind: 'RECHECK', target: null },
    secondaryActions: []
  };
}

function publication(
  state: ProviderPublicationEvidence['state'],
  options: { requiredMethods?: string[]; remediationCodes?: string[]; reason?: string } = {}
): ProviderPublicationEvidence {
  return {
    state,
    requiredMethods: [...new Set(options.requiredMethods ?? [])].sort(stableCompare),
    remediationCodes: [...new Set(options.remediationCodes ?? [])].sort(stableCompare),
    reason: safeText(options.reason ?? '', 1000)
  };
}

function unavailablePublications(reason: string, code: string): Partial<Record<PublicationFormat, ProviderPublicationEvidence>> {
  return {
    TEXT: publication('UNAVAILABLE', { remediationCodes: [code], reason }),
    IMAGE: publication('UNAVAILABLE', { remediationCodes: [code], reason }),
    CAROUSEL: publication('UNAVAILABLE', { remediationCodes: [code], reason })
  };
}

function unknownDestination(): CapabilityDestinationEvidence {
  return {
    resolutionState: 'UNKNOWN',
    kind: null,
    id: null,
    name: null,
    role: null,
    ownershipConfirmed: null
  };
}

function unavailableDestination(): CapabilityDestinationEvidence {
  return {
    resolutionState: 'UNAVAILABLE',
    kind: null,
    id: null,
    name: null,
    role: null,
    ownershipConfirmed: null
  };
}

function rightsMethod(prefix: string, name: string, value: unknown): CapabilityMethodEvidence {
  if (value === true) return method(`${prefix}.${name}`, 'CONFIRMED', `${name}=true`, prefix, 'TRUE');
  if (value === false) return method(`${prefix}.${name}`, 'DENIED', `${name}=false`, prefix, 'FALSE');
  return method(`${prefix}.${name}`, 'NOT_CHECKED', `${name} не возвращён провайдером`, prefix, 'NOT_RETURNED');
}

async function inspectTelegram(credentials: Record<string, unknown>): Promise<CredentialInspectionResult> {
  const botToken = requireString(credentials, 'botToken');
  const chatId = requireString(credentials, 'chatId');
  const base = `https://api.telegram.org/bot${botToken}`;
  const methods: CapabilityMethodEvidence[] = [];
  const remediationRows: CapabilityRemediation[] = [];

  const meProbe = await jsonProbe(`${base}/getMe`);
  if (meProbe.kind === 'unavailable') {
    methods.push(method('telegram.getMe', 'UNAVAILABLE', meProbe.reason, 'telegram', meProbe.machineCode));
    return {
      platform: 'telegram',
      credential: {
        validity: 'UNAVAILABLE',
        providerType: 'BOT',
        identity: null,
        ownerId: null,
        expiresAt: null,
        declaredPermissions: [],
        permissionsSource: null
      },
      destination: unavailableDestination(),
      methods,
      publicationEvidence: unavailablePublications(meProbe.reason, meProbe.machineCode),
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings: []
    };
  }

  const me = meProbe.body;
  if (meProbe.status === 401 || meProbe.status === 404 || me?.error_code === 401 || me?.error_code === 404) {
    const reason = safeText(me?.description || `Telegram getMe rejected token (HTTP ${meProbe.status})`);
    methods.push(method('telegram.getMe', 'DENIED', reason, 'telegram', `TELEGRAM_${me?.error_code || meProbe.status}`));
    return {
      platform: 'telegram',
      credential: {
        validity: 'INVALID',
        providerType: 'BOT',
        identity: null,
        ownerId: null,
        expiresAt: null,
        declaredPermissions: [],
        permissionsSource: null
      },
      destination: unknownDestination(),
      methods,
      publicationEvidence: {},
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings: []
    };
  }
  if (meProbe.status >= 500 || meProbe.status === 429) {
    const reason = safeText(me?.description || `Telegram getMe HTTP ${meProbe.status}`);
    methods.push(method('telegram.getMe', 'UNAVAILABLE', reason, 'telegram', `HTTP_${meProbe.status}`));
    return {
      platform: 'telegram',
      credential: {
        validity: 'UNAVAILABLE', providerType: 'BOT', identity: null, ownerId: null,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: unavailableDestination(),
      methods,
      publicationEvidence: unavailablePublications(reason, `HTTP_${meProbe.status}`),
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings: []
    };
  }
  if (!me?.ok || !me?.result?.id) {
    const reason = safeText(me?.description || 'Telegram getMe did not confirm bot identity');
    methods.push(method('telegram.getMe', 'DENIED', reason, 'telegram', 'TELEGRAM_IDENTITY_NOT_CONFIRMED'));
    return {
      platform: 'telegram',
      credential: {
        validity: 'UNKNOWN', providerType: 'BOT', identity: null, ownerId: null,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: unknownDestination(),
      methods,
      publicationEvidence: {},
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings: []
    };
  }

  const botId = String(me.result.id);
  const identity = me.result.username ? `@${safeText(me.result.username, 256)}`
    : safeText(me.result.first_name || botId, 256);
  methods.push(method('telegram.getMe', 'CONFIRMED', 'Telegram подтвердил bot token и identity.', 'telegram', 'BOT_IDENTITY_CONFIRMED'));

  const chatParams = new URLSearchParams({ chat_id: chatId });
  const chatProbe = await jsonProbe(`${base}/getChat?${chatParams}`);
  if (chatProbe.kind === 'unavailable' || chatProbe.status >= 500 || chatProbe.status === 429) {
    const reason = chatProbe.kind === 'unavailable'
      ? chatProbe.reason
      : safeText(chatProbe.body?.description || `Telegram getChat HTTP ${chatProbe.status}`);
    const code = chatProbe.kind === 'unavailable' ? chatProbe.machineCode : `HTTP_${chatProbe.status}`;
    methods.push(method('telegram.getChat', 'UNAVAILABLE', reason, 'telegram', code));
    return {
      platform: 'telegram',
      credential: {
        validity: 'CONFIRMED', providerType: 'BOT', identity, ownerId: botId,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: unavailableDestination(),
      methods,
      publicationEvidence: unavailablePublications(reason, code),
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings: []
    };
  }
  const chat = chatProbe.body;
  if (!chat?.ok || !chat?.result?.id) {
    const reason = safeText(chat?.description || 'Telegram destination is not accessible');
    methods.push(method('telegram.getChat', 'DENIED', reason, 'telegram', `TELEGRAM_${chat?.error_code || chatProbe.status || 'DESTINATION_DENIED'}`));
    const code = 'TELEGRAM_DESTINATION_ACCESS_REQUIRED';
    remediationRows.push(remediation(code, 'Канал или чат недоступен', 'Проверьте chatId и доступ бота к выбранному чату.'));
    return {
      platform: 'telegram',
      credential: {
        validity: 'CONFIRMED', providerType: 'BOT', identity, ownerId: botId,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: {
        resolutionState: 'DENIED', kind: 'CHAT', id: chatId, name: chatId,
        role: null, ownershipConfirmed: null
      },
      methods,
      publicationEvidence: {
        TEXT: publication('SETUP_REQUIRED', { remediationCodes: [code], reason }),
        IMAGE: publication('SETUP_REQUIRED', { remediationCodes: [code], reason }),
        CAROUSEL: publication('SETUP_REQUIRED', { remediationCodes: [code], reason })
      },
      runtimePrerequisiteEvidence: [],
      remediation: remediationRows,
      warnings: []
    };
  }

  const destinationName = safeText(chat.result.title || chat.result.username || chat.result.id, 512);
  const destinationId = String(chat.result.id);
  methods.push(method('telegram.getChat', 'CONFIRMED', 'Telegram подтвердил выбранный destination.', 'telegram', 'DESTINATION_CONFIRMED'));

  const memberParams = new URLSearchParams({ chat_id: chatId, user_id: botId });
  const memberProbe = await jsonProbe(`${base}/getChatMember?${memberParams}`);
  if (memberProbe.kind === 'unavailable' || memberProbe.status >= 500 || memberProbe.status === 429) {
    const reason = memberProbe.kind === 'unavailable'
      ? memberProbe.reason
      : safeText(memberProbe.body?.description || `Telegram getChatMember HTTP ${memberProbe.status}`);
    const code = memberProbe.kind === 'unavailable' ? memberProbe.machineCode : `HTTP_${memberProbe.status}`;
    methods.push(method('telegram.getChatMember', 'UNAVAILABLE', reason, 'telegram', code));
    return {
      platform: 'telegram',
      credential: {
        validity: 'CONFIRMED', providerType: 'BOT', identity, ownerId: botId,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: {
        resolutionState: 'CONFIRMED', kind: 'CHAT', id: destinationId, name: destinationName,
        role: null, ownershipConfirmed: null
      },
      methods,
      publicationEvidence: unavailablePublications(reason, code),
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings: []
    };
  }

  const member = memberProbe.body;
  if (!member?.ok || !member?.result) {
    const reason = safeText(member?.description || 'Telegram membership/rights could not be confirmed');
    methods.push(method('telegram.getChatMember', 'DENIED', reason, 'telegram', `TELEGRAM_${member?.error_code || memberProbe.status || 'MEMBERSHIP_DENIED'}`));
    const code = 'TELEGRAM_ADMIN_REQUIRED';
    remediationRows.push(remediation(code, 'Нужны права администратора', 'Добавьте бота в выбранный канал/чат и выдайте права публикации.'));
    return {
      platform: 'telegram',
      credential: {
        validity: 'CONFIRMED', providerType: 'BOT', identity, ownerId: botId,
        expiresAt: null, declaredPermissions: [], permissionsSource: 'getChatMember'
      },
      destination: {
        resolutionState: 'CONFIRMED', kind: 'CHAT', id: destinationId, name: destinationName,
        role: null, ownershipConfirmed: null
      },
      methods,
      publicationEvidence: {
        TEXT: publication('SETUP_REQUIRED', { remediationCodes: [code], reason }),
        IMAGE: publication('SETUP_REQUIRED', { remediationCodes: [code], reason }),
        CAROUSEL: publication('SETUP_REQUIRED', { remediationCodes: [code], reason })
      },
      runtimePrerequisiteEvidence: [],
      remediation: remediationRows,
      warnings: []
    };
  }

  const status = String(member.result.status || '');
  const isAdmin = status === 'administrator' || status === 'creator';
  const canPost = isAdmin && member.result.can_post_messages !== false;
  methods.push(method(
    'telegram.getChatMember',
    'CONFIRMED',
    `Telegram membership status: ${status || 'unknown'}`,
    'telegram',
    status ? `STATUS_${status.toUpperCase()}` : 'STATUS_UNKNOWN'
  ));

  const granularRights = [
    'can_post_messages', 'can_edit_messages', 'can_delete_messages',
    'can_post_stories', 'can_edit_stories', 'can_delete_stories'
  ] as const;
  for (const right of granularRights) methods.push(rightsMethod('telegram', right, member.result[right]));

  const declaredPermissions = granularRights
    .filter((right) => member.result[right] === true)
    .map(String)
    .sort(stableCompare);

  if (!canPost) {
    const code = 'TELEGRAM_CAN_POST_MESSAGES_REQUIRED';
    remediationRows.push(remediation(
      code,
      'Бот не может публиковать',
      'Сделайте бота администратором и разрешите публикацию сообщений.',
      { requiredPermissions: ['can_post_messages'] }
    ));
  }

  const publicationEvidence: Partial<Record<PublicationFormat, ProviderPublicationEvidence>> = {
    TEXT: canPost
      ? publication('CONFIRMED', { requiredMethods: ['sendMessage'] })
      : publication('SETUP_REQUIRED', { remediationCodes: ['TELEGRAM_CAN_POST_MESSAGES_REQUIRED'] }),
    IMAGE: canPost
      ? publication('CONFIRMED', { requiredMethods: ['sendPhoto'] })
      : publication('SETUP_REQUIRED', { remediationCodes: ['TELEGRAM_CAN_POST_MESSAGES_REQUIRED'] }),
    CAROUSEL: canPost
      ? publication('CONFIRMED', { requiredMethods: ['sendMediaGroup'] })
      : publication('SETUP_REQUIRED', { remediationCodes: ['TELEGRAM_CAN_POST_MESSAGES_REQUIRED'] }),
    VIDEO: publication('UNKNOWN', { reason: 'Video publishing was not probed during credential inspection.' }),
    SHORT: publication('UNKNOWN', { reason: 'Short-video publishing is not proven by this inspection.' }),
    STORY: member.result.can_post_stories === true
      ? publication('CONFIRMED', { requiredMethods: ['story publication rights'] })
      : member.result.can_post_stories === false
        ? publication('DENIED', { remediationCodes: ['TELEGRAM_CAN_POST_STORIES_REQUIRED'] })
        : publication('UNKNOWN', { reason: 'Telegram did not return can_post_stories.' })
  };

  return {
    platform: 'telegram',
    credential: {
      validity: 'CONFIRMED',
      providerType: 'BOT',
      identity,
      ownerId: botId,
      expiresAt: null,
      declaredPermissions,
      permissionsSource: 'getChatMember'
    },
    destination: {
      resolutionState: 'CONFIRMED',
      kind: String(chat.result.type || 'CHAT').toUpperCase(),
      id: destinationId,
      name: destinationName,
      role: status || null,
      ownershipConfirmed: status === 'creator' ? true : null
    },
    methods,
    publicationEvidence,
    runtimePrerequisiteEvidence: [],
    remediation: remediationRows,
    warnings: []
  };
}

async function inspectMax(credentials: Record<string, unknown>): Promise<CredentialInspectionResult> {
  const accessToken = requireString(credentials, 'accessToken');
  const chatId = requireString(credentials, 'chatId');
  const headers = { Authorization: accessToken };
  const methods: CapabilityMethodEvidence[] = [];
  const remediationRows: CapabilityRemediation[] = [];

  const meProbe = await jsonProbe('https://platform-api2.max.ru/me', { headers });
  if (meProbe.kind === 'unavailable' || meProbe.status >= 500 || meProbe.status === 429) {
    const reason = meProbe.kind === 'unavailable'
      ? meProbe.reason
      : safeText(meProbe.body?.message || `MAX /me HTTP ${meProbe.status}`);
    const code = meProbe.kind === 'unavailable' ? meProbe.machineCode : `HTTP_${meProbe.status}`;
    methods.push(method('max.GET /me', 'UNAVAILABLE', reason, 'max', code));
    return {
      platform: 'max',
      credential: {
        validity: 'UNAVAILABLE', providerType: 'BOT', identity: null, ownerId: null,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: unavailableDestination(),
      methods,
      publicationEvidence: unavailablePublications(reason, code),
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings: []
    };
  }
  if ([401, 403].includes(meProbe.status)) {
    const reason = safeText(meProbe.body?.message || `MAX /me HTTP ${meProbe.status}`);
    methods.push(method('max.GET /me', 'DENIED', reason, 'max', `HTTP_${meProbe.status}`));
    return {
      platform: 'max',
      credential: {
        validity: 'INVALID', providerType: 'BOT', identity: null, ownerId: null,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: unknownDestination(),
      methods,
      publicationEvidence: {},
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings: []
    };
  }

  const me = meProbe.body;
  if (!me?.user_id) {
    methods.push(method('max.GET /me', 'DENIED', 'MAX did not confirm bot identity.', 'max', 'MAX_IDENTITY_NOT_CONFIRMED'));
    return {
      platform: 'max',
      credential: {
        validity: 'UNKNOWN', providerType: 'BOT', identity: null, ownerId: null,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: unknownDestination(),
      methods,
      publicationEvidence: {},
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings: []
    };
  }

  const ownerId = String(me.user_id);
  const identity = me.username ? `@${safeText(me.username, 256)}` : safeText(me.first_name || ownerId, 256);
  methods.push(method('max.GET /me', 'CONFIRMED', 'MAX подтвердил token и identity.', 'max', 'BOT_IDENTITY_CONFIRMED'));

  const memberProbe = await jsonProbe(
    `https://platform-api2.max.ru/chats/${encodeURIComponent(chatId)}/members/me`,
    { headers }
  );
  if (memberProbe.kind === 'unavailable' || memberProbe.status >= 500 || memberProbe.status === 429) {
    const reason = memberProbe.kind === 'unavailable'
      ? memberProbe.reason
      : safeText(memberProbe.body?.message || `MAX membership HTTP ${memberProbe.status}`);
    const code = memberProbe.kind === 'unavailable' ? memberProbe.machineCode : `HTTP_${memberProbe.status}`;
    methods.push(method('max.GET /chats/{chatId}/members/me', 'UNAVAILABLE', reason, 'max', code));
    return {
      platform: 'max',
      credential: {
        validity: 'CONFIRMED', providerType: 'BOT', identity, ownerId,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: {
        resolutionState: 'UNAVAILABLE', kind: 'CHAT', id: chatId, name: chatId,
        role: null, ownershipConfirmed: null
      },
      methods,
      publicationEvidence: unavailablePublications(reason, code),
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings: []
    };
  }
  if ([401, 403, 404].includes(memberProbe.status)) {
    const reason = safeText(memberProbe.body?.message || `MAX destination HTTP ${memberProbe.status}`);
    const code = 'MAX_DESTINATION_ACCESS_REQUIRED';
    methods.push(method('max.GET /chats/{chatId}/members/me', 'DENIED', reason, 'max', `HTTP_${memberProbe.status}`));
    remediationRows.push(remediation(code, 'Нет доступа к выбранному чату', 'Добавьте бота в чат/канал и выдайте необходимые права.'));
    return {
      platform: 'max',
      credential: {
        validity: 'CONFIRMED', providerType: 'BOT', identity, ownerId,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: {
        resolutionState: 'DENIED', kind: 'CHAT', id: chatId, name: chatId,
        role: null, ownershipConfirmed: null
      },
      methods,
      publicationEvidence: {
        TEXT: publication('SETUP_REQUIRED', { remediationCodes: [code], reason }),
        IMAGE: publication('SETUP_REQUIRED', { remediationCodes: [code], reason }),
        CAROUSEL: publication('SETUP_REQUIRED', { remediationCodes: [code], reason })
      },
      runtimePrerequisiteEvidence: [],
      remediation: remediationRows,
      warnings: []
    };
  }

  const member = memberProbe.body;
  const permissions: string[] = Array.isArray(member?.permissions)
    ? [...new Set<string>(member.permissions
      .map((item: unknown) => safeText(item, 128))
      .filter((item: string) => Boolean(item)))].sort(stableCompare)
    : [];
  const isOwner = Boolean(member?.is_owner);
  const isAdmin = Boolean(member?.is_admin);
  const canWrite = isOwner || (isAdmin && permissions.includes('write'));
  methods.push(method(
    'max.GET /chats/{chatId}/members/me',
    'CONFIRMED',
    'MAX подтвердил membership и permissions.',
    'max',
    isOwner ? 'OWNER' : isAdmin ? 'ADMIN' : 'MEMBER'
  ));
  for (const permission of permissions) {
    methods.push(method(`max.permission.${permission}`, 'CONFIRMED', `${permission}=true`, 'max', 'TRUE'));
  }
  if (isOwner && !permissions.includes('write')) {
    methods.push(method('max.permission.write', 'CONFIRMED', 'Владелец чата имеет write-доступ независимо от массива permissions.', 'max', 'OWNER_PRIVILEGE'));
  } else if (!canWrite) {
    methods.push(method('max.permission.write', 'DENIED', 'write отсутствует в permissions.', 'max', 'FALSE'));
  }

  if (!canWrite) {
    const code = 'MAX_WRITE_REQUIRED';
    remediationRows.push(remediation(
      code,
      'Нужно право write',
      'Сделайте бота администратором выбранного чата/канала и выдайте permission write.',
      { requiredPermissions: ['write'] }
    ));
  }

  const feedEvidence = canWrite
    ? publication('CONFIRMED', { requiredMethods: ['POST /messages'] })
    : publication('SETUP_REQUIRED', { remediationCodes: ['MAX_WRITE_REQUIRED'] });

  return {
    platform: 'max',
    credential: {
      validity: 'CONFIRMED',
      providerType: 'BOT',
      identity,
      ownerId,
      expiresAt: null,
      declaredPermissions: permissions,
      permissionsSource: 'GET /chats/{chatId}/members/me'
    },
    destination: {
      resolutionState: 'CONFIRMED',
      kind: 'CHAT',
      id: chatId,
      name: chatId,
      role: isOwner ? 'owner' : isAdmin ? 'admin' : 'member',
      ownershipConfirmed: isOwner
    },
    methods,
    publicationEvidence: {
      TEXT: feedEvidence,
      IMAGE: feedEvidence,
      CAROUSEL: feedEvidence,
      VIDEO: publication('UNKNOWN', { reason: 'Video publishing was not probed during credential inspection.' }),
      SHORT: publication('UNKNOWN'),
      STORY: publication('UNKNOWN')
    },
    runtimePrerequisiteEvidence: [],
    remediation: remediationRows,
    warnings: []
  };
}

function vkApiVersion(credentials: Record<string, unknown>): string {
  return typeof credentials.apiVersion === 'string' && credentials.apiVersion.trim()
    ? credentials.apiVersion.trim()
    : '5.199';
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
  if (name) return safeText(name, 512);
  const personal = [entity?.first_name, entity?.last_name]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' ').trim();
  return safeText(personal || fallback, 512);
}

function vkMachineCode(error: unknown): string {
  if (error instanceof PlatformError) {
    if (error.code !== undefined && error.code !== null) return `VK_${String(error.code).toUpperCase()}`;
    if (error.status !== undefined) return `HTTP_${error.status}`;
  }
  return transportFailure(error).machineCode;
}

function vkFailure(methodName: string, error: unknown): VkProbeFailure {
  const unavailable = isUnavailablePlatformError(error);
  return {
    state: unavailable ? 'UNAVAILABLE' : 'DENIED',
    machineCode: vkMachineCode(error),
    reason: safeText(error instanceof Error ? error.message : error),
    unavailable
  };
}

function vkMethodFromFailure(methodName: string, error: unknown): CapabilityMethodEvidence {
  const failed = vkFailure(methodName, error);
  return method(methodName, failed.state, failed.reason, 'vk', failed.machineCode);
}

function vkCommon(credentials: Record<string, unknown>): Record<string, string> {
  return {
    access_token: requireString(credentials, 'accessToken'),
    v: vkApiVersion(credentials)
  };
}

async function inspectVk(credentials: Record<string, unknown>): Promise<CredentialInspectionResult> {
  const common = vkCommon(credentials);
  const methods: CapabilityMethodEvidence[] = [];
  const remediationRows: CapabilityRemediation[] = [];
  const warnings: string[] = [];
  let providerType = 'UNKNOWN';
  let validity: InspectionCredentialValidity = 'UNKNOWN';
  let identity: string | null = null;
  let ownerId: string | null = null;
  let declaredPermissions: string[] = [];
  let permissionsSource: string | null = null;

  let groupProbeError: unknown = null;
  try {
    const permissions = await vkCall('groups.getTokenPermissions', common);
    providerType = 'GROUP';
    validity = 'CONFIRMED';
    permissionsSource = 'groups.getTokenPermissions';
    declaredPermissions = Array.isArray(permissions?.permissions)
      ? [...new Set<string>(permissions.permissions
        .map((entry: any) => safeText(entry?.name, 128))
        .filter((item: string) => Boolean(item)))].sort(stableCompare)
      : [];
    methods.push(method(
      'groups.getTokenPermissions',
      'CONFIRMED',
      'VK подтвердил GROUP credential и вернул permissions.',
      'vk',
      'GROUP_CREDENTIAL_CONFIRMED'
    ));
  } catch (error) {
    groupProbeError = error;
    const failed = vkFailure('groups.getTokenPermissions', error);
    const wrongType = error instanceof PlatformError && Number(error.code) === 27;
    methods.push(method(
      'groups.getTokenPermissions',
      wrongType ? 'NOT_SUPPORTED_FOR_CREDENTIAL_TYPE' : failed.state,
      failed.reason,
      'vk',
      failed.machineCode
    ));
  }

  let userProbeError: unknown = null;
  if (providerType !== 'GROUP') {
    try {
      const permissionMask = await vkCall('account.getAppPermissions', common);
      const numericMask = Number(permissionMask);
      providerType = 'USER';
      validity = 'CONFIRMED';
      permissionsSource = 'account.getAppPermissions';
      if (Number.isFinite(numericMask)) declaredPermissions = [`permission_mask:${Math.trunc(numericMask)}`];
      methods.push(method(
        'account.getAppPermissions',
        'CONFIRMED',
        'VK подтвердил USER credential через account.getAppPermissions.',
        'vk',
        Number.isFinite(numericMask) ? `PERMISSION_MASK_${Math.trunc(numericMask)}` : 'USER_CREDENTIAL_CONFIRMED'
      ));
    } catch (error) {
      userProbeError = error;
      const failed = vkFailure('account.getAppPermissions', error);
      const wrongType = error instanceof PlatformError && Number(error.code) === 27;
      methods.push(method(
        'account.getAppPermissions',
        wrongType ? 'NOT_SUPPORTED_FOR_CREDENTIAL_TYPE' : failed.state,
        failed.reason,
        'vk',
        failed.machineCode
      ));
    }
  }

  let user: any = null;
  if (providerType === 'USER' || providerType === 'UNKNOWN') {
    try {
      const users = await vkCall('users.get', { ...common, fields: 'screen_name' });
      user = Array.isArray(users) ? users[0] : null;
      if (user?.id) {
        const userId = normalizeVkUserId(user.id);
        identity = vkDisplayName(user, `id${userId}`);
        ownerId = userId;
        methods.push(method(
          'users.get',
          'CONFIRMED',
          providerType === 'USER'
            ? 'VK вернул identity USER credential.'
            : 'VK вернул user identity/read evidence; это не классифицирует credential как USER.',
          'vk',
          'IDENTITY_CONFIRMED'
        ));
        if (providerType === 'UNKNOWN') {
          providerType = 'SERVICE_OR_UNKNOWN';
          validity = 'CONFIRMED';
        }
      } else {
        methods.push(method('users.get', 'DENIED', 'VK не вернул user identity.', 'vk', 'IDENTITY_NOT_CONFIRMED'));
      }
    } catch (error) {
      methods.push(vkMethodFromFailure('users.get', error));
      if (providerType === 'USER') {
        if (isUnavailablePlatformError(error)) warnings.push('USER credential подтверждён, но users.get временно недоступен.');
      } else if (isUnavailablePlatformError(error) || isUnavailablePlatformError(groupProbeError) || isUnavailablePlatformError(userProbeError)) {
        validity = 'UNAVAILABLE';
      }
    }
  }

  if (providerType === 'UNKNOWN' && validity !== 'UNAVAILABLE') {
    const allCode5 = [groupProbeError, userProbeError]
      .filter(Boolean)
      .every((error) => error instanceof PlatformError && Number(error.code) === 5);
    if (allCode5 && groupProbeError && userProbeError) {
      validity = 'UNKNOWN';
      warnings.push('VK не позволил безопасно отличить недействительный credential от ограниченного/IP-bound credential.');
    }
  }

  if (providerType === 'GROUP') {
    let destination: CapabilityDestinationEvidence = unknownDestination();
    let group: any = null;
    try {
      const response = await vkCall('groups.getById', {
        ...common,
        fields: 'screen_name'
      });
      group = vkGroupFromResponse(response);
      if (!group?.id) throw new Error('VK did not return group identity.');
      const groupId = normalizeVkCommunityId(group.id);
      identity = vkDisplayName(group, `club${groupId}`);
      ownerId = groupId;
      const reference = credentials.groupId !== undefined && String(credentials.groupId).trim()
        ? vkCommunityReference(credentials) : groupId;
      const matchesToken = reference === groupId || reference.toLowerCase() === String(group.screen_name || '').toLowerCase();
      destination = {
        resolutionState: matchesToken ? 'CONFIRMED' : 'DENIED',
        kind: 'COMMUNITY',
        id: matchesToken ? groupId : reference,
        name: matchesToken ? identity : reference,
        role: 'group credential',
        ownershipConfirmed: matchesToken
      };
      methods.push(method(
        'groups.getById',
        'CONFIRMED',
        'VK вернул сообщество самого ключа без group_id; назначение сравнивается с этим сообществом.',
        'vk',
        'GROUP_READABLE'
      ));
    } catch (error) {
      const failed = vkFailure('groups.getById', error);
      methods.push(method('groups.getById', failed.state, failed.reason, 'vk', failed.machineCode));
      destination = failed.unavailable
        ? unavailableDestination()
        : { resolutionState: 'DENIED', kind: 'COMMUNITY', id: null, name: null, role: null, ownershipConfirmed: false };
    }

    const code = 'VK_USER_CREDENTIAL_REQUIRED';
    let photoReady = false;
    let photoReason = 'Добавьте пользовательский ключ загрузки фото к ключу сообщества.';
    if (destination.resolutionState === 'CONFIRMED' && declaredPermissions.includes('wall')
      && typeof credentials.uploadAccessToken === 'string' && credentials.uploadAccessToken.trim()) {
      try {
        const checked = await checkVkPhotoUploadAccess({ ...credentials, groupId: destination.id, destinationKind: 'COMMUNITY' });
        photoReady = true;
        photoReason = `USER id${checked.userId} загрузит фото; GROUP отправит пост в своё сообщество.`;
        methods.push(method('account.getAppPermissions', 'CONFIRMED', 'Ключ загрузки подтвердил тип USER.', 'vk', 'UPLOAD_USER_CONFIRMED'));
        methods.push(method('users.get', 'CONFIRMED', `Владелец ключа загрузки: id${checked.userId}.`, 'vk', 'UPLOAD_IDENTITY_CONFIRMED'));
        methods.push(method('photos.getWallUploadServer', 'CONFIRMED', 'Ключ загрузки получил URL выбранного сообщества; файл не отправлялся.', 'vk', 'UPLOAD_URL_CONFIRMED'));
      } catch (error) {
        photoReason = safeText(error instanceof Error ? error.message : error).split(credentials.uploadAccessToken).join('[REDACTED]');
        const methodName = /VK ([a-z]+\.[A-Za-z]+)/.exec(error instanceof Error ? error.message : '')?.[1] || 'photos.getWallUploadServer';
        methods.push({ ...vkMethodFromFailure(methodName, error), reason: photoReason });
      }
    }
    if (!photoReady) {
      remediationRows.push(remediation(code, 'Проверьте пользовательский ключ загрузки фото', photoReason, { requiredCredentialType: 'USER' }));
      if (!methods.some(item => item.method === 'photos.getWallUploadServer')) methods.push(method(
        'photos.getWallUploadServer', credentials.uploadAccessToken ? 'NOT_CHECKED' : 'NOT_SUPPORTED_FOR_CREDENTIAL_TYPE', photoReason, 'vk', 'USER_CREDENTIAL_REQUIRED'
      ));
    }
    methods.push(method(
      'wall.post',
      'NOT_CHECKED',
      'Текстовый wall.post поддерживается ключом сообщества; проверка ключа не создаёт публичный пост.',
      'vk',
      'PUBLIC_WRITE_NOT_EXECUTED'
    ));

    return {
      platform: 'vk',
      credential: {
        validity: 'CONFIRMED',
        providerType: 'GROUP',
        identity,
        ownerId,
        expiresAt: null,
        declaredPermissions,
        permissionsSource
      },
      destination,
      methods,
      publicationEvidence: {
        TEXT: publication(destination.resolutionState === 'UNAVAILABLE' ? 'UNAVAILABLE'
          : destination.resolutionState === 'CONFIRMED' && declaredPermissions.includes('wall') ? 'CONFIRMED' : 'DENIED', {
          requiredMethods: ['groups.getTokenPermissions', 'groups.getById', 'wall.post'],
          reason: 'Текст требует права wall и совпадения назначения с сообществом ключа; публичная отправка не выполнялась.'
        }),
        IMAGE: publication(photoReady ? 'CONFIRMED' : 'SETUP_REQUIRED', {
          requiredMethods: ['photos.getWallUploadServer', 'photos.saveWallPhoto', 'wall.post'],
          reason: photoReason, remediationCodes: photoReady ? [] : [code]
        }),
        CAROUSEL: publication(photoReady ? 'CONFIRMED' : 'SETUP_REQUIRED', {
          requiredMethods: ['photos.getWallUploadServer', 'photos.saveWallPhoto', 'wall.post'],
          reason: photoReason, remediationCodes: photoReady ? [] : [code]
        })
      },
      runtimePrerequisiteEvidence: [],
      remediation: remediationRows,
      warnings
    };
  }

  if (providerType !== 'USER') {
    return {
      platform: 'vk',
      credential: {
        validity,
        providerType,
        identity,
        ownerId,
        expiresAt: null,
        declaredPermissions,
        permissionsSource
      },
      destination: validity === 'UNAVAILABLE' ? unavailableDestination() : unknownDestination(),
      methods: [
        ...methods,
        method('wall.post', 'NOT_CHECKED', 'Public wall.post is never executed during credential inspection.', 'vk', 'PUBLIC_WRITE_NOT_EXECUTED')
      ],
      publicationEvidence: validity === 'UNAVAILABLE'
        ? unavailablePublications('VK credential inspection is temporarily unavailable.', 'VK_INSPECTION_UNAVAILABLE')
        : {
          TEXT: publication('UNKNOWN', { reason: 'Credential type/method eligibility is not proven.' }),
          IMAGE: publication('UNKNOWN', { reason: 'Credential type/method eligibility is not proven.' }),
          CAROUSEL: publication('UNKNOWN', { reason: 'Credential type/method eligibility is not proven.' })
        },
      runtimePrerequisiteEvidence: [],
      remediation: [],
      warnings
    };
  }

  let destination: CapabilityDestinationEvidence = unknownDestination();
  let destinationKind: 'PERSONAL' | 'COMMUNITY' | null = null;
  try {
    destinationKind = vkDestinationKind(credentials);
  } catch (error) {
    warnings.push(safeText(error instanceof Error ? error.message : error));
  }

  if (destinationKind === null) {
    destination = unknownDestination();
  } else if (destinationKind === 'PERSONAL') {
    if (!ownerId) {
      destination = {
        resolutionState: 'UNKNOWN',
        kind: 'PERSONAL',
        id: typeof credentials.userId === 'string' ? safeText(credentials.userId, 256) : null,
        name: null,
        role: null,
        ownershipConfirmed: null
      };
    } else if (credentials.userId !== undefined && credentials.userId !== null && String(credentials.userId).trim()) {
      const configuredUserId = normalizeVkUserId(credentials.userId);
      if (configuredUserId !== ownerId) {
        destination = {
          resolutionState: 'DENIED',
          kind: 'PERSONAL',
          id: configuredUserId,
          name: `id${configuredUserId}`,
          role: null,
          ownershipConfirmed: false
        };
        methods.push(method(
          'vk.destination.personal',
          'DENIED',
          'Configured PERSONAL destination does not match USER credential owner.',
          'vk',
          'PERSONAL_OWNER_MISMATCH'
        ));
      } else {
        destination = {
          resolutionState: 'CONFIRMED',
          kind: 'PERSONAL',
          id: ownerId,
          name: identity,
          role: 'owner',
          ownershipConfirmed: true
        };
      }
    } else {
      destination = {
        resolutionState: 'CONFIRMED',
        kind: 'PERSONAL',
        id: ownerId,
        name: identity,
        role: 'owner',
        ownershipConfirmed: true
      };
    }
  } else {
    try {
      const reference = vkCommunityReference(credentials);
      const response = await vkCall('groups.getById', { ...common, group_id: reference, fields: 'screen_name' });
      const group = vkGroupFromResponse(response);
      if (!group?.id) throw new Error('VK did not return community identity.');
      const groupId = normalizeVkCommunityId(group.id);
      const name = vkDisplayName(group, `club${groupId}`);
      destination = {
        resolutionState: 'CONFIRMED',
        kind: 'COMMUNITY',
        id: groupId,
        name,
        role: null,
        ownershipConfirmed: false
      };
      methods.push(method(
        'groups.getById',
        'CONFIRMED',
        'VK вернул community object. Это подтверждает readability, но не ownership/admin.',
        'vk',
        'GROUP_READABLE'
      ));
    } catch (error) {
      const failed = vkFailure('groups.getById', error);
      methods.push(method('groups.getById', failed.state, failed.reason, 'vk', failed.machineCode));
      destination = failed.unavailable
        ? unavailableDestination()
        : { resolutionState: 'DENIED', kind: 'COMMUNITY', id: null, name: null, role: null, ownershipConfirmed: false };
    }
  }

  let wallUploadState: ProviderPublicationEvidence['state'] = 'UNKNOWN';
  let wallUploadCode: string | null = null;
  if (destination.resolutionState === 'CONFIRMED') {
    try {
      const server = await vkCall('photos.getWallUploadServer', {
        ...common,
        ...(destination.kind === 'COMMUNITY' && destination.id ? { group_id: destination.id } : {})
      });
      if (!server?.upload_url) throw new Error('VK photos.getWallUploadServer did not return upload_url.');
      methods.push(method(
        'photos.getWallUploadServer',
        'CONFIRMED',
        'VK returned upload_url for wall-photo preparation.',
        'vk',
        'UPLOAD_SERVER_CONFIRMED'
      ));
      wallUploadState = 'CONFIRMED';
    } catch (error) {
      const failed = vkFailure('photos.getWallUploadServer', error);
      methods.push(method('photos.getWallUploadServer', failed.state, failed.reason, 'vk', failed.machineCode));
      wallUploadState = failed.unavailable ? 'UNAVAILABLE' : 'DENIED';
      wallUploadCode = failed.machineCode;
    }
  } else if (destination.resolutionState === 'UNAVAILABLE') {
    methods.push(method(
      'photos.getWallUploadServer',
      'UNAVAILABLE',
      'Destination resolution is unavailable, so wall upload was not probed.',
      'vk',
      'DESTINATION_UNAVAILABLE'
    ));
    wallUploadState = 'UNAVAILABLE';
  } else {
    methods.push(method(
      'photos.getWallUploadServer',
      'NOT_CHECKED',
      'Destination is not confirmed, so wall upload was not probed.',
      'vk',
      'DESTINATION_NOT_CONFIRMED'
    ));
    wallUploadState = destination.resolutionState === 'DENIED' ? 'DENIED' : 'UNKNOWN';
  }

  methods.push(method(
    'photos.saveWallPhoto',
    'NOT_CHECKED',
    'photos.saveWallPhoto requires uploaded photo parameters and is not executed during credential inspection.',
    'vk',
    'PUBLICATION_PREPARATION_NOT_EXECUTED'
  ));
  methods.push(method(
    'wall.post',
    'NOT_CHECKED',
    'Public wall.post is never executed during credential inspection.',
    'vk',
    'PUBLIC_WRITE_NOT_EXECUTED'
  ));

  const imageEvidence = wallUploadState === 'CONFIRMED'
    ? publication('CONFIRMED', {
      requiredMethods: ['photos.getWallUploadServer', 'photos.saveWallPhoto', 'wall.post'],
      reason: 'USER credential and wall-photo preparation are confirmed; public wall.post remains intentionally unexecuted.'
    })
    : wallUploadState === 'UNAVAILABLE'
      ? publication('UNAVAILABLE', {
        requiredMethods: ['photos.getWallUploadServer', 'photos.saveWallPhoto', 'wall.post'],
        remediationCodes: wallUploadCode ? [wallUploadCode] : []
      })
      : wallUploadState === 'DENIED'
        ? publication('DENIED', {
          requiredMethods: ['photos.getWallUploadServer', 'photos.saveWallPhoto', 'wall.post'],
          remediationCodes: ['VK_WALL_UPLOAD_DENIED']
        })
        : publication('UNKNOWN', {
          requiredMethods: ['photos.getWallUploadServer', 'photos.saveWallPhoto', 'wall.post']
        });

  return {
    platform: 'vk',
    credential: {
      validity: 'CONFIRMED',
      providerType: 'USER',
      identity,
      ownerId,
      expiresAt: null,
      declaredPermissions,
      permissionsSource
    },
    destination,
    methods,
    publicationEvidence: {
      TEXT: publication('UNKNOWN', {
        requiredMethods: ['wall.post'],
        reason: 'wall.post is a public operation and is intentionally not executed during inspection.'
      }),
      IMAGE: imageEvidence,
      CAROUSEL: imageEvidence,
      VIDEO: publication('UNKNOWN'),
      SHORT: publication('UNKNOWN'),
      STORY: publication('UNKNOWN')
    },
    runtimePrerequisiteEvidence: [],
    remediation: remediationRows,
    warnings
  };
}

function validPublicHttpsBase(): boolean {
  if (!config.publicBaseUrl) return false;
  try {
    const url = new URL(config.publicBaseUrl);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function inspectInstagram(credentials: Record<string, unknown>): Promise<CredentialInspectionResult> {
  const accessToken = requireString(credentials, 'accessToken');
  const igUserId = requireString(credentials, 'igUserId');
  const graphVersion = requireString(credentials, 'graphVersion');
  const params = new URLSearchParams({ fields: 'id,username,account_type', access_token: accessToken });
  const probe = await jsonProbe(
    `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(igUserId)}?${params}`
  );
  const methods: CapabilityMethodEvidence[] = [];
  const remediationRows: CapabilityRemediation[] = [];
  const runtimePrerequisiteEvidence: RuntimePrerequisiteEvidence[] = [];

  const publicHttps = validPublicHttpsBase();
  for (const format of ['IMAGE', 'CAROUSEL', 'VIDEO', 'SHORT'] as PublicationFormat[]) {
    runtimePrerequisiteEvidence.push({
      format,
      state: publicHttps ? 'CONFIRMED' : 'MISSING',
      code: 'PUBLIC_HTTPS_MEDIA',
      remediationCode: publicHttps ? null : 'INSTAGRAM_PUBLIC_MEDIA_REQUIRED',
      reason: publicHttps ? 'PUBLIC_BASE_URL is public HTTPS.' : 'Instagram media publishing requires public HTTPS media URLs.'
    });
  }
  if (!publicHttps) {
    remediationRows.push(remediation(
      'INSTAGRAM_PUBLIC_MEDIA_REQUIRED',
      'Нужен публичный HTTPS URL',
      'Настройте PUBLIC_BASE_URL на доступный извне HTTPS origin для media.'
    ));
  }

  if (probe.kind === 'unavailable' || probe.status >= 500 || probe.status === 429) {
    const reason = probe.kind === 'unavailable'
      ? probe.reason
      : safeText(probe.body?.error?.message || `Instagram account check HTTP ${probe.status}`);
    const code = probe.kind === 'unavailable' ? probe.machineCode : `HTTP_${probe.status}`;
    methods.push(method('instagram.account', 'UNAVAILABLE', reason, 'instagram', code));
    return {
      platform: 'instagram',
      credential: {
        validity: 'UNAVAILABLE', providerType: 'INSTAGRAM_USER', identity: null, ownerId: null,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: unavailableDestination(),
      methods,
      publicationEvidence: unavailablePublications(reason, code),
      runtimePrerequisiteEvidence,
      remediation: remediationRows,
      warnings: []
    };
  }

  const body = probe.body;
  const graphCode = Number(body?.error?.code || 0);
  if (probe.status === 401 || graphCode === 190) {
    const reason = safeText(body?.error?.message || 'Instagram access token is invalid or expired.');
    methods.push(method('instagram.account', 'DENIED', reason, 'instagram', graphCode ? `GRAPH_${graphCode}` : `HTTP_${probe.status}`));
    return {
      platform: 'instagram',
      credential: {
        validity: 'INVALID', providerType: 'INSTAGRAM_USER', identity: null, ownerId: null,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: unknownDestination(),
      methods,
      publicationEvidence: {},
      runtimePrerequisiteEvidence,
      remediation: remediationRows,
      warnings: []
    };
  }

  if (!body?.id) {
    const reason = safeText(body?.error?.message || 'Instagram account identity was not confirmed.');
    methods.push(method('instagram.account', 'DENIED', reason, 'instagram', graphCode ? `GRAPH_${graphCode}` : 'ACCOUNT_NOT_CONFIRMED'));
    return {
      platform: 'instagram',
      credential: {
        validity: 'UNKNOWN', providerType: 'INSTAGRAM_USER', identity: null, ownerId: null,
        expiresAt: null, declaredPermissions: [], permissionsSource: null
      },
      destination: {
        resolutionState: 'DENIED', kind: 'PROFESSIONAL_ACCOUNT', id: igUserId, name: null,
        role: null, ownershipConfirmed: null
      },
      methods,
      publicationEvidence: {
        IMAGE: publication('UNKNOWN', { reason }),
        CAROUSEL: publication('UNKNOWN', { reason })
      },
      runtimePrerequisiteEvidence,
      remediation: remediationRows,
      warnings: []
    };
  }

  const ownerId = String(body.id);
  const identity = body.username ? `@${safeText(body.username, 256)}` : ownerId;
  const accountType = safeNullable(body.account_type, 128);
  methods.push(method(
    'instagram.account',
    'CONFIRMED',
    'Instagram confirmed account identity.',
    'instagram',
    accountType ? `ACCOUNT_TYPE_${accountType.toUpperCase()}` : 'IDENTITY_CONFIRMED'
  ));
  const code = 'INSTAGRAM_PUBLISH_PERMISSION_NOT_PROVEN';
  remediationRows.push(remediation(
    code,
    'Публикационные права ещё не доказаны',
    'Identity проверена, но обычная безопасная проверка не доказывает media publishing permission. Не публикуйте тестовый пост только ради проверки ключа.'
  ));

  return {
    platform: 'instagram',
    credential: {
      validity: 'CONFIRMED',
      providerType: accountType ? `INSTAGRAM_${accountType.toUpperCase()}` : 'INSTAGRAM_USER',
      identity,
      ownerId,
      expiresAt: null,
      declaredPermissions: [],
      permissionsSource: null
    },
    destination: {
      resolutionState: 'CONFIRMED',
      kind: accountType || 'PROFESSIONAL_ACCOUNT',
      id: ownerId,
      name: identity,
      role: accountType,
      ownershipConfirmed: null
    },
    methods,
    publicationEvidence: {
      TEXT: publication('DENIED', { remediationCodes: ['INSTAGRAM_TEXT_ONLY_NOT_AVAILABLE'] }),
      IMAGE: publication('UNKNOWN', { remediationCodes: [code], reason: 'Identity alone is not publish authorization.' }),
      CAROUSEL: publication('UNKNOWN', { remediationCodes: [code], reason: 'Identity alone is not publish authorization.' }),
      VIDEO: publication('UNKNOWN', { remediationCodes: [code] }),
      SHORT: publication('UNKNOWN', { remediationCodes: [code] }),
      STORY: publication('UNKNOWN', { remediationCodes: [code] })
    },
    runtimePrerequisiteEvidence,
    remediation: remediationRows,
    warnings: []
  };
}

export async function inspectSocialCredential(
  platform: Platform,
  credentials: Record<string, unknown>
): Promise<CredentialInspectionResult> {
  if (platform === 'telegram') return inspectTelegram(credentials);
  if (platform === 'max') return inspectMax(credentials);
  if (platform === 'vk') return inspectVk(credentials);
  return inspectInstagram(credentials);
}
