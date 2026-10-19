import { decryptJson, encryptJson } from './crypto.js';
import { db, id, nowIso, type Platform } from './db.js';
import { PLATFORM_CAPABILITIES } from './platforms/capabilities.js';
import {
  inspectSocialCredential,
  type CredentialInspectionResult
} from './platforms/credential-inspection.js';
import { vkDestinationKind } from './platforms/vk.js';
import {
  buildCapabilityProfile,
  readCapabilityProfile,
  recordCapabilityCheckUnavailable,
  replaceSocialAccountCredentials,
  saveCapabilityProfile,
  type BuiltCapabilityProfile,
  type CapabilityBuildInput,
  type CapabilityProfileView,
  type PublicationFormat
} from './social-credential-capability.js';

const PLATFORMS = new Set<Platform>(['telegram', 'vk', 'max', 'instagram']);

type SocialAccountRow = {
  id: string;
  platform: Platform;
  name: string;
  credentials_encrypted: string;
  enabled: number;
  credential_version: number;
};

type SocialAccountView = {
  id: string;
  platform: Platform;
  name: string;
  enabled: boolean;
  credentialVersion: number;
};

export type SocialCredentialResult = {
  account: SocialAccountView;
  capabilityProfile: CapabilityProfileView;
};

type CredentialInspector = typeof inspectSocialCredential;

let credentialInspector: CredentialInspector = inspectSocialCredential;

export class SocialCredentialRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialCredentialRequestError';
  }
}

export class SocialCredentialVersionConflictError extends Error {
  constructor() {
    super('Подключение изменилось во время проверки. Повторите проверку текущего ключа.');
    this.name = 'SocialCredentialVersionConflictError';
  }
}

export class SocialAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Social account not found: ${accountId}`);
    this.name = 'SocialAccountNotFoundError';
  }
}

export function setSocialCredentialInspectorForTests(inspector: CredentialInspector | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Credential inspector override is test-only');
  }
  credentialInspector = inspector ?? inspectSocialCredential;
}

function requestError(message: string): never {
  throw new SocialCredentialRequestError(message);
}

function nonEmptyString(
  source: Record<string, unknown>,
  key: string,
  label = key
): string {
  const value = typeof source[key] === 'string' ? source[key].trim() : '';
  if (!value) requestError(`Не заполнено обязательное поле ${label}`);
  return value;
}

function normalizeVkCommunityReference(value: unknown): string {
  let raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!raw) requestError('VK: не указан groupId');

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      raw = url.pathname.split('/').filter(Boolean)[0] || '';
    } catch {
      requestError('VK: некорректная ссылка сообщества');
    }
  }

  raw = raw.replace(/^@/, '');
  if (!raw || !/^(?:-?\d+|(?:club|public|event)\d+|[A-Za-z0-9_.-]+)$/i.test(raw)) {
    requestError('VK: некорректный groupId');
  }
  return raw;
}

function normalizeVkUserReference(value: unknown): string {
  let raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      raw = url.pathname.split('/').filter(Boolean)[0] || '';
    } catch {
      requestError('VK: некорректная ссылка личной страницы');
    }
  }

  raw = raw.replace(/^@/, '').replace(/^id/i, '').replace(/^\+/, '');
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    requestError('VK: userId должен быть положительным числом');
  }
  return BigInt(raw).toString();
}

function normalizeCredentials(platform: Platform, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    requestError('credentials должен быть объектом');
  }
  const supplied = raw as Record<string, unknown>;

  if (platform === 'telegram') {
    return {
      botToken: nonEmptyString(supplied, 'botToken', 'botToken'),
      chatId: nonEmptyString(supplied, 'chatId', 'chatId')
    };
  }

  if (platform === 'max') {
    return {
      accessToken: nonEmptyString(supplied, 'accessToken', 'accessToken'),
      chatId: nonEmptyString(supplied, 'chatId', 'chatId')
    };
  }

  if (platform === 'instagram') {
    return {
      accessToken: nonEmptyString(supplied, 'accessToken', 'accessToken'),
      igUserId: nonEmptyString(supplied, 'igUserId', 'igUserId'),
      graphVersion: nonEmptyString(supplied, 'graphVersion', 'graphVersion')
    };
  }

  const accessToken = nonEmptyString(supplied, 'accessToken', 'accessToken');
  const apiVersion = typeof supplied.apiVersion === 'string' && supplied.apiVersion.trim()
    ? supplied.apiVersion.trim()
    : '5.199';

  let destinationKind: 'PERSONAL' | 'COMMUNITY';
  try {
    destinationKind = vkDestinationKind(supplied);
  } catch (error) {
    requestError(error instanceof Error ? error.message : String(error));
  }

  if (destinationKind === 'COMMUNITY') {
    if (supplied.uploadAccessToken !== undefined && typeof supplied.uploadAccessToken !== 'string') {
      requestError('VK: uploadAccessToken должен быть строкой');
    }
    const uploadAccessToken = typeof supplied.uploadAccessToken === 'string'
      ? supplied.uploadAccessToken.trim()
      : '';
    return {
      accessToken,
      apiVersion,
      destinationKind,
      groupId: normalizeVkCommunityReference(supplied.groupId),
      ...(uploadAccessToken ? { uploadAccessToken } : {})
    };
  }

  const userId = normalizeVkUserReference(supplied.userId);
  return {
    accessToken,
    apiVersion,
    destinationKind,
    ...(userId ? { userId } : {})
  };
}

export function normalizeSocialCredentialInput(
  platform: Platform,
  raw: unknown,
  options: { requireExplicitPersonalDestination?: boolean } = {}
): Record<string, unknown> {
  const normalized = normalizeCredentials(platform, raw);
  if (platform === 'vk' && options.requireExplicitPersonalDestination
    && normalized.destinationKind === 'PERSONAL' && !normalized.userId) {
    requestError('VK: для замены подключения PERSONAL требуется userId выбранной страницы');
  }
  return normalized;
}

function normalizePlatform(value: unknown): Platform {
  const platform = typeof value === 'string' ? value.trim().toLowerCase() as Platform : '' as Platform;
  if (!PLATFORMS.has(platform)) requestError('Неизвестная площадка');
  return platform;
}

function adapterCapability(platform: Platform): Partial<Record<PublicationFormat, boolean>> {
  const capability = PLATFORM_CAPABILITIES[platform];
  return {
    TEXT: capability.supportsTextOnly,
    IMAGE: capability.supportsImage,
    CAROUSEL: capability.supportsCarousel,
    VIDEO: capability.supportsVideo,
    SHORT: capability.supportsShortVideo,
    STORY: capability.supportsStories
  };
}

function profileInput(
  platform: Platform,
  inspection: CredentialInspectionResult
): CapabilityBuildInput {
  return {
    inspectionCompleted: true,
    providerType: inspection.credential.providerType,
    credential: inspection.credential,
    destination: inspection.destination,
    methods: inspection.methods,
    publicationEvidence: inspection.publicationEvidence,
    runtimePrerequisites: inspection.runtimePrerequisiteEvidence,
    remediation: inspection.remediation,
    warnings: inspection.warnings,
    adapterCapability: adapterCapability(platform)
  };
}

function checkFailureMetadata(
  built: BuiltCapabilityProfile,
  inspection: CredentialInspectionResult
): { code: string | null; message: string | null } {
  if (built.accessLevel === 'UNAVAILABLE') {
    const unavailable = inspection.methods.find((item) => item.state === 'UNAVAILABLE');
    return {
      code: unavailable?.machineCode || 'INSPECTION_UNAVAILABLE',
      message: unavailable?.reason || 'Provider inspection is temporarily unavailable.'
    };
  }
  if (built.accessLevel === 'INVALID') {
    const denied = inspection.methods.find((item) => item.state === 'DENIED');
    return {
      code: denied?.machineCode || 'CREDENTIAL_INVALID',
      message: denied?.reason || 'Provider rejected the credential.'
    };
  }
  return { code: null, message: null };
}

function hasReadyImplementedFormat(
  platform: Platform,
  profile: CapabilityProfileView
): boolean {
  if (!profile.profileCurrent || !profile.semantic) return false;
  const implemented = adapterCapability(platform);
  return Object.entries(profile.semantic.publicationReadiness).some(([format, readiness]) => (
    implemented[format as PublicationFormat] === true && readiness.state === 'READY'
  ));
}

/**
 * Runtime VK flags are a *server-derived projection* of CRED-01B inspection,
 * never browser-provided evidence. Legacy VK publisher accepts these flags.
 */
function verifiedPublisherCredentials(
  platform: Platform,
  raw: Record<string, unknown>,
  inspection: CredentialInspectionResult,
  profile: BuiltCapabilityProfile
): Record<string, unknown> {
  if (platform !== 'vk') return raw;
  const destination = inspection.destination;
  const common = { ...raw };
  if (inspection.credential.validity !== 'CONFIRMED'
    || !destination || destination.resolutionState !== 'CONFIRMED' || !destination.id) {
    return { ...common, authKind: 'PENDING' };
  }
  if (inspection.credential.providerType === 'GROUP' && destination.kind === 'COMMUNITY') {
    const textReady = profile.semantic.publicationReadiness.TEXT.state === 'READY';
    const photosReady = profile.semantic.publicationReadiness.IMAGE.state === 'READY'
      && profile.semantic.publicationReadiness.CAROUSEL.state === 'READY'
      && Boolean(inspection.verifiedVkUploadUserId) && Boolean(raw.uploadAccessToken);
    return {
      ...common,
      destinationKind: 'COMMUNITY',
      groupId: destination.id,
      authKind: 'COMMUNITY',
      tokenGroupId: destination.id,
      textPublishReady: textReady,
      photoPublishReady: photosReady,
      uploadUserId: photosReady ? inspection.verifiedVkUploadUserId : null,
      photoSetupError: photosReady ? null : (inspection.publicationEvidence.IMAGE?.reason || 'Подтвердите USER ключ загрузки фотографий')
    };
  }
  if (inspection.credential.providerType === 'USER'
    && (destination.kind === 'COMMUNITY' || destination.kind === 'PERSONAL')) {
    return {
      ...common,
      authKind: 'USER',
      destinationKind: destination.kind,
      ...(destination.kind === 'COMMUNITY'
        ? { groupId: destination.id }
        : { userId: destination.id })
    };
  }
  return { ...common, authKind: 'PENDING' };
}

function persistVerifiedCredentials(accountId: string, before: SocialAccountRow,
  credentials: Record<string, unknown>, previousProfile: CapabilityProfileView): void {
  const existing = decryptJson<Record<string, unknown>>(before.credentials_encrypted);
  if (JSON.stringify(existing) === JSON.stringify(credentials)) return;
  if (previousProfile.profileCurrent && previousProfile.accessLevel !== 'UNCHECKED') {
    // Recheck discovered a semantically different published credential configuration:
    // old READY/preflight must not continue with that fingerprint.
    replaceSocialAccountCredentials(accountId, encryptJson(credentials));
    return;
  }
  // The account was already UNCHECKED (initial save or explicit replacement).
  // Complete the same logical mutation without a second credential_version bump.
  const updated = db.prepare(`UPDATE social_accounts SET credentials_encrypted=?,updated_at=?
    WHERE id=? AND credential_version=? AND credentials_encrypted=?`)
    .run(encryptJson(credentials), nowIso(), accountId, before.credential_version, before.credentials_encrypted);
  if (updated.changes !== 1) throw new SocialCredentialVersionConflictError();
}

function accountRow(accountId: string): SocialAccountRow {
  const row = db.prepare(`SELECT id,platform,name,credentials_encrypted,enabled,credential_version
    FROM social_accounts WHERE id=?`).get(accountId) as SocialAccountRow | undefined;
  if (!row) throw new SocialAccountNotFoundError(accountId);
  return row;
}

function requireSameCredentialVersion(accountId: string, expected: SocialAccountRow): void {
  const current = accountRow(accountId);
  if (
    current.credential_version !== expected.credential_version
    || current.credentials_encrypted !== expected.credentials_encrypted
  ) {
    throw new SocialCredentialVersionConflictError();
  }
}

function accountView(row: SocialAccountRow): SocialAccountView {
  return {
    id: row.id,
    platform: row.platform,
    name: row.name,
    enabled: row.enabled === 1,
    credentialVersion: row.credential_version
  };
}

function persistNewAccountEnabled(accountId: string, enabled: boolean): void {
  const now = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE social_accounts SET enabled=?,updated_at=? WHERE id=?')
      .run(enabled ? 1 : 0, now, accountId);
    if (enabled) {
      db.prepare(`INSERT OR IGNORE INTO project_default_targets (project_id,account_id,created_at)
        SELECT id,?,? FROM projects WHERE default_targets_explicit=0`)
        .run(accountId, now);
    }
  })();
}

function successfulSemanticProfile(profile: CapabilityProfileView): boolean {
  return profile.profileCurrent
    && profile.semantic !== null
    && profile.lastSuccessfulCheckedAt !== null
    && !['INVALID', 'UNAVAILABLE', 'UNCHECKED'].includes(profile.accessLevel);
}

/**
 * Legacy "save for later" is allowed only as an explicitly disabled VK
 * connection. User-supplied PENDING is an intent, never publication evidence.
 */
export function saveUncheckedVkAccount(input: {
  name: unknown;
  credentials: unknown;
}): SocialCredentialResult {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) requestError('Нужно непустое name');
  const normalized = normalizeCredentials('vk', input.credentials);
  const accountId = id('acc');
  const now = nowIso();
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,credential_version,created_at,updated_at)
    VALUES (?,'vk',?,?,0,1,?,?)`).run(accountId, name,
    encryptJson({ ...normalized, authKind: 'PENDING' }), now, now);
  return { account: accountView(accountRow(accountId)), capabilityProfile: readCapabilityProfile(accountId) };
}

export async function saveAndCheckSocialAccount(input: {
  platform: unknown;
  name: unknown;
  credentials: unknown;
}): Promise<SocialCredentialResult> {
  const platform = normalizePlatform(input.platform);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) requestError('Нужно непустое name');
  const credentials = normalizeCredentials(platform, input.credentials);

  const accountId = id('acc');
  const now = nowIso();
  const encrypted = encryptJson(credentials);

  db.transaction(() => {
    db.prepare(`INSERT INTO social_accounts
      (id,platform,name,credentials_encrypted,enabled,credential_version,created_at,updated_at)
      VALUES (?,?,?,?,0,1,?,?)`)
      .run(accountId, platform, name, encrypted, now, now);
  })();

  const inserted = accountRow(accountId);
  const inspection = await credentialInspector(platform, credentials);
  requireSameCredentialVersion(accountId, inserted);
  const inputForProfile = profileInput(platform, inspection);
  const built = buildCapabilityProfile(inputForProfile);
  const metadata = checkFailureMetadata(built, inspection);
  persistVerifiedCredentials(accountId, inserted,
    verifiedPublisherCredentials(platform, credentials, inspection, built),
    readCapabilityProfile(accountId));
  const capabilityProfile = saveCapabilityProfile(accountId, {
    ...inputForProfile,
    lastCheckCode: metadata.code,
    lastCheckMessage: metadata.message
  });

  const enabled = hasReadyImplementedFormat(platform, capabilityProfile);
  persistNewAccountEnabled(accountId, enabled);

  return {
    account: accountView(accountRow(accountId)),
    capabilityProfile
  };
}

export async function recheckSocialAccount(accountId: string): Promise<SocialCredentialResult> {
  const before = accountRow(accountId);
  const previousProfile = readCapabilityProfile(accountId);
  const credentials = decryptJson<Record<string, unknown>>(before.credentials_encrypted);
  const inspection = await credentialInspector(before.platform, credentials);
  requireSameCredentialVersion(accountId, before);
  const inputForProfile = profileInput(before.platform, inspection);
  const built = buildCapabilityProfile(inputForProfile);
  const metadata = checkFailureMetadata(built, inspection);

  // A transient provider failure never destroys previously confirmed semantics.
  if (!(built.accessLevel === 'UNAVAILABLE' && successfulSemanticProfile(previousProfile))) {
    persistVerifiedCredentials(accountId, before,
      verifiedPublisherCredentials(before.platform, credentials, inspection, built), previousProfile);
  }

  let capabilityProfile: CapabilityProfileView;
  if (built.accessLevel === 'UNAVAILABLE' && successfulSemanticProfile(previousProfile)) {
    const preserved = recordCapabilityCheckUnavailable(
      accountId,
      metadata.code,
      metadata.message
    );
    capabilityProfile = preserved
      ? readCapabilityProfile(accountId)
      : saveCapabilityProfile(accountId, {
        ...inputForProfile,
        lastCheckCode: metadata.code,
        lastCheckMessage: metadata.message
      });
  } else {
    capabilityProfile = saveCapabilityProfile(accountId, {
      ...inputForProfile,
      lastCheckCode: metadata.code,
      lastCheckMessage: metadata.message
    });
  }

  if (built.accessLevel === 'INVALID') {
    db.prepare('UPDATE social_accounts SET enabled=0,updated_at=? WHERE id=?')
      .run(nowIso(), accountId);
  }

  return {
    account: accountView(accountRow(accountId)),
    capabilityProfile
  };
}
