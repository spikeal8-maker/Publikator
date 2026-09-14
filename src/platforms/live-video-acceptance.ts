import type { Platform } from '../db.js';

export const LIVE_VIDEO_CONFIRMATION = 'I_UNDERSTAND_THIS_WILL_PUBLISH_EXTERNALLY';
export const LIVE_VIDEO_VISIBILITY_CONFIRMATION = 'I_VERIFIED_THE_VIDEO_IS_VISIBLE';

export const LIVE_VIDEO_CREDENTIAL_FIELDS: Record<Platform, readonly string[]> = {
  telegram: ['botToken', 'chatId'],
  vk: ['accessToken', 'groupId'],
  max: ['accessToken', 'chatId'],
  instagram: ['accessToken', 'igUserId', 'graphVersion']
};

export type LiveVideoMediaFingerprint = {
  mediaId: string;
  originalName: string;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  container: string;
};

export type LiveVideoAcceptanceEvidence = {
  schemaVersion: 1;
  checkpoint: 'CX3-008F';
  status: 'API_CONFIRMED' | 'PASSED';
  runId: string;
  platform: Platform;
  publicationKind: 'FEED';
  contentFormat: 'VIDEO';
  startedAt: string;
  completedAt: string;
  buildSha: string;
  account: {
    id: string;
    name: string;
  };
  connection: {
    identity: string;
    destination: string;
  };
  media: LiveVideoMediaFingerprint;
  transport: {
    publicVideoUrl: string | null;
  };
  result: {
    externalId: string;
    externalUrl: string | null;
  };
  visibility: {
    confirmedAt: string | null;
    note: string | null;
  };
};

export function assertLiveCredentialShape(platform: Platform, credentials: Record<string, unknown>): void {
  for (const field of LIVE_VIDEO_CREDENTIAL_FIELDS[platform]) {
    const value = credentials[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`CX3-008F ${platform}: сохранённые credentials должны содержать непустое поле ${field}`);
    }
  }
}

export function assertLivePublishGuard(params: { publish: boolean; confirmation?: string | null }): void {
  if (!params.publish) {
    throw new Error('CX3-008F: реальная публикация разрешена только с флагом --publish');
  }
  if (params.confirmation !== LIVE_VIDEO_CONFIRMATION) {
    throw new Error(`CX3-008F: перед реальной публикацией задайте PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM=${LIVE_VIDEO_CONFIRMATION}`);
  }
}

export function assertLiveVisibilityGuard(params: { confirmVisible: boolean; confirmation?: string | null }): void {
  if (!params.confirmVisible) {
    throw new Error('CX3-008F: ручное подтверждение видимости разрешено только с флагом --confirm-visible');
  }
  if (params.confirmation !== LIVE_VIDEO_VISIBILITY_CONFIRMATION) {
    throw new Error(`CX3-008F: перед PASS задайте PUBLIKATOR_LIVE_VISIBILITY_CONFIRM=${LIVE_VIDEO_VISIBILITY_CONFIRMATION}`);
  }
}

function assertIsoDate(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`CX3-008F evidence: ${field} должен быть ISO timestamp`);
}

function assertBuildSha(value: string): void {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error('CX3-008F evidence: buildSha должен быть полным 40-символьным Git SHA');
  }
}

function assertMediaFingerprint(media: LiveVideoMediaFingerprint): void {
  if (!media || typeof media !== 'object') throw new Error('CX3-008F evidence: media fingerprint отсутствует');
  if (!media.mediaId.trim()) throw new Error('CX3-008F evidence: mediaId отсутствует');
  if (!media.originalName.trim()) throw new Error('CX3-008F evidence: originalName отсутствует');
  if (!Number.isInteger(media.sizeBytes) || media.sizeBytes <= 0) throw new Error('CX3-008F evidence: sizeBytes должен быть положительным integer');
  if (!/^[a-f0-9]{64}$/i.test(media.sha256)) throw new Error('CX3-008F evidence: sha256 должен содержать 64 hex символа');
  if (!Number.isFinite(media.width) || media.width <= 0 || !Number.isFinite(media.height) || media.height <= 0) {
    throw new Error('CX3-008F evidence: dimensions должны быть положительными');
  }
  if (!Number.isFinite(media.durationMs) || media.durationMs <= 0) throw new Error('CX3-008F evidence: durationMs должен быть положительным');
  if (!Number.isFinite(media.fps) || media.fps <= 0) throw new Error('CX3-008F evidence: fps должен быть положительным');
  if (!media.videoCodec.trim()) throw new Error('CX3-008F evidence: videoCodec отсутствует');
  if (!media.container.trim()) throw new Error('CX3-008F evidence: container отсутствует');
}

function normalizedPublicUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('CX3-008F evidence: publicVideoUrl должен быть HTTPS URL без credentials');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function buildLiveVideoAcceptanceEvidence(params: {
  runId: string;
  platform: Platform;
  startedAt: string;
  completedAt: string;
  buildSha: string;
  account: { id: string; name: string };
  connection: { identity: string; destination: string };
  media: LiveVideoMediaFingerprint;
  publicVideoUrl?: string | null;
  externalId: string;
  externalUrl?: string | null;
}): LiveVideoAcceptanceEvidence {
  if (!params.runId.trim()) throw new Error('CX3-008F evidence: runId отсутствует');
  if (!['telegram', 'vk', 'max', 'instagram'].includes(params.platform)) throw new Error('CX3-008F evidence: неизвестная platform');
  assertIsoDate(params.startedAt, 'startedAt');
  assertIsoDate(params.completedAt, 'completedAt');
  const buildSha = params.buildSha.trim().toLowerCase();
  assertBuildSha(buildSha);
  if (!params.account.id.trim()) throw new Error('CX3-008F evidence: account.id отсутствует');
  if (!params.account.name.trim()) throw new Error('CX3-008F evidence: account.name отсутствует');
  if (!params.connection.identity.trim()) throw new Error('CX3-008F evidence: connection.identity отсутствует');
  if (!params.connection.destination.trim()) throw new Error('CX3-008F evidence: connection.destination отсутствует');
  assertMediaFingerprint(params.media);
  if (!params.externalId.trim()) throw new Error('CX3-008F evidence: externalId отсутствует');

  return {
    schemaVersion: 1,
    checkpoint: 'CX3-008F',
    status: 'API_CONFIRMED',
    runId: params.runId.trim(),
    platform: params.platform,
    publicationKind: 'FEED',
    contentFormat: 'VIDEO',
    startedAt: new Date(params.startedAt).toISOString(),
    completedAt: new Date(params.completedAt).toISOString(),
    buildSha,
    account: {
      id: params.account.id.trim(),
      name: params.account.name.trim()
    },
    connection: {
      identity: params.connection.identity.trim(),
      destination: params.connection.destination.trim()
    },
    media: { ...params.media },
    transport: {
      publicVideoUrl: normalizedPublicUrl(params.publicVideoUrl)
    },
    result: {
      externalId: params.externalId.trim(),
      externalUrl: params.externalUrl?.trim() || null
    },
    visibility: {
      confirmedAt: null,
      note: null
    }
  };
}

export function confirmLiveVideoAcceptanceEvidence(
  evidence: LiveVideoAcceptanceEvidence,
  params: { confirmedAt: string; note?: string | null }
): LiveVideoAcceptanceEvidence {
  const checked = validateLiveVideoAcceptanceEvidence(evidence);
  if (checked.status === 'PASSED') throw new Error('CX3-008F evidence: видимость уже подтверждена');
  assertIsoDate(params.confirmedAt, 'visibility.confirmedAt');
  const note = params.note?.trim() || null;
  if (note && note.length > 2000) throw new Error('CX3-008F evidence: visibility note не должна превышать 2000 символов');
  return {
    ...checked,
    status: 'PASSED',
    visibility: {
      confirmedAt: new Date(params.confirmedAt).toISOString(),
      note
    }
  };
}

export function validateLiveVideoAcceptanceEvidence(value: unknown): LiveVideoAcceptanceEvidence {
  if (!value || typeof value !== 'object') throw new Error('CX3-008F evidence: ожидается JSON object');
  const evidence = value as Partial<LiveVideoAcceptanceEvidence>;
  if (evidence.schemaVersion !== 1 || evidence.checkpoint !== 'CX3-008F' || !['API_CONFIRMED', 'PASSED'].includes(String(evidence.status))) {
    throw new Error('CX3-008F evidence: неверная schema/checkpoint/status');
  }
  if (!['telegram', 'vk', 'max', 'instagram'].includes(String(evidence.platform))) {
    throw new Error('CX3-008F evidence: неизвестная platform');
  }
  if (evidence.publicationKind !== 'FEED' || evidence.contentFormat !== 'VIDEO') {
    throw new Error('CX3-008F evidence: допускается только FEED/VIDEO');
  }
  if (!evidence.account || !evidence.connection || !evidence.media || !evidence.transport || !evidence.result || !evidence.visibility) {
    throw new Error('CX3-008F evidence: обязательные секции отсутствуют');
  }

  const base = buildLiveVideoAcceptanceEvidence({
    runId: String(evidence.runId || ''),
    platform: evidence.platform as Platform,
    startedAt: String(evidence.startedAt || ''),
    completedAt: String(evidence.completedAt || ''),
    buildSha: String(evidence.buildSha || ''),
    account: {
      id: String(evidence.account.id || ''),
      name: String(evidence.account.name || '')
    },
    connection: {
      identity: String(evidence.connection.identity || ''),
      destination: String(evidence.connection.destination || '')
    },
    media: evidence.media as LiveVideoMediaFingerprint,
    publicVideoUrl: evidence.transport.publicVideoUrl ?? null,
    externalId: String(evidence.result.externalId || ''),
    externalUrl: evidence.result.externalUrl ?? null
  });

  if (evidence.status === 'API_CONFIRMED') {
    if (evidence.visibility.confirmedAt !== null || evidence.visibility.note !== null) {
      throw new Error('CX3-008F evidence: API_CONFIRMED не должен содержать visibility confirmation');
    }
    return base;
  }

  if (!evidence.visibility.confirmedAt) throw new Error('CX3-008F evidence: PASSED требует visibility.confirmedAt');
  assertIsoDate(evidence.visibility.confirmedAt, 'visibility.confirmedAt');
  const note = evidence.visibility.note?.trim() || null;
  if (note && note.length > 2000) throw new Error('CX3-008F evidence: visibility note не должна превышать 2000 символов');
  return {
    ...base,
    status: 'PASSED',
    visibility: {
      confirmedAt: new Date(evidence.visibility.confirmedAt).toISOString(),
      note
    }
  };
}
