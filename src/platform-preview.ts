import { db, type Platform } from './db.js';
import type { ContentFormat, PublicationKind } from './domain/content-domain.js';
import { getTargetRendition, resolveTargetRendition, type CanonicalRendition } from './delivery-foundation.js';
import { listMedia } from './media.js';
import { listContentMedia } from './rich-media.js';
import { capabilityIssues, PLATFORM_CAPABILITIES, type CapabilityIssue } from './platforms/capabilities.js';

export type PlatformPreviewIssue = CapabilityIssue & { severity: 'error' | 'warning' };

export type PlatformPreviewMedia = {
  id: string;
  url: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  role: string;
  order: number;
  previewDurationMs: number | null;
  posterUrl: string | null;
};

export type PlatformPreview = {
  targetId: string;
  accountId: string;
  accountName: string;
  platform: Platform;
  enabled: boolean;
  targetState: string;
  publicationKind: PublicationKind;
  contentFormat: ContentFormat;
  text: string;
  media: PlatformPreviewMedia[];
  mediaCount: number;
  videoDurationMs: number | null;
  captionPlacement: 'above' | 'below' | 'overlay';
  verticalSafeZone: boolean;
  issues: PlatformPreviewIssue[];
};

const captionPlacement: Record<Platform, PlatformPreview['captionPlacement']> = {
  telegram: 'below',
  vk: 'above',
  max: 'below',
  instagram: 'below'
};

function mediaUrl(relativePath: string): string {
  return `/public-media/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

function orderedPreviewMedia(postId: string): PlatformPreviewMedia[] {
  const media = listMedia(postId) as any[];
  const byId = new Map(media.map((item) => [item.id, item]));
  const relation = listContentMedia(postId);
  const order = relation.length
    ? relation
    : media.map((item, index) => ({ media_id: item.id, sort_order: item.sort_order ?? index, role: 'primary', preview_duration_ms: null }));
  return order.map((link: any) => {
    const item = byId.get(link.media_id);
    if (!item) return null;
    const poster = item.poster_asset_id ? byId.get(item.poster_asset_id) : null;
    return {
      id: item.id,
      url: mediaUrl(item.relative_path),
      mimeType: item.mime_type,
      width: item.width ?? null,
      height: item.height ?? null,
      durationMs: item.duration_ms ?? null,
      role: link.role,
      order: link.sort_order,
      previewDurationMs: link.preview_duration_ms ?? null,
      posterUrl: poster ? mediaUrl(poster.relative_path) : null
    } satisfies PlatformPreviewMedia;
  }).filter(Boolean) as PlatformPreviewMedia[];
}

function primaryMedia(items: PlatformPreviewMedia[]): PlatformPreviewMedia[] {
  return items.filter((item) => item.role !== 'poster');
}

function verticalAspectWarning(kind: PublicationKind, format: ContentFormat, items: PlatformPreviewMedia[]): PlatformPreviewIssue[] {
  const vertical = kind === 'SHORT' || kind === 'STORY' || format === 'VERTICAL_VIDEO';
  if (!vertical) return [];
  const warnings: PlatformPreviewIssue[] = [];
  for (const item of primaryMedia(items)) {
    if (!item.width || !item.height) continue;
    const ratio = item.width / item.height;
    const target = 9 / 16;
    if (Math.abs(ratio - target) > 0.04) {
      warnings.push({
        severity: 'warning',
        code: 'VERTICAL_SAFE_ZONE_ASPECT',
        message: `Media ${item.width}×${item.height} отличается от рекомендованного 9:16; проверьте safe zones`
      });
    }
  }
  return warnings;
}

export function platformPreviews(postId: string): PlatformPreview[] {
  const post = db.prepare(`SELECT id,title,body,publication_kind,content_format FROM posts WHERE id=?`).get(postId) as any;
  if (!post) throw new Error('Пост не найден');
  const items = orderedPreviewMedia(postId);
  const publishMedia = primaryMedia(items).map((item) => ({
    id: item.id, post_id: postId, original_name: '', relative_path: '', mime_type: item.mimeType,
    size_bytes: 0, width: item.width, height: item.height, sha256: '', created_at: '', sort_order: item.order,
    duration_ms: item.durationMs
  })) as any[];
  const targets = db.prepare(`SELECT pt.id,pt.account_id,pt.enabled,pt.override_text,pt.state,
      a.platform,a.name AS account_name,a.enabled AS account_enabled
    FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=? ORDER BY a.platform,a.name`).all(postId) as any[];

  const canonical: CanonicalRendition = {
    textRichJson: null,
    textPlain: post.body,
    publicationKind: post.publication_kind,
    contentFormat: post.content_format,
    mediaPlanJson: '{}',
    optionsJson: '{}'
  };

  return targets.map((target) => {
    const override = getTargetRendition(target.id);
    const resolved = resolveTargetRendition(canonical, override);
    const text = override?.textPlain ?? target.override_text ?? resolved.textPlain;
    const issues: PlatformPreviewIssue[] = [];
    if (!target.account_enabled) issues.push({ severity: 'error', code: 'ACCOUNT_DISABLED', message: 'Аккаунт отключён' });
    if (override?.mediaPlanJson) {
      issues.push({ severity: 'warning', code: 'MEDIA_PLAN_NOT_EXECUTED', message: 'Target media plan сохранён, но текущий publisher ещё использует canonical media order' });
    }
    const capability = PLATFORM_CAPABILITIES[target.platform as Platform];
    const publicMediaUrls = capability.requiresPublicHttpsMedia ? publishMedia.map(() => 'https://preview.invalid/media') : [];
    issues.push(...capabilityIssues(target.platform as Platform, {
      postId,
      title: post.title,
      text,
      media: publishMedia,
      credentials: {},
      publicMediaUrls,
      publicationKind: resolved.publicationKind,
      contentFormat: resolved.contentFormat
    }).map((issue) => ({ ...issue, severity: 'error' as const })));
    issues.push(...verticalAspectWarning(resolved.publicationKind, resolved.contentFormat, items));
    return {
      targetId: target.id,
      accountId: target.account_id,
      accountName: target.account_name,
      platform: target.platform,
      enabled: Boolean(target.enabled),
      targetState: target.state,
      publicationKind: resolved.publicationKind,
      contentFormat: resolved.contentFormat,
      text,
      media: items,
      mediaCount: primaryMedia(items).length,
      videoDurationMs: primaryMedia(items).find((item) => item.mimeType.startsWith('video/'))?.durationMs ?? null,
      captionPlacement: captionPlacement[target.platform as Platform],
      verticalSafeZone: resolved.publicationKind === 'SHORT' || resolved.publicationKind === 'STORY' || resolved.contentFormat === 'VERTICAL_VIDEO',
      issues
    } satisfies PlatformPreview;
  });
}
