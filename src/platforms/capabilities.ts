import type { Platform } from '../db.js';
import type { ContentFormat, PublicationKind } from '../domain/content-domain.js';
import type { PublishInput } from './types.js';

export type AspectRatioRule = {
  contentFormats: ContentFormat[];
  maxRatio?: number;
  maxWidthPlusHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
};

export type DurationRule = {
  contentFormats: ContentFormat[];
  minMs?: number;
  maxMs?: number;
};

export type TextRules = {
  maxChars: number | null;
  captionMaxChars?: number | null;
};

export type PlatformCapability = {
  platform: Platform;
  supportsFeed: boolean;
  supportsStories: boolean;
  supportsShortVideo: boolean;
  supportsTextOnly: boolean;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsCarousel: boolean;
  supportsMixedCarousel: boolean;
  supportsStorySequence: boolean;
  maxMediaPerPublication: number | null;
  allowedMimeTypes: string[];
  aspectRatioRules: AspectRatioRule[];
  durationRules: DurationRule[];
  textRules: TextRules;
  requiresPublicHttpsMedia: boolean;
  platformOptionsSchema: Record<string, unknown>;
  verification: {
    officialDocsReviewedAt: string;
    richMediaPendingLiveAcceptance: boolean;
  };
};

export type CapabilityIssue = {
  code: string;
  message: string;
};

const VERIFIED_AT = '2026-09-14';

export const PLATFORM_CAPABILITIES: Record<Platform, PlatformCapability> = {
  telegram: {
    platform: 'telegram',
    supportsFeed: true,
    supportsStories: false,
    supportsShortVideo: false,
    supportsTextOnly: false,
    supportsImage: true,
    supportsVideo: false,
    supportsCarousel: true,
    supportsMixedCarousel: false,
    supportsStorySequence: false,
    maxMediaPerPublication: 10,
    allowedMimeTypes: ['image/jpeg'],
    aspectRatioRules: [{ contentFormats: ['IMAGE', 'CAROUSEL'], maxRatio: 20, maxWidthPlusHeight: 10000 }],
    durationRules: [],
    textRules: { maxChars: 4096, captionMaxChars: 1024 },
    requiresPublicHttpsMedia: false,
    platformOptionsSchema: {},
    verification: { officialDocsReviewedAt: VERIFIED_AT, richMediaPendingLiveAcceptance: true }
  },
  vk: {
    platform: 'vk',
    supportsFeed: true,
    supportsStories: false,
    supportsShortVideo: false,
    supportsTextOnly: false,
    supportsImage: true,
    supportsVideo: false,
    supportsCarousel: true,
    supportsMixedCarousel: false,
    supportsStorySequence: false,
    maxMediaPerPublication: null,
    allowedMimeTypes: ['image/jpeg'],
    aspectRatioRules: [],
    durationRules: [],
    textRules: { maxChars: null },
    requiresPublicHttpsMedia: false,
    platformOptionsSchema: {},
    verification: { officialDocsReviewedAt: VERIFIED_AT, richMediaPendingLiveAcceptance: true }
  },
  max: {
    platform: 'max',
    supportsFeed: true,
    supportsStories: false,
    supportsShortVideo: false,
    supportsTextOnly: false,
    supportsImage: true,
    supportsVideo: false,
    supportsCarousel: true,
    supportsMixedCarousel: false,
    supportsStorySequence: false,
    maxMediaPerPublication: 12,
    allowedMimeTypes: ['image/jpeg'],
    aspectRatioRules: [{ contentFormats: ['IMAGE', 'CAROUSEL'], maxWidth: 7680, maxHeight: 7680 }],
    durationRules: [],
    textRules: { maxChars: 4000 },
    requiresPublicHttpsMedia: true,
    platformOptionsSchema: {},
    verification: { officialDocsReviewedAt: VERIFIED_AT, richMediaPendingLiveAcceptance: true }
  },
  instagram: {
    platform: 'instagram',
    supportsFeed: true,
    supportsStories: false,
    supportsShortVideo: false,
    supportsTextOnly: false,
    supportsImage: true,
    supportsVideo: false,
    supportsCarousel: true,
    supportsMixedCarousel: false,
    supportsStorySequence: false,
    maxMediaPerPublication: 10,
    allowedMimeTypes: ['image/jpeg'],
    aspectRatioRules: [],
    durationRules: [],
    textRules: { maxChars: null },
    requiresPublicHttpsMedia: true,
    platformOptionsSchema: {},
    verification: { officialDocsReviewedAt: VERIFIED_AT, richMediaPendingLiveAcceptance: true }
  }
};

export class CapabilityValidationError extends Error {
  readonly issues: CapabilityIssue[];

  constructor(platform: Platform, issues: CapabilityIssue[]) {
    super(`${platform}: ${issues.map((issue) => issue.message).join('; ')}`);
    this.name = 'CapabilityValidationError';
    this.issues = issues;
  }
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function publicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function resolvedKind(input: PublishInput): PublicationKind {
  return input.publicationKind ?? 'FEED';
}

function resolvedFormat(input: PublishInput): ContentFormat {
  return input.contentFormat ?? (input.media.length > 1 ? 'CAROUSEL' : 'IMAGE');
}

function compositionSupported(capability: PlatformCapability, kind: PublicationKind, format: ContentFormat): boolean {
  if (kind === 'FEED') {
    if (!capability.supportsFeed) return false;
    if (format === 'TEXT_ONLY') return capability.supportsTextOnly;
    if (format === 'IMAGE') return capability.supportsImage;
    if (format === 'CAROUSEL') return capability.supportsCarousel;
    if (format === 'VIDEO') return capability.supportsVideo;
    return false;
  }
  if (kind === 'SHORT') {
    return capability.supportsShortVideo && capability.supportsVideo && format === 'VERTICAL_VIDEO';
  }
  if (!capability.supportsStories) return false;
  if (format === 'IMAGE') return capability.supportsImage;
  if (format === 'VERTICAL_VIDEO') return capability.supportsVideo;
  if (format === 'STORY_SEQUENCE') return capability.supportsStorySequence;
  return false;
}

export function capabilityIssues(platform: Platform, input: PublishInput): CapabilityIssue[] {
  const capability = PLATFORM_CAPABILITIES[platform];
  const kind = resolvedKind(input);
  const format = resolvedFormat(input);
  const issues: CapabilityIssue[] = [];

  if (!compositionSupported(capability, kind, format)) {
    issues.push({ code: 'UNSUPPORTED_COMPOSITION', message: `${kind}/${format} не поддерживается текущим adapter ${platform}` });
  }

  if (format === 'TEXT_ONLY' && input.media.length !== 0) {
    issues.push({ code: 'TEXT_ONLY_WITH_MEDIA', message: 'TEXT_ONLY не должен содержать media' });
  }
  if (format === 'IMAGE' && input.media.length !== 1) {
    issues.push({ code: 'IMAGE_MEDIA_COUNT', message: 'IMAGE требует ровно один media asset' });
  }
  if (format === 'CAROUSEL' && input.media.length < 2) {
    issues.push({ code: 'CAROUSEL_MEDIA_COUNT', message: 'CAROUSEL требует минимум два media asset' });
  }

  if (capability.maxMediaPerPublication != null && input.media.length > capability.maxMediaPerPublication) {
    issues.push({
      code: 'MEDIA_COUNT_LIMIT',
      message: `Количество media ${input.media.length} превышает предел ${capability.maxMediaPerPublication}`
    });
  }

  for (const media of input.media) {
    if (!capability.allowedMimeTypes.includes(media.mime_type)) {
      issues.push({ code: 'MIME_NOT_ALLOWED', message: `MIME ${media.mime_type} не разрешён для текущего adapter ${platform}` });
    }
  }

  if (format === 'CAROUSEL' && !capability.supportsMixedCarousel) {
    const mediaKinds = new Set(input.media.map((media) => media.mime_type.split('/')[0]));
    if (mediaKinds.size > 1) issues.push({ code: 'MIXED_CAROUSEL_UNSUPPORTED', message: 'Mixed-media carousel не поддерживается текущим adapter' });
  }

  const textLength = characterCount(input.text);
  if (capability.textRules.maxChars != null && textLength > capability.textRules.maxChars) {
    issues.push({ code: 'TEXT_TOO_LONG', message: `Текст ${textLength} символов превышает предел ${capability.textRules.maxChars}` });
  }

  for (const rule of capability.aspectRatioRules.filter((item) => item.contentFormats.includes(format))) {
    for (const media of input.media.filter((item) => item.mime_type.startsWith('image/'))) {
      if (!media.width || !media.height) {
        issues.push({ code: 'IMAGE_DIMENSIONS_MISSING', message: `Для ${media.original_name} отсутствуют dimensions` });
        continue;
      }
      const ratio = Math.max(media.width / media.height, media.height / media.width);
      if (rule.maxRatio != null && ratio > rule.maxRatio) {
        issues.push({ code: 'ASPECT_RATIO_LIMIT', message: `${media.original_name}: aspect ratio ${ratio.toFixed(2)} превышает ${rule.maxRatio}` });
      }
      if (rule.maxWidthPlusHeight != null && media.width + media.height > rule.maxWidthPlusHeight) {
        issues.push({ code: 'DIMENSION_SUM_LIMIT', message: `${media.original_name}: width+height превышает ${rule.maxWidthPlusHeight}` });
      }
      if (rule.maxWidth != null && media.width > rule.maxWidth) {
        issues.push({ code: 'WIDTH_LIMIT', message: `${media.original_name}: width ${media.width} превышает ${rule.maxWidth}` });
      }
      if (rule.maxHeight != null && media.height > rule.maxHeight) {
        issues.push({ code: 'HEIGHT_LIMIT', message: `${media.original_name}: height ${media.height} превышает ${rule.maxHeight}` });
      }
    }
  }

  for (const rule of capability.durationRules.filter((item) => item.contentFormats.includes(format))) {
    for (const media of input.media.filter((item) => item.mime_type.startsWith('video/'))) {
      const duration = media.duration_ms;
      if (duration == null) issues.push({ code: 'VIDEO_DURATION_MISSING', message: `${media.original_name}: duration отсутствует` });
      else {
        if (rule.minMs != null && duration < rule.minMs) issues.push({ code: 'VIDEO_TOO_SHORT', message: `${media.original_name}: video короче ${rule.minMs} ms` });
        if (rule.maxMs != null && duration > rule.maxMs) issues.push({ code: 'VIDEO_TOO_LONG', message: `${media.original_name}: video длиннее ${rule.maxMs} ms` });
      }
    }
  }

  if (capability.requiresPublicHttpsMedia) {
    if (input.publicMediaUrls.length !== input.media.length) {
      issues.push({ code: 'PUBLIC_MEDIA_URL_REQUIRED', message: 'Для каждого media asset требуется публичный HTTPS URL' });
    } else if (input.publicMediaUrls.some((url) => !publicHttpsUrl(url))) {
      issues.push({ code: 'PUBLIC_MEDIA_URL_INVALID', message: 'Media URL должен быть публичным HTTPS URL без credentials' });
    }
  }

  return issues;
}

export function assertPlatformCapability(platform: Platform, input: PublishInput): void {
  const issues = capabilityIssues(platform, input);
  if (issues.length) throw new CapabilityValidationError(platform, issues);
}

export function listPlatformCapabilities(): PlatformCapability[] {
  return Object.values(PLATFORM_CAPABILITIES).map((capability) => structuredClone(capability));
}
