import type { Platform } from '../db.js';

export const LIVE_VIDEO_CONFIRMATION = 'I_UNDERSTAND_THIS_WILL_PUBLISH_EXTERNALLY';

export const LIVE_VIDEO_CREDENTIAL_FIELDS: Record<Platform, readonly string[]> = {
  telegram: ['botToken', 'chatId'],
  vk: ['accessToken', 'groupId'],
  max: ['accessToken', 'chatId'],
  instagram: ['accessToken', 'igUserId', 'graphVersion']
};

export type LiveVideoMediaFingerprint = {
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
  status: 'PASSED';
  runId: string;
  platform: Platform;
  publicationKind: 'FEED';
  contentFormat: 'VIDEO';
  startedAt: string;
  completedAt: string;
  buildSha: string | null;
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
};

export function assertLiveCredentialShape(platform: Platform, credentials: Record<string, unknown>): void {
  for (const field of LIVE_VIDEO_CREDENTIAL_FIELDS[platform]) {
    const value = credentials[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`CX3-008F ${platform}: credentials file должен содержать непустое поле ${field}`);
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

function assertIsoDate(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`CX3-008F evidence: ${field} должен быть ISO timestamp`);
}

function assertBuildSha(value: string | null): void {
  if (value != null && !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error('CX3-008F evidence: buildSha должен быть 40-символьным Git SHA или null');
  }
}

function assertMediaFingerprint(media: LiveVideoMediaFingerprint): void {
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

export function buildLiveVideoAcceptanceEvidence(params: {
  runId: string;
  platform: Platform;
  startedAt: string;
  completedAt: string;
  buildSha?: string | null;
  connection: { identity: string; destination: string };
  media: LiveVideoMediaFingerprint;
  publicVideoUrl?: string | null;
  externalId: string;
  externalUrl?: string | null;
}): LiveVideoAcceptanceEvidence {
  if (!params.runId.trim()) throw new Error('CX3-008F evidence: runId отсутствует');
  assertIsoDate(params.startedAt, 'startedAt');
  assertIsoDate(params.completedAt, 'completedAt');
  const buildSha = params.buildSha?.trim().toLowerCase() || null;
  assertBuildSha(buildSha);
  if (!params.connection.identity.trim()) throw new Error('CX3-008F evidence: connection.identity отсутствует');
  if (!params.connection.destination.trim()) throw new Error('CX3-008F evidence: connection.destination отсутствует');
  assertMediaFingerprint(params.media);
  if (!params.externalId.trim()) throw new Error('CX3-008F evidence: externalId отсутствует');

  return {
    schemaVersion: 1,
    checkpoint: 'CX3-008F',
    status: 'PASSED',
    runId: params.runId.trim(),
    platform: params.platform,
    publicationKind: 'FEED',
    contentFormat: 'VIDEO',
    startedAt: new Date(params.startedAt).toISOString(),
    completedAt: new Date(params.completedAt).toISOString(),
    buildSha,
    connection: {
      identity: params.connection.identity.trim(),
      destination: params.connection.destination.trim()
    },
    media: { ...params.media },
    transport: {
      publicVideoUrl: params.publicVideoUrl?.trim() || null
    },
    result: {
      externalId: params.externalId.trim(),
      externalUrl: params.externalUrl?.trim() || null
    }
  };
}

export function validateLiveVideoAcceptanceEvidence(value: unknown): LiveVideoAcceptanceEvidence {
  if (!value || typeof value !== 'object') throw new Error('CX3-008F evidence: ожидается JSON object');
  const evidence = value as Partial<LiveVideoAcceptanceEvidence>;
  if (evidence.schemaVersion !== 1 || evidence.checkpoint !== 'CX3-008F' || evidence.status !== 'PASSED') {
    throw new Error('CX3-008F evidence: неверная schema/checkpoint/status');
  }
  if (!['telegram', 'vk', 'max', 'instagram'].includes(String(evidence.platform))) {
    throw new Error('CX3-008F evidence: неизвестная platform');
  }
  if (evidence.publicationKind !== 'FEED' || evidence.contentFormat !== 'VIDEO') {
    throw new Error('CX3-008F evidence: допускается только FEED/VIDEO');
  }
  return buildLiveVideoAcceptanceEvidence({
    runId: String(evidence.runId || ''),
    platform: evidence.platform as Platform,
    startedAt: String(evidence.startedAt || ''),
    completedAt: String(evidence.completedAt || ''),
    buildSha: evidence.buildSha ?? null,
    connection: {
      identity: String(evidence.connection?.identity || ''),
      destination: String(evidence.connection?.destination || '')
    },
    media: evidence.media as LiveVideoMediaFingerprint,
    publicVideoUrl: evidence.transport?.publicVideoUrl ?? null,
    externalId: String(evidence.result?.externalId || ''),
    externalUrl: evidence.result?.externalUrl ?? null
  });
}
