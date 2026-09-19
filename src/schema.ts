export type SchemaMilestone = {
  version: number;
  key: string;
  migrationRegression: string;
  backupRegression: string | null;
};

export const SCHEMA_MILESTONES = [
  { version: 3, key: 'v1-baseline', migrationRegression: 'scripts/schema-v3-e2e.mjs', backupRegression: null },
  { version: 4, key: 'content-versioning', migrationRegression: 'scripts/schema-v4-content-versioning-e2e.mjs', backupRegression: 'scripts/backup-v4-content-versioning-e2e.mjs' },
  { version: 5, key: 'ingestion-provenance', migrationRegression: 'scripts/schema-v5-ingestion-provenance-e2e.mjs', backupRegression: 'scripts/backup-v5-provenance-e2e.mjs' },
  { version: 6, key: 'ingestion-security', migrationRegression: 'scripts/schema-v6-ingestion-security-e2e.mjs', backupRegression: 'scripts/backup-v6-e2e.mjs' },
  { version: 7, key: 'time-rendition-sequence', migrationRegression: 'scripts/schema-v7-time-rendition-sequence-e2e.mjs', backupRegression: 'scripts/backup-v7-e2e.mjs' },
  { version: 8, key: 'rich-media-model', migrationRegression: 'scripts/schema-v8-rich-media-e2e.mjs', backupRegression: 'scripts/backup-v8-rich-media-e2e.mjs' },
  { version: 9, key: 'revision-history', migrationRegression: 'scripts/schema-v9-revision-history-e2e.mjs', backupRegression: 'scripts/backup-v9-revision-history-e2e.mjs' },
  { version: 10, key: 'canonical-rich-text', migrationRegression: 'scripts/schema-v10-canonical-rich-text-e2e.mjs', backupRegression: 'scripts/backup-v10-canonical-rich-text-e2e.mjs' },
  { version: 11, key: 'project-defaults', migrationRegression: 'scripts/schema-v11-project-defaults-e2e.mjs', backupRegression: 'scripts/backup-v11-project-defaults-e2e.mjs' },
  { version: 12, key: 'templates', migrationRegression: 'scripts/schema-v12-templates-e2e.mjs', backupRegression: 'scripts/backup-v12-templates-e2e.mjs' }
] as const satisfies readonly SchemaMilestone[];

export const DATABASE_SCHEMA_VERSION = SCHEMA_MILESTONES[SCHEMA_MILESTONES.length - 1]!.version;