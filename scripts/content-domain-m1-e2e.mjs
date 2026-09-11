import assert from 'node:assert/strict';

const domain = await import('../dist/domain/content-domain.js');

const expectedEntities = [
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
];

assert.deepEqual(
  [...domain.CONTENT_DOMAIN_ENTITIES],
  expectedEntities,
  'canonical domain entity set drifted'
);

const statuses = [
  'DRAFT',
  'READY',
  'QUEUED',
  'PUBLISHING',
  'PARTIAL',
  'PUBLISHED',
  'FAILED'
];

for (const status of statuses) {
  for (const mediaCount of [0, 1, 2, 7]) {
    const projection = domain.projectLegacyImagePost({ status, mediaCount });

    assert.equal(projection.publicationKind, 'FEED');
    assert.equal(projection.contentVersion, 1);
    assert.equal(
      projection.contentFormat,
      mediaCount > 1 ? 'CAROUSEL' : 'IMAGE',
      `${status}/${mediaCount}: media mapping`
    );

    const expectedEditorial = status === 'READY' || status === 'PUBLISHED'
      ? 'APPROVED'
      : 'DRAFT';
    assert.equal(
      projection.editorialStage,
      expectedEditorial,
      `${status}/${mediaCount}: editorial mapping`
    );
  }
}

assert.throws(
  () => domain.projectLegacyImagePost({ status: 'DRAFT', mediaCount: -1 }),
  /non-negative integer/
);
assert.throws(
  () => domain.projectLegacyImagePost({ status: 'DRAFT', mediaCount: 1.5 }),
  /non-negative integer/
);

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'M0-001',
  entities: expectedEntities.length,
  legacyStatusesCovered: statuses.length,
  legacyMediaCountsCovered: 4
}, null, 2));
