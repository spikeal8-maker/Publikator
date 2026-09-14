import type { LiveVideoMediaFingerprint } from './live-video-acceptance.js';

export type LiveInstagramShortAcceptanceEvidence = {
  schemaVersion: 1;
  checkpoint: 'CX3-011B';
  status: 'API_CONFIRMED' | 'PASSED' | 'RECOVERY_NEEDED';
  runId: string;
  platform: 'instagram';
  publicationKind: 'SHORT';
  contentFormat: 'VERTICAL_VIDEO';
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
    publicVideoUrl: string;
  };
  result: {
    externalId: string | null;
    externalUrl: string | null;
  };
  failure: {
    message: string;
    code: string | number | null;
  } | null;
  visibility: {
    confirmedAt: string | null;
    note: string | null;
  };
};

type EvidenceBaseParams = {
  runId: string;
  startedAt: string;
  completedAt: string;
  buildSha: string;
  account: { id: string; name: string };
  connection: { identity: string; destination: string };
  media: LiveVideoMediaFingerprint;
  publicVideoUrl: string;
};

function assertIsoDate(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`CX3-011B evidence: ${field} должен быть ISO timestamp`);
}

function assertBuildSha(value: string): void {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error('CX3-011B evidence: buildSha должен быть полным 40-символьным Git SHA');
  }
}

function assertMediaFingerprint(media: LiveVideoMediaFingerprint): void {
  if (!media || typeof media !== 'object') throw new Error('CX3-011B evidence: media fingerprint отсутствует');
  if (!media.mediaId.trim()) throw new Error('CX3-011B evidence: mediaId отсутствует');
  if (!media.originalName.trim()) throw new Error('CX3-011B evidence: originalName отсутствует');
  if (!Number.isInteger(media.sizeBytes) || media.sizeBytes <= 0) throw new Error('CX3-011B evidence: sizeBytes должен быть положительным integer');
  if (!/^[a-f0-9]{64}$/i.test(media.sha256)) throw new Error('CX3-011B evidence: sha256 должен содержать 64 hex символа');
  if (!Number.isFinite(media.width) || media.width <= 0 || !Number.isFinite(media.height) || media.height <= 0) {
    throw new Error('CX3-011B evidence: dimensions должны быть положительными');
  }
  if (media.height <= media.width) throw new Error('CX3-011B evidence: SHORT media должен быть вертикальным');
  if (!Number.isFinite(media.durationMs) || media.durationMs <= 0) throw new Error('CX3-011B evidence: durationMs должен быть положительным');
  if (!Number.isFinite(media.fps) || media.fps <= 0) throw new Error('CX3-011B evidence: fps должен быть положительным');
  if (!media.videoCodec.trim()) throw new Error('CX3-011B evidence: videoCodec отсутствует');
  if (!media.container.trim()) throw new Error('CX3-011B evidence: container отсутствует');
}

function normalizedPublicUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('CX3-011B evidence: publicVideoUrl отсутствует');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('CX3-011B evidence: publicVideoUrl должен быть HTTPS URL без credentials');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function normalizedBase(params: EvidenceBaseParams) {
  if (!params.runId.trim()) throw new Error('CX3-011B evidence: runId отсутствует');
  assertIsoDate(params.startedAt, 'startedAt');
  assertIsoDate(params.completedAt, 'completedAt');
  const buildSha = params.buildSha.trim().toLowerCase();
  assertBuildSha(buildSha);
  if (!params.account.id.trim()) throw new Error('CX3-011B evidence: account.id отсутствует');
  if (!params.account.name.trim()) throw new Error('CX3-011B evidence: account.name отсутствует');
  if (!params.connection.identity.trim()) throw new Error('CX3-011B evidence: connection.identity отсутствует');
  if (!params.connection.destination.trim()) throw new Error('CX3-011B evidence: connection.destination отсутствует');
  assertMediaFingerprint(params.media);
  return {
    runId: params.runId.trim(),
    startedAt: new Date(params.startedAt).toISOString(),
    completedAt: new Date(params.completedAt).toISOString(),
    buildSha,
    account: { id: params.account.id.trim(), name: params.account.name.trim() },
    connection: { identity: params.connection.identity.trim(), destination: params.connection.destination.trim() },
    media: { ...params.media },
    publicVideoUrl: normalizedPublicUrl(params.publicVideoUrl)
  };
}

export function buildLiveInstagramShortAcceptanceEvidence(params: EvidenceBaseParams & {
  externalId: string;
  externalUrl?: string | null;
}): LiveInstagramShortAcceptanceEvidence {
  const base = normalizedBase(params);
  if (!params.externalId.trim()) throw new Error('CX3-011B evidence: externalId отсутствует');
  return {
    schemaVersion: 1,
    checkpoint: 'CX3-011B',
    status: 'API_CONFIRMED',
    runId: base.runId,
    platform: 'instagram',
    publicationKind: 'SHORT',
    contentFormat: 'VERTICAL_VIDEO',
    startedAt: base.startedAt,
    completedAt: base.completedAt,
    buildSha: base.buildSha,
    account: base.account,
    connection: base.connection,
    media: base.media,
    transport: { publicVideoUrl: base.publicVideoUrl },
    result: {
      externalId: params.externalId.trim(),
      externalUrl: params.externalUrl?.trim() || null
    },
    failure: null,
    visibility: { confirmedAt: null, note: null }
  };
}

export function buildLiveInstagramShortRecoveryEvidence(params: EvidenceBaseParams & {
  message: string;
  code?: string | number | null;
}): LiveInstagramShortAcceptanceEvidence {
  const base = normalizedBase(params);
  const message = params.message.trim();
  if (!message) throw new Error('CX3-011B recovery evidence: message отсутствует');
  if (message.length > 2000) throw new Error('CX3-011B recovery evidence: message не должна превышать 2000 символов');
  return {
    schemaVersion: 1,
    checkpoint: 'CX3-011B',
    status: 'RECOVERY_NEEDED',
    runId: base.runId,
    platform: 'instagram',
    publicationKind: 'SHORT',
    contentFormat: 'VERTICAL_VIDEO',
    startedAt: base.startedAt,
    completedAt: base.completedAt,
    buildSha: base.buildSha,
    account: base.account,
    connection: base.connection,
    media: base.media,
    transport: { publicVideoUrl: base.publicVideoUrl },
    result: { externalId: null, externalUrl: null },
    failure: { message, code: params.code ?? null },
    visibility: { confirmedAt: null, note: null }
  };
}

export function confirmLiveInstagramShortAcceptanceEvidence(
  evidence: LiveInstagramShortAcceptanceEvidence,
  params: { confirmedAt: string; note?: string | null }
): LiveInstagramShortAcceptanceEvidence {
  const checked = validateLiveInstagramShortAcceptanceEvidence(evidence);
  if (checked.status === 'RECOVERY_NEEDED') throw new Error('CX3-011B evidence: RECOVERY_NEEDED нельзя подтвердить как PASS без ручного разрешения неопределённого исхода');
  if (checked.status === 'PASSED') throw new Error('CX3-011B evidence: видимость уже подтверждена');
  assertIsoDate(params.confirmedAt, 'visibility.confirmedAt');
  const note = params.note?.trim() || null;
  if (note && note.length > 2000) throw new Error('CX3-011B evidence: visibility note не должна превышать 2000 символов');
  return {
    ...checked,
    status: 'PASSED',
    visibility: {
      confirmedAt: new Date(params.confirmedAt).toISOString(),
      note
    }
  };
}

export function validateLiveInstagramShortAcceptanceEvidence(value: unknown): LiveInstagramShortAcceptanceEvidence {
  if (!value || typeof value !== 'object') throw new Error('CX3-011B evidence: ожидается JSON object');
  const evidence = value as Partial<LiveInstagramShortAcceptanceEvidence>;
  if (evidence.schemaVersion !== 1 || evidence.checkpoint !== 'CX3-011B' || !['API_CONFIRMED', 'PASSED', 'RECOVERY_NEEDED'].includes(String(evidence.status))) {
    throw new Error('CX3-011B evidence: неверная schema/checkpoint/status');
  }
  if (evidence.platform !== 'instagram' || evidence.publicationKind !== 'SHORT' || evidence.contentFormat !== 'VERTICAL_VIDEO') {
    throw new Error('CX3-011B evidence: допускается только instagram SHORT/VERTICAL_VIDEO');
  }
  if (!evidence.account || !evidence.connection || !evidence.media || !evidence.transport || !evidence.result || !evidence.visibility) {
    throw new Error('CX3-011B evidence: обязательные секции отсутствуют');
  }

  const common: EvidenceBaseParams = {
    runId: String(evidence.runId || ''),
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
    publicVideoUrl: String(evidence.transport.publicVideoUrl || '')
  };

  if (evidence.status === 'RECOVERY_NEEDED') {
    if (!evidence.failure || evidence.result.externalId !== null || evidence.result.externalUrl !== null || evidence.visibility.confirmedAt !== null || evidence.visibility.note !== null) {
      throw new Error('CX3-011B evidence: RECOVERY_NEEDED имеет некорректные result/failure/visibility секции');
    }
    return buildLiveInstagramShortRecoveryEvidence({
      ...common,
      message: String(evidence.failure.message || ''),
      code: evidence.failure.code ?? null
    });
  }

  if (evidence.failure !== null) throw new Error('CX3-011B evidence: успешная acceptance не должна содержать failure');
  const base = buildLiveInstagramShortAcceptanceEvidence({
    ...common,
    externalId: String(evidence.result.externalId || ''),
    externalUrl: evidence.result.externalUrl ?? null
  });

  if (evidence.status === 'API_CONFIRMED') {
    if (evidence.visibility.confirmedAt !== null || evidence.visibility.note !== null) {
      throw new Error('CX3-011B evidence: API_CONFIRMED не должен содержать visibility confirmation');
    }
    return base;
  }

  if (!evidence.visibility.confirmedAt) throw new Error('CX3-011B evidence: PASSED требует visibility.confirmedAt');
  assertIsoDate(evidence.visibility.confirmedAt, 'visibility.confirmedAt');
  const note = evidence.visibility.note?.trim() || null;
  if (note && note.length > 2000) throw new Error('CX3-011B evidence: visibility note не должна превышать 2000 символов');
  return {
    ...base,
    status: 'PASSED',
    visibility: {
      confirmedAt: new Date(evidence.visibility.confirmedAt).toISOString(),
      note
    }
  };
}
