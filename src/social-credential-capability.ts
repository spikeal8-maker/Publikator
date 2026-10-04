import crypto from 'node:crypto';
import { db, nowIso } from './db.js';

export const CURRENT_CAPABILITY_PROFILE_VERSION = 1;

export const PUBLICATION_FORMATS = ['TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO', 'SHORT', 'STORY'] as const;
export type PublicationFormat = typeof PUBLICATION_FORMATS[number];

export type AccessLevel =
  | 'FULL'
  | 'PARTIAL'
  | 'READ_ONLY'
  | 'SETUP_REQUIRED'
  | 'INVALID'
  | 'UNAVAILABLE'
  | 'UNCHECKED';

export type CredentialVerdict = 'FULL' | 'LIMITED' | 'INVALID' | 'UNCHECKED';
export type CredentialValidity = 'CONFIRMED' | 'INVALID' | 'UNAVAILABLE' | 'UNKNOWN';
export type MethodState =
  | 'CONFIRMED'
  | 'DENIED'
  | 'UNAVAILABLE'
  | 'NOT_CHECKED'
  | 'NOT_SUPPORTED_FOR_CREDENTIAL_TYPE'
  | 'SETUP_REQUIRED'
  | 'NOT_IMPLEMENTED_IN_PUBLIKATOR';

export type PublicationReadinessState =
  | 'READY'
  | 'BLOCKED'
  | 'SETUP_REQUIRED'
  | 'NOT_IMPLEMENTED'
  | 'UNKNOWN'
  | 'UNAVAILABLE';

export type ProviderPublicationEvidenceState =
  | 'CONFIRMED'
  | 'DENIED'
  | 'SETUP_REQUIRED'
  | 'UNKNOWN'
  | 'UNAVAILABLE';

export type RuntimePrerequisiteState = 'CONFIRMED' | 'MISSING' | 'UNKNOWN' | 'UNAVAILABLE';
export type CheckStatus = 'SUCCESS' | 'INVALID' | 'UNAVAILABLE' | 'UNCHECKED';

export type CapabilityCredentialEvidence = {
  validity: CredentialValidity;
  identity: string | null;
  ownerId: string | null;
  expiresAt: string | null;
  declaredPermissions: string[];
  permissionsSource: string | null;
};

export type CapabilityDestinationEvidence = {
  resolutionState: 'CONFIRMED' | 'UNAVAILABLE' | 'UNKNOWN' | 'DENIED';
  kind: string | null;
  id: string | null;
  name: string | null;
  role: string | null;
  ownershipConfirmed: boolean | null;
};

export type CapabilityMethodEvidence = {
  method: string;
  state: MethodState;
  evidenceSource: string | null;
  machineCode: string | null;
  reason: string;
};

export type CapabilityReadiness = {
  state: PublicationReadinessState;
  reason: string;
  requiredMethods: string[];
  remediationCodes: string[];
};

export type RemediationAction = {
  label: string;
  kind: 'INTERNAL_ROUTE' | 'OFFICIAL_HELP_URL' | 'RECHECK';
  target: string | null;
};

export type CapabilityRemediation = {
  code: string;
  title: string;
  explanation: string;
  requiredCredentialType: string | null;
  requiredPermissions: string[];
  steps: string[];
  primaryAction: RemediationAction | null;
  secondaryActions: RemediationAction[];
};

export type CapabilitySemanticPayload = {
  credential: CapabilityCredentialEvidence;
  destination: CapabilityDestinationEvidence | null;
  methods: CapabilityMethodEvidence[];
  publicationReadiness: Record<PublicationFormat, CapabilityReadiness>;
  remediation: CapabilityRemediation[];
  warnings: string[];
};

export type ProviderPublicationEvidence = {
  state: ProviderPublicationEvidenceState;
  requiredMethods?: string[];
  remediationCodes?: string[];
  reason?: string;
};

export type RuntimePrerequisiteEvidence = {
  format: PublicationFormat;
  state: RuntimePrerequisiteState;
  code: string;
  remediationCode?: string | null;
  reason?: string;
};

export type CapabilityBuildInput = {
  inspectionCompleted: boolean;
  providerType?: string | null;
  credential: unknown;
  destination?: unknown;
  methods?: unknown;
  publicationEvidence?: Partial<Record<PublicationFormat, ProviderPublicationEvidence>>;
  runtimePrerequisites?: RuntimePrerequisiteEvidence[];
  remediation?: unknown;
  warnings?: unknown;
  adapterCapability: Partial<Record<PublicationFormat, boolean>>;
};

export type BuiltCapabilityProfile = {
  providerType: string;
  accessLevel: AccessLevel;
  verdict: CredentialVerdict;
  semantic: CapabilitySemanticPayload;
};

export type CapabilitySaveInput = CapabilityBuildInput & {
  checkedAt?: string | null;
  lastSuccessfulCheckedAt?: string | null;
  lastCheckCode?: string | null;
  lastCheckMessage?: string | null;
};

export type CapabilityProfileView = {
  accountId: string;
  profileCurrent: boolean;
  profileVersion: number;
  credentialVersion: number;
  providerType: string;
  accessLevel: AccessLevel;
  verdict: CredentialVerdict;
  profileFingerprint: string | null;
  checkedAt: string | null;
  lastSuccessfulCheckedAt: string | null;
  lastCheckStatus: CheckStatus;
  lastCheckCode: string | null;
  lastCheckMessage: string | null;
  semantic: CapabilitySemanticPayload | null;
};

type ProfileRow = {
  account_id: string;
  profile_schema_version: number;
  credential_version: number;
  access_level: AccessLevel;
  provider_type: string;
  profile_json: string;
  profile_fingerprint: string;
  last_check_status: CheckStatus;
  last_check_at: string | null;
  last_successful_checked_at: string | null;
  last_check_code: string | null;
  last_check_message: string | null;
  updated_at: string;
};

const SECRET_NAME =
  /^(?:access[_-]?token|bot[_-]?token|token|refresh[_-]?token|client[_-]?secret|authorization[_-]?code|code_verifier|secret|password)$/i;
const SECRET_ASSIGNMENT =
  /\b(access[_-]?token|bot[_-]?token|token|refresh[_-]?token|client[_-]?secret|authorization[_-]?code|code_verifier|secret|password)(\s*[:=]\s*)([^\s&,;]+)/gi;
const BEARER = /(\bBearer\s+)([^\s,;]+)/gi;
const MAX_DIAGNOSTIC_TEXT = 2000;

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_NAME.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    url.pathname = url.pathname
      .replace(/\/bot\d{5,}:[A-Za-z0-9_-]{10,}/gi, '/bot[REDACTED]')
      .replace(/\/(?:token|secret|access[_-]?token)\/[^/]+/gi, (segment) => {
        const prefix = segment.slice(0, segment.lastIndexOf('/') + 1);
        return `${prefix}[REDACTED]`;
      });
    if (url.hash) url.hash = url.hash.replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`);
    return url.toString();
  } catch {
    return raw;
  }
}

export function sanitizeCapabilityText(value: unknown, maxLength = MAX_DIAGNOSTIC_TEXT): string {
  let text = String(value ?? '');
  text = text.replace(/https?:\/\/[^\s<>"')]+/gi, (url) => sanitizeUrl(url));
  text = text.replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`);
  text = text.replace(BEARER, '$1[REDACTED]');
  return text.trim().slice(0, maxLength);
}

function safeNullableText(value: unknown, maxLength = MAX_DIAGNOSTIC_TEXT): string | null {
  const text = sanitizeCapabilityText(value, maxLength);
  return text || null;
}

function uniqueSortedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => sanitizeCapabilityText(item, 512))
    .filter(Boolean))]
    .sort(stableCompare);
}

function normalizeProviderType(value: unknown): string {
  const normalized = String(value ?? 'UNKNOWN').trim().toUpperCase();
  return /^[A-Z0-9_:-]{1,64}$/.test(normalized) ? normalized : 'UNKNOWN';
}

function normalizeCredential(value: unknown): CapabilityCredentialEvidence {
  const row = recordValue(value);
  const validity = ['CONFIRMED', 'INVALID', 'UNAVAILABLE', 'UNKNOWN'].includes(String(row.validity))
    ? String(row.validity) as CredentialValidity
    : 'UNKNOWN';
  return {
    validity,
    identity: safeNullableText(row.identity, 512),
    ownerId: safeNullableText(row.ownerId, 256),
    expiresAt: safeNullableText(row.expiresAt, 128),
    declaredPermissions: uniqueSortedStrings(row.declaredPermissions),
    permissionsSource: safeNullableText(row.permissionsSource, 256)
  };
}

function normalizeDestination(value: unknown): CapabilityDestinationEvidence | null {
  if (value === null || value === undefined) return null;
  const row = recordValue(value);
  const resolutionState = ['CONFIRMED', 'UNAVAILABLE', 'UNKNOWN', 'DENIED'].includes(String(row.resolutionState))
    ? String(row.resolutionState) as CapabilityDestinationEvidence['resolutionState']
    : 'UNKNOWN';
  return {
    resolutionState,
    kind: safeNullableText(row.kind, 128),
    id: safeNullableText(row.id, 512),
    name: safeNullableText(row.name, 512),
    role: safeNullableText(row.role, 128),
    ownershipConfirmed: typeof row.ownershipConfirmed === 'boolean' ? row.ownershipConfirmed : null
  };
}

function normalizeMethods(value: unknown): CapabilityMethodEvidence[] {
  if (!Array.isArray(value)) return [];
  const allowedStates = new Set<MethodState>([
    'CONFIRMED', 'DENIED', 'UNAVAILABLE', 'NOT_CHECKED',
    'NOT_SUPPORTED_FOR_CREDENTIAL_TYPE', 'SETUP_REQUIRED', 'NOT_IMPLEMENTED_IN_PUBLIKATOR'
  ]);
  const methods: CapabilityMethodEvidence[] = [];
  for (const item of value) {
    const row = recordValue(item);
    const method = sanitizeCapabilityText(row.method, 256);
    if (!method) continue;
    const rawState = String(row.state ?? 'NOT_CHECKED') as MethodState;
    methods.push({
      method,
      state: allowedStates.has(rawState) ? rawState : 'NOT_CHECKED',
      evidenceSource: safeNullableText(row.evidenceSource, 256),
      machineCode: safeNullableText(row.machineCode, 128),
      reason: sanitizeCapabilityText(row.reason, 1000)
    });
  }
  return methods.sort((left, right) => stableCompare(left.method, right.method));
}

function normalizeAction(value: unknown): RemediationAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const rawKind = String(row.kind ?? '');
  if (!['INTERNAL_ROUTE', 'OFFICIAL_HELP_URL', 'RECHECK'].includes(rawKind)) return null;
  const target = safeNullableText(row.target, 1000);
  return {
    label: sanitizeCapabilityText(row.label, 256),
    kind: rawKind as RemediationAction['kind'],
    target: rawKind === 'OFFICIAL_HELP_URL' && target ? sanitizeUrl(target) : target
  };
}

function normalizeRemediation(value: unknown): CapabilityRemediation[] {
  if (!Array.isArray(value)) return [];
  const rows: CapabilityRemediation[] = [];
  for (const item of value) {
    const row = recordValue(item);
    const code = sanitizeCapabilityText(row.code, 128);
    if (!code) continue;
    const secondary = Array.isArray(row.secondaryActions)
      ? row.secondaryActions.map(normalizeAction).filter((entry): entry is RemediationAction => Boolean(entry))
      : [];
    rows.push({
      code,
      title: sanitizeCapabilityText(row.title, 512),
      explanation: sanitizeCapabilityText(row.explanation, 1500),
      requiredCredentialType: safeNullableText(row.requiredCredentialType, 128),
      requiredPermissions: uniqueSortedStrings(row.requiredPermissions),
      steps: Array.isArray(row.steps)
        ? row.steps.filter((step): step is string => typeof step === 'string')
          .map((step) => sanitizeCapabilityText(step, 1000)).filter(Boolean)
        : [],
      primaryAction: normalizeAction(row.primaryAction),
      secondaryActions: secondary
    });
  }
  return rows.sort((left, right) => stableCompare(left.code, right.code));
}

function emptyReadiness(state: PublicationReadinessState, reason = ''): CapabilityReadiness {
  return { state, reason, requiredMethods: [], remediationCodes: [] };
}

function normalizedPublicationEvidence(
  value: Partial<Record<PublicationFormat, ProviderPublicationEvidence>> | undefined
): Partial<Record<PublicationFormat, ProviderPublicationEvidence>> {
  const result: Partial<Record<PublicationFormat, ProviderPublicationEvidence>> = {};
  for (const format of PUBLICATION_FORMATS) {
    const row = value?.[format];
    if (!row) continue;
    const state = ['CONFIRMED', 'DENIED', 'SETUP_REQUIRED', 'UNKNOWN', 'UNAVAILABLE'].includes(String(row.state))
      ? row.state
      : 'UNKNOWN';
    result[format] = {
      state,
      requiredMethods: uniqueSortedStrings(row.requiredMethods),
      remediationCodes: uniqueSortedStrings(row.remediationCodes),
      reason: sanitizeCapabilityText(row.reason, 1000)
    };
  }
  return result;
}

function normalizedRuntimePrerequisites(value: RuntimePrerequisiteEvidence[] | undefined): RuntimePrerequisiteEvidence[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => PUBLICATION_FORMATS.includes(item.format))
    .map((item) => ({
      format: item.format,
      state: ['CONFIRMED', 'MISSING', 'UNKNOWN', 'UNAVAILABLE'].includes(item.state) ? item.state : 'UNKNOWN',
      code: sanitizeCapabilityText(item.code, 128),
      remediationCode: safeNullableText(item.remediationCode, 128),
      reason: sanitizeCapabilityText(item.reason, 1000)
    }))
    .sort((left, right) => stableCompare(left.format, right.format) || stableCompare(left.code, right.code));
}

function buildReadiness(
  adapterCapability: Partial<Record<PublicationFormat, boolean>>,
  publicationEvidence: Partial<Record<PublicationFormat, ProviderPublicationEvidence>>,
  runtimePrerequisites: RuntimePrerequisiteEvidence[]
): Record<PublicationFormat, CapabilityReadiness> {
  const result = {} as Record<PublicationFormat, CapabilityReadiness>;
  for (const format of PUBLICATION_FORMATS) {
    if (adapterCapability[format] !== true) {
      result[format] = emptyReadiness('NOT_IMPLEMENTED', 'Publikator adapter does not implement this format.');
      continue;
    }

    const provider = publicationEvidence[format];
    if (!provider) {
      result[format] = emptyReadiness('UNKNOWN', 'Provider capability is not proven.');
      continue;
    }
    const requiredMethods = uniqueSortedStrings(provider.requiredMethods);
    const remediationCodes = uniqueSortedStrings(provider.remediationCodes);
    const reason = sanitizeCapabilityText(provider.reason, 1000);

    if (provider.state === 'DENIED') {
      result[format] = {
        state: remediationCodes.length ? 'SETUP_REQUIRED' : 'BLOCKED',
        reason,
        requiredMethods,
        remediationCodes
      };
      continue;
    }
    if (provider.state === 'SETUP_REQUIRED') {
      result[format] = { state: 'SETUP_REQUIRED', reason, requiredMethods, remediationCodes };
      continue;
    }
    if (provider.state === 'UNAVAILABLE') {
      result[format] = { state: 'UNAVAILABLE', reason, requiredMethods, remediationCodes };
      continue;
    }
    if (provider.state === 'UNKNOWN') {
      result[format] = { state: 'UNKNOWN', reason, requiredMethods, remediationCodes };
      continue;
    }

    const runtime = runtimePrerequisites.filter((item) => item.format === format);
    const runtimeCodes = uniqueSortedStrings(runtime.map((item) => item.remediationCode).filter(Boolean));
    if (runtime.some((item) => item.state === 'MISSING')) {
      result[format] = {
        state: 'SETUP_REQUIRED',
        reason: runtime.find((item) => item.state === 'MISSING')?.reason || 'Runtime prerequisite is missing.',
        requiredMethods,
        remediationCodes: uniqueSortedStrings([...remediationCodes, ...runtimeCodes])
      };
      continue;
    }
    if (runtime.some((item) => item.state === 'UNAVAILABLE')) {
      result[format] = {
        state: 'UNAVAILABLE',
        reason: runtime.find((item) => item.state === 'UNAVAILABLE')?.reason || 'Runtime prerequisite cannot be checked.',
        requiredMethods,
        remediationCodes
      };
      continue;
    }
    if (runtime.some((item) => item.state === 'UNKNOWN')) {
      result[format] = {
        state: 'UNKNOWN',
        reason: runtime.find((item) => item.state === 'UNKNOWN')?.reason || 'Runtime prerequisite is not proven.',
        requiredMethods,
        remediationCodes
      };
      continue;
    }
    result[format] = { state: 'READY', reason, requiredMethods, remediationCodes };
  }
  return result;
}

export function classifyAccessLevel(
  inspectionCompleted: boolean,
  credentialValidity: CredentialValidity,
  readiness: Record<PublicationFormat, CapabilityReadiness>,
  adapterCapability: Partial<Record<PublicationFormat, boolean>>
): AccessLevel {
  if (!inspectionCompleted) return 'UNCHECKED';
  if (credentialValidity === 'INVALID') return 'INVALID';
  if (credentialValidity === 'UNAVAILABLE' || credentialValidity === 'UNKNOWN') return 'UNAVAILABLE';

  const implemented = PUBLICATION_FORMATS.filter((format) => adapterCapability[format] === true);
  if (implemented.length === 0) return 'READ_ONLY';
  const states = implemented.map((format) => readiness[format].state);
  const ready = states.filter((state) => state === 'READY').length;
  if (ready === implemented.length) return 'FULL';
  if (ready > 0) return 'PARTIAL';
  if (states.includes('SETUP_REQUIRED')) return 'SETUP_REQUIRED';
  if (states.includes('UNAVAILABLE')) return 'UNAVAILABLE';
  return 'READ_ONLY';
}

export function accessLevelVerdict(accessLevel: AccessLevel): CredentialVerdict {
  if (accessLevel === 'FULL') return 'FULL';
  if (accessLevel === 'INVALID') return 'INVALID';
  if (accessLevel === 'UNCHECKED' || accessLevel === 'UNAVAILABLE') return 'UNCHECKED';
  return 'LIMITED';
}

export function buildCapabilityProfile(input: CapabilityBuildInput): BuiltCapabilityProfile {
  const credential = normalizeCredential(input.credential);
  const providerType = normalizeProviderType(input.providerType);
  const publicationEvidence = normalizedPublicationEvidence(input.publicationEvidence);
  const runtimePrerequisites = normalizedRuntimePrerequisites(input.runtimePrerequisites);
  const publicationReadiness = buildReadiness(input.adapterCapability, publicationEvidence, runtimePrerequisites);
  const accessLevel = classifyAccessLevel(
    input.inspectionCompleted,
    credential.validity,
    publicationReadiness,
    input.adapterCapability
  );
  const warnings = Array.isArray(input.warnings)
    ? input.warnings.filter((item): item is string => typeof item === 'string')
      .map((item) => sanitizeCapabilityText(item, 1000)).filter(Boolean)
    : [];
  return {
    providerType,
    accessLevel,
    verdict: accessLevelVerdict(accessLevel),
    semantic: {
      credential,
      destination: normalizeDestination(input.destination),
      methods: normalizeMethods(input.methods),
      publicationReadiness,
      remediation: normalizeRemediation(input.remediation),
      warnings
    }
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(row).sort().map((key) => [key, canonicalize(row[key])])
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function fingerprintProjection(
  credentialVersion: number,
  profile: BuiltCapabilityProfile
): Record<string, unknown> {
  const credential = profile.semantic.credential;
  const destination = profile.semantic.destination;
  return {
    profileSchemaVersion: CURRENT_CAPABILITY_PROFILE_VERSION,
    credentialVersion,
    accessLevel: profile.accessLevel,
    providerType: profile.providerType,
    credential: {
      validity: credential.validity,
      principalId: credential.ownerId || credential.identity,
      declaredPermissions: credential.declaredPermissions,
      permissionsSource: credential.permissionsSource
    },
    destination: destination ? {
      resolutionState: destination.resolutionState,
      kind: destination.kind,
      routingId: destination.id || destination.name,
      role: destination.role,
      ownershipConfirmed: destination.ownershipConfirmed
    } : null,
    methods: profile.semantic.methods.map((method) => ({
      method: method.method,
      state: method.state,
      evidenceSource: method.evidenceSource,
      machineCode: method.machineCode
    })),
    publicationReadiness: Object.fromEntries(PUBLICATION_FORMATS.map((format) => [
      format,
      {
        state: profile.semantic.publicationReadiness[format].state,
        requiredMethods: profile.semantic.publicationReadiness[format].requiredMethods,
        remediationCodes: profile.semantic.publicationReadiness[format].remediationCodes
      }
    ]))
  };
}

export function capabilityFingerprint(credentialVersion: number, profile: BuiltCapabilityProfile): string {
  return crypto.createHash('sha256')
    .update(stableJson(fingerprintProjection(credentialVersion, profile)))
    .digest('hex');
}

function normalizeStoredSemantic(value: unknown): CapabilitySemanticPayload {
  const row = recordValue(value);
  const readinessRow = recordValue(row.publicationReadiness);
  const publicationReadiness = {} as Record<PublicationFormat, CapabilityReadiness>;
  const states = new Set<PublicationReadinessState>([
    'READY', 'BLOCKED', 'SETUP_REQUIRED', 'NOT_IMPLEMENTED', 'UNKNOWN', 'UNAVAILABLE'
  ]);
  for (const format of PUBLICATION_FORMATS) {
    const item = recordValue(readinessRow[format]);
    const rawState = String(item.state ?? 'UNKNOWN') as PublicationReadinessState;
    publicationReadiness[format] = {
      state: states.has(rawState) ? rawState : 'UNKNOWN',
      reason: sanitizeCapabilityText(item.reason, 1000),
      requiredMethods: uniqueSortedStrings(item.requiredMethods),
      remediationCodes: uniqueSortedStrings(item.remediationCodes)
    };
  }
  return {
    credential: normalizeCredential(row.credential),
    destination: normalizeDestination(row.destination),
    methods: normalizeMethods(row.methods),
    publicationReadiness,
    remediation: normalizeRemediation(row.remediation),
    warnings: Array.isArray(row.warnings)
      ? row.warnings.filter((item): item is string => typeof item === 'string')
        .map((item) => sanitizeCapabilityText(item, 1000)).filter(Boolean)
      : []
  };
}

function accountCredentialVersion(accountId: string): number {
  const row = db.prepare('SELECT credential_version FROM social_accounts WHERE id=?')
    .get(accountId) as { credential_version: number } | undefined;
  if (!row) throw new Error('Social account not found');
  return Number(row.credential_version);
}

function defaultUncheckedView(
  accountId: string,
  credentialVersion: number,
  row?: ProfileRow
): CapabilityProfileView {
  return {
    accountId,
    profileCurrent: false,
    profileVersion: CURRENT_CAPABILITY_PROFILE_VERSION,
    credentialVersion,
    providerType: 'UNKNOWN',
    accessLevel: 'UNCHECKED',
    verdict: 'UNCHECKED',
    profileFingerprint: null,
    checkedAt: row?.last_check_at ?? null,
    lastSuccessfulCheckedAt: row?.last_successful_checked_at ?? null,
    lastCheckStatus: row?.last_check_status ?? 'UNCHECKED',
    lastCheckCode: row?.last_check_code ?? null,
    lastCheckMessage: row?.last_check_message ?? null,
    semantic: null
  };
}

export function readCapabilityProfile(accountId: string): CapabilityProfileView {
  const credentialVersion = accountCredentialVersion(accountId);
  const row = db.prepare('SELECT * FROM social_account_capability_profiles WHERE account_id=?')
    .get(accountId) as ProfileRow | undefined;
  if (!row) return defaultUncheckedView(accountId, credentialVersion);

  if (
    row.profile_schema_version !== CURRENT_CAPABILITY_PROFILE_VERSION ||
    row.credential_version !== credentialVersion
  ) {
    return defaultUncheckedView(accountId, credentialVersion, row);
  }

  try {
    const parsed = JSON.parse(row.profile_json) as unknown;
    const semantic = normalizeStoredSemantic(parsed);
    if (stableJson(parsed) !== stableJson(semantic)) {
      return defaultUncheckedView(accountId, credentialVersion, row);
    }
    const built: BuiltCapabilityProfile = {
      providerType: normalizeProviderType(row.provider_type),
      accessLevel: row.access_level,
      verdict: accessLevelVerdict(row.access_level),
      semantic
    };
    const fingerprint = capabilityFingerprint(credentialVersion, built);
    if (fingerprint !== row.profile_fingerprint) {
      return defaultUncheckedView(accountId, credentialVersion, row);
    }
    return {
      accountId,
      profileCurrent: true,
      profileVersion: row.profile_schema_version,
      credentialVersion,
      providerType: built.providerType,
      accessLevel: built.accessLevel,
      verdict: built.verdict,
      profileFingerprint: fingerprint,
      checkedAt: row.last_check_at,
      lastSuccessfulCheckedAt: row.last_successful_checked_at,
      lastCheckStatus: row.last_check_status,
      lastCheckCode: row.last_check_code,
      lastCheckMessage: row.last_check_message,
      semantic
    };
  } catch {
    return defaultUncheckedView(accountId, credentialVersion, row);
  }
}

function normalizedCheckStatus(built: BuiltCapabilityProfile): CheckStatus {
  if (built.accessLevel === 'INVALID') return 'INVALID';
  if (built.accessLevel === 'UNAVAILABLE') return 'UNAVAILABLE';
  if (built.accessLevel === 'UNCHECKED') return 'UNCHECKED';
  return 'SUCCESS';
}

export function saveCapabilityProfile(accountId: string, input: CapabilitySaveInput): CapabilityProfileView {
  const credentialVersion = accountCredentialVersion(accountId);
  const built = buildCapabilityProfile(input);
  const profileFingerprint = capabilityFingerprint(credentialVersion, built);
  const profileJson = JSON.stringify(built.semantic);
  const checkStatus = normalizedCheckStatus(built);
  const checkedAt = input.checkedAt ?? nowIso();
  const previous = db.prepare('SELECT last_successful_checked_at FROM social_account_capability_profiles WHERE account_id=?')
    .get(accountId) as { last_successful_checked_at: string | null } | undefined;
  const lastSuccessfulCheckedAt = checkStatus === 'SUCCESS'
    ? checkedAt
    : input.lastSuccessfulCheckedAt ?? previous?.last_successful_checked_at ?? null;
  const lastCheckCode = safeNullableText(input.lastCheckCode, 128);
  const lastCheckMessage = safeNullableText(input.lastCheckMessage, 1000);
  const updatedAt = nowIso();

  db.prepare(`INSERT INTO social_account_capability_profiles (
      account_id,profile_schema_version,credential_version,access_level,provider_type,
      profile_json,profile_fingerprint,last_check_status,last_check_at,last_successful_checked_at,
      last_check_code,last_check_message,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET
      profile_schema_version=excluded.profile_schema_version,
      credential_version=excluded.credential_version,
      access_level=excluded.access_level,
      provider_type=excluded.provider_type,
      profile_json=excluded.profile_json,
      profile_fingerprint=excluded.profile_fingerprint,
      last_check_status=excluded.last_check_status,
      last_check_at=excluded.last_check_at,
      last_successful_checked_at=excluded.last_successful_checked_at,
      last_check_code=excluded.last_check_code,
      last_check_message=excluded.last_check_message,
      updated_at=excluded.updated_at`)
    .run(
      accountId,
      CURRENT_CAPABILITY_PROFILE_VERSION,
      credentialVersion,
      built.accessLevel,
      built.providerType,
      profileJson,
      profileFingerprint,
      checkStatus,
      checkedAt,
      lastSuccessfulCheckedAt,
      lastCheckCode,
      lastCheckMessage,
      updatedAt
    );

  return readCapabilityProfile(accountId);
}

export function recordCapabilityCheckUnavailable(
  accountId: string,
  code: string | null,
  message: string | null,
  checkedAt = nowIso()
): boolean {
  const credentialVersion = accountCredentialVersion(accountId);
  const result = db.prepare(`UPDATE social_account_capability_profiles
    SET last_check_status='UNAVAILABLE',last_check_at=?,last_check_code=?,last_check_message=?,updated_at=?
    WHERE account_id=? AND credential_version=? AND profile_schema_version=?`)
    .run(
      checkedAt,
      safeNullableText(code, 128),
      safeNullableText(message, 1000),
      nowIso(),
      accountId,
      credentialVersion,
      CURRENT_CAPABILITY_PROFILE_VERSION
    );
  return result.changes === 1;
}

export function replaceSocialAccountCredentials(accountId: string, encryptedCredentials: string): number {
  const encrypted = String(encryptedCredentials ?? '');
  if (!encrypted) throw new Error('Encrypted credentials must not be empty');
  return db.transaction(() => {
    const result = db.prepare(`UPDATE social_accounts
      SET credentials_encrypted=?,credential_version=credential_version+1,updated_at=?
      WHERE id=?`).run(encrypted, nowIso(), accountId);
    if (result.changes !== 1) throw new Error('Social account not found');
    db.prepare('DELETE FROM social_account_capability_profiles WHERE account_id=?').run(accountId);
    return accountCredentialVersion(accountId);
  })();
}
