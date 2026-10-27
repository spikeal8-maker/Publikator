import type { ContentFormat, PublicationKind } from './domain/content-domain.js';

/**
 * Versioned subset/order of already-owned canonical image assets.
 * This contract does not support per-target video, story or image transforms.
 * It is applied to the immutable READY snapshot by preflight and publisher,
 * and to working content by the read-only platform preview.
 */
export type TargetMediaPlanV1 = {
  version: 1;
  mediaIds: string[];
};

type TargetMediaAsset = {
  id: string;
  mime_type?: string;
  mimeType?: string;
};

export class TargetMediaPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetMediaPlanError';
  }
}

export function resolveTargetMediaPlan<T extends TargetMediaAsset>(
  raw: string | TargetMediaPlanV1 | null | undefined,
  canonicalMedia: readonly T[],
  publicationKind: PublicationKind,
  contentFormat: ContentFormat
): { media: T[]; contentFormat: ContentFormat; applied: boolean } {
  if (raw == null || raw === '' || raw === '{}') {
    return { media: [...canonicalMedia], contentFormat, applied: false };
  }

  let plan: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > 16_384) throw new TargetMediaPlanError('План медиа получателя превышает допустимый размер');
    try {
      plan = JSON.parse(raw);
    } catch {
      throw new TargetMediaPlanError('План медиа получателя содержит некорректный JSON');
    }
  }

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TargetMediaPlanError('Некорректный план медиа получателя');
  }
  const record = plan as Record<string, unknown>;
  // Legacy empty JSON was a placeholder, never a claim that a plan executed.
  if (Object.keys(record).length === 0) {
    return { media: [...canonicalMedia], contentFormat, applied: false };
  }
  if (Object.keys(record).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(record, 'version') ||
      !Object.prototype.hasOwnProperty.call(record, 'mediaIds') ||
      record.version !== 1 || !Array.isArray(record.mediaIds)) {
    throw new TargetMediaPlanError('Неизвестный формат плана медиа: поддерживается только version=1 и mediaIds');
  }

  if (publicationKind !== 'FEED' || !['IMAGE', 'CAROUSEL'].includes(contentFormat)) {
    throw new TargetMediaPlanError('Индивидуальный порядок медиа доступен только для обычных публикаций с фотографиями');
  }
  const ids = record.mediaIds;
  if (ids.length === 0 || ids.length > 100 ||
      ids.some((id) => typeof id !== 'string' || !id || id.length > 256) ||
      new Set(ids).size !== ids.length) {
    throw new TargetMediaPlanError('Выберите уникальные фотографии получателя без повторов (1–100)');
  }
  const known = new Map(canonicalMedia.map((item) => [item.id, item]));
  if (canonicalMedia.some((item) => !String(item.mime_type ?? item.mimeType ?? '').startsWith('image/'))) {
    throw new TargetMediaPlanError('План медиа не допускает видео и смешанных вложений');
  }
  const selected: T[] = [];
  for (const mediaId of ids) {
    const media = known.get(mediaId);
    if (!media) throw new TargetMediaPlanError('Изображение из плана получателя не принадлежит текущей публикации');
    selected.push(media);
  }

  return {
    media: selected,
    contentFormat: selected.length === 1 ? 'IMAGE' : 'CAROUSEL',
    applied: true
  };
}

export function serializeTargetMediaPlan(
  mediaIds: string[],
  canonicalMedia: readonly TargetMediaAsset[],
  publicationKind: PublicationKind,
  contentFormat: ContentFormat
): string {
  const plan: TargetMediaPlanV1 = { version: 1, mediaIds };
  resolveTargetMediaPlan(plan, canonicalMedia, publicationKind, contentFormat);
  return JSON.stringify(plan);
}
