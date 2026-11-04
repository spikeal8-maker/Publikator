/**
 * AGENT-A1b2a: exact version-1 grant presets and a defensive owner input
 * normalizer. The JSON contract remains the product authority; the focused
 * regression compares this runtime table with its published snapshot.
 *
 * PREAPPROVED_POLICY is deliberately not activated here. A5b's persisted
 * per-target quotas and execution-time policy/consent gates are prerequisites.
 */
import { AgentRegistryError } from './agent-registry-error.js';

export const AGENT_PRESET_VERSION = 1;
export const AGENT_SCOPES = [
  'projects:read', 'accounts:read', 'sources:read', 'media:read',
  'media:import', 'posts:read', 'posts:write', 'posts:preview',
  'approval:request', 'schedule:write', 'publish:request',
  'jobs:read', 'events:read'
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];
export type AgentPreset = 'OBSERVER' | 'LIMITED' | 'EXTENDED' | 'FULL_CONTENT' | 'CUSTOM';
export type ActivePublishMode = 'DRAFT_ONLY' | 'OWNER_APPROVAL';

const OBSERVER: AgentScope[] = [
  'projects:read','accounts:read','sources:read','media:read',
  'posts:read','jobs:read','events:read'
];
const LIMITED: AgentScope[] = [
  ...OBSERVER,'media:import','posts:write','posts:preview','approval:request'
];
const EXTENDED: AgentScope[] = [...LIMITED,'schedule:write','publish:request'];

export const AGENT_PRESETS: Record<AgentPreset, readonly AgentScope[]> = {
  OBSERVER, LIMITED, EXTENDED, FULL_CONTENT: EXTENDED, CUSTOM: []
};

const AGENT_PRESET_MODES: Record<AgentPreset, readonly string[]> = {
  OBSERVER: ['DRAFT_ONLY'],
  LIMITED: ['DRAFT_ONLY'],
  EXTENDED: ['DRAFT_ONLY', 'OWNER_APPROVAL'],
  FULL_CONTENT: ['DRAFT_ONLY', 'OWNER_APPROVAL', 'PREAPPROVED_POLICY'],
  CUSTOM: ['DRAFT_ONLY', 'OWNER_APPROVAL', 'PREAPPROVED_POLICY']
};

export function getAgentPresetModes(id: AgentPreset): readonly string[] {
  return AGENT_PRESET_MODES[id];
}

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const ALL_SCOPES: ReadonlySet<string> = new Set(AGENT_SCOPES);
const PRESETS: ReadonlySet<string> = new Set(Object.keys(AGENT_PRESETS));

export type NormalizedOwnerGrant = {
  expectedGrantVersion: number;
  presetId: AgentPreset;
  publishMode: ActivePublishMode;
  scopeIds: string[];
  projectIds: string[];
  accountIds: string[];
  sourceConnectorIds: string[];
  confirmElevation: boolean;
};

function fail(message: string, status = 400, code = 'VALIDATION_ERROR'): never {
  throw new AgentRegistryError(code, message, status);
}

function ids(value: unknown, field: string, max: number, allowed?: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length > max) {
    fail('Некорректный список: ' + field);
  }
  const collected: string[] = [];
  for (const v of value as unknown[]) {
    if (typeof v !== 'string' || !IDENTIFIER.test(v) || (allowed && !allowed.has(v))) {
      fail('Недопустимый идентификатор в ' + field);
    }
    collected.push(v);
  }
  const canonical = [...new Set(collected)].sort();
  if (canonical.length !== collected.length) {
    fail('Повторяющиеся идентификаторы в ' + field);
  }
  return canonical;
}

export function normalizeOwnerGrantUpdate(value: unknown): NormalizedOwnerGrant {
  if (typeof value !== 'object' || !value || Array.isArray(value)) {
    fail('Ожидается объект разрешений.');
  }
  const input = value as Record<string, unknown>;
  const known = new Set([
    'expectedGrantVersion','presetId','publishMode','scopeIds',
    'projectIds','accountIds','sourceConnectorIds','confirmElevation',
    'preapprovedPolicy','policyExpiresAt'
  ]);
  if (Object.keys(input).some(k => !known.has(k))) {
    fail('Неизвестные поля управления доступом.');
  }
  if (!Number.isSafeInteger(input.expectedGrantVersion)
    || Number(input.expectedGrantVersion) < 1) {
    fail('Требуется expectedGrantVersion >= 1.');
  }
  if (typeof input.presetId !== 'string' || !PRESETS.has(input.presetId)) {
    fail('Неизвестный уровень доступа.');
  }
  const presetId = input.presetId as AgentPreset;
  if (input.publishMode === 'PREAPPROVED_POLICY') {
    fail('Автоматическая публикация появится после внедрения проверки квот и согласований.',
      409, 'POLICY_DENIED');
  }
  if (input.publishMode !== 'DRAFT_ONLY' && input.publishMode !== 'OWNER_APPROVAL') {
    fail('Неизвестный режим публикации.');
  }
  const publishMode = input.publishMode as ActivePublishMode;
  if (!AGENT_PRESET_MODES[presetId].includes(publishMode)) {
    fail('Режим публикации несовместим с выбранным уровнем.', 403, 'POLICY_DENIED');
  }
  if (input.preapprovedPolicy !== undefined || input.policyExpiresAt !== undefined) {
    fail('Управление автоматической политикой и сроком действия ещё не включено.',
      409, 'POLICY_DENIED');
  }
  if (input.confirmElevation !== undefined && typeof input.confirmElevation !== 'boolean') {
    fail('confirmElevation должен быть логическим значением.');
  }
  const projectIds = ids(input.projectIds, 'projectIds', 100);
  const accountIds = ids(input.accountIds, 'accountIds', 100);
  const sourceConnectorIds = ids(input.sourceConnectorIds, 'sourceConnectorIds', 100);
  let scopeIds: string[];
  if (presetId === 'CUSTOM') {
    scopeIds = ids(input.scopeIds, 'scopeIds', 30, ALL_SCOPES);
  } else {
    const fixed = [...AGENT_PRESETS[presetId]].sort();
    if (input.scopeIds !== undefined) {
      const supplied = ids(input.scopeIds, 'scopeIds', 30, ALL_SCOPES);
      if (JSON.stringify(supplied) !== JSON.stringify(fixed)) {
        fail('Нельзя переопределять права готового уровня.', 403, 'POLICY_DENIED');
      }
    }
    scopeIds = fixed;
  }
  if (publishMode === 'OWNER_APPROVAL'
    && (!scopeIds.includes('approval:request') || !scopeIds.includes('publish:request'))) {
    fail('Для отправки после подтверждения не хватает обязательных scopes.',
      403, 'POLICY_DENIED');
  }
  return {
    expectedGrantVersion: Number(input.expectedGrantVersion), presetId, publishMode,
    scopeIds, projectIds, accountIds, sourceConnectorIds,
    confirmElevation: input.confirmElevation === true
  };
}

export function expandsGrantPermissions(
  before: {
    scopeIds: string[]; projectIds: string[]; accountIds: string[];
    sourceConnectorIds: string[]; publishMode: string;
  },
  after: NormalizedOwnerGrant
): boolean {
  for (const field of ['scopeIds','projectIds','accountIds','sourceConnectorIds'] as const) {
    const previous = new Set(before[field]);
    if (after[field].some(id => !previous.has(id))) return true;
  }
  return before.publishMode === 'DRAFT_ONLY' && after.publishMode !== 'DRAFT_ONLY';
}

export function hasGrantDifference(
  before: {
    presetId: string; presetVersion: number; publishMode: string;
    scopeIds: string[]; projectIds: string[]; accountIds: string[];
    sourceConnectorIds: string[];
  },
  after: NormalizedOwnerGrant
): boolean {
  if (before.presetId !== after.presetId || before.presetVersion !== AGENT_PRESET_VERSION
    || before.publishMode !== after.publishMode) return true;
  for (const field of ['scopeIds','projectIds','accountIds','sourceConnectorIds'] as const) {
    if (JSON.stringify([...before[field]].sort()) !== JSON.stringify(after[field])) return true;
  }
  return false;
}
