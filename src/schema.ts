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
  { version: 8, key: 'rich-media-model', migrationRegression: 'scripts/schema-v8-rich-media-e2e.mjs', backupRegression: 'scripts/backup-v8-rich-media-e2e.mjs' }
] as const satisfies readonly SchemaMilestone[];

export const DATABASE_SCHEMA_VERSION = SCHEMA_MILESTONES[SCHEMA_MILESTONES.length - 1]!.version;