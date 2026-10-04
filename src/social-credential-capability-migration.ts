import type Database from 'better-sqlite3';

const ACCESS_LEVEL_CHECK =
  "'FULL','PARTIAL','READ_ONLY','SETUP_REQUIRED','INVALID','UNAVAILABLE','UNCHECKED'";
const CHECK_STATUS_CHECK = "'SUCCESS','INVALID','UNAVAILABLE','UNCHECKED'";

export function migrateSocialCredentialCapability(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(social_accounts)').all() as Array<{ name: string }>).map((row) => row.name)
  );
  if (!columns.has('credential_version')) {
    db.exec('ALTER TABLE social_accounts ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1 CHECK(credential_version >= 1)');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_account_capability_profiles (
      account_id TEXT PRIMARY KEY REFERENCES social_accounts(id) ON DELETE CASCADE,
      profile_schema_version INTEGER NOT NULL CHECK(profile_schema_version >= 1),
      credential_version INTEGER NOT NULL CHECK(credential_version >= 1),
      access_level TEXT NOT NULL CHECK(access_level IN (${ACCESS_LEVEL_CHECK})),
      provider_type TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      profile_fingerprint TEXT NOT NULL CHECK(length(profile_fingerprint) = 64),
      last_check_status TEXT NOT NULL CHECK(last_check_status IN (${CHECK_STATUS_CHECK})),
      last_check_at TEXT,
      last_successful_checked_at TEXT,
      last_check_code TEXT,
      last_check_message TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_social_capability_access
      ON social_account_capability_profiles(access_level, last_check_status);
  `);
}
