import { pathToFileURL } from 'node:url';

const { DATABASE_SCHEMA_VERSION } = await import('../dist/schema.js');

export const CURRENT_SCHEMA_VERSION = DATABASE_SCHEMA_VERSION;

export function assertCurrentSchema(assert, database) {
  assert.equal(
    Number(database.pragma('user_version', { simple: true })),
    CURRENT_SCHEMA_VERSION,
    'database must be migrated to current schema'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(String(CURRENT_SCHEMA_VERSION));
}
