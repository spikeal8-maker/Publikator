export const CONTENT_DOMAIN_ENTITIES = [
  'Post',
  'ContentRevision',
  'MediaAsset',
  'ContentMedia',
  'PostTarget',
  'TargetRendition',
  'PublicationUnit',
  'Template',
  'IngestionSource',
  'SourceBinding',
  'ImportBatch',
  'IntegrationApiKey'
] as const;

export type ContentDomainEntity = typeof CONTENT_DOMAIN_ENTITIES[number];

export type EditorialStage =
  | 'IDEA'
  | 'DRAFT'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'ARCHIVED'
  | 'TRASHED';

export type PublicationKind = 'FEED' | 'SHORT' | 'STORY';
export type ContentFormat =
  | 'TEXT_ONLY'
  | 'IMAGE'
  | 'CAROUSEL'
  | 'VIDEO'
  | 'VERTICAL_VIDEO'
  | 'STORY_SEQUENCE';
export type LegacyPostStatus =
  | 'DRAFT'
  | 'READY'
  | 'QUEUED'
  | 'PUBLISHING'
  | 'PARTIAL'
  | 'PUBLISHED'
  | 'FAILED';

export type LegacyImageProjection = {
  publicationKind: 'FEED';
  contentFormat: 'IMAGE' | 'CAROUSEL';
  editorialStage: 'DRAFT' | 'APPROVED';
  contentVersion: 1;
};

export function projectLegacyImagePost(params: {
  status: LegacyPostStatus;
  mediaCount: number;
}): LegacyImageProjection {
  if (!Number.isInteger(params.mediaCount) || params.mediaCount < 0) {
    throw new Error('mediaCount must be a non-negative integer');
  }

  return {
    publicationKind: 'FEED',
    contentFormat: params.mediaCount > 1 ? 'CAROUSEL' : 'IMAGE',
    editorialStage: params.status === 'READY' || params.status === 'PUBLISHED'
      ? 'APPROVED'
      : 'DRAFT',
    contentVersion: 1
  };
}
