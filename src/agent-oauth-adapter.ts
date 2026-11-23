import { createHmac } from 'node:crypto';
import type Database from 'better-sqlite3';
import { config } from './config.js';
import { decryptJson, encryptJson } from './crypto.js';

type OAuthPayload = Record<string, unknown> & {
  grantId?: string;
  uid?: string;
  userCode?: string;
};

type ArtifactRow = {
  id_digest: string;
  payload_encrypted: string;
  consumed_at: number | null;
};

const grantMembers = new Set([
  'AccessToken', 'AuthorizationCode', 'RefreshToken', 'DeviceCode',
  'BackchannelAuthenticationRequest', 'PreAuthorizedCode',
]);

function digest(namespace: string, value: string): string {
  return createHmac('sha256', config.masterKey)
    .update(JSON.stringify(['publikator.oauth.artifact.v1', namespace, value]))
    .digest('hex');
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createSQLiteOAuthAdapter(db: Database.Database) {
  const upsert = db.prepare(`
    INSERT INTO agent_oauth_artifacts
      (model, id_digest, payload_encrypted, expires_at, uid_digest, user_code_digest, grant_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (model, id_digest) DO UPDATE SET
      payload_encrypted = excluded.payload_encrypted,
      expires_at = excluded.expires_at,
      uid_digest = excluded.uid_digest,
      user_code_digest = excluded.user_code_digest,
      grant_digest = excluded.grant_digest
  `);
  const prune = db.prepare(`
    DELETE FROM agent_oauth_artifacts
    WHERE (model, id_digest) IN (
      SELECT model, id_digest FROM agent_oauth_artifacts
      WHERE expires_at <= ? ORDER BY expires_at LIMIT 128
    )
  `);
  const readArtifact = (keyColumn: 'id_digest' | 'uid_digest' | 'user_code_digest') => db.prepare(`
    SELECT id_digest, payload_encrypted, consumed_at
    FROM agent_oauth_artifacts
    WHERE model = ? AND ${keyColumn} = ? AND (expires_at IS NULL OR expires_at > ?)
  `);
  const byId = readArtifact('id_digest');
  const byUid = readArtifact('uid_digest');
  const byCode = readArtifact('user_code_digest');
  const consume = db.prepare(`
    UPDATE agent_oauth_artifacts SET consumed_at = ?
    WHERE model = ? AND id_digest = ? AND consumed_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
  `);
  const destroy = db.prepare('DELETE FROM agent_oauth_artifacts WHERE model = ? AND id_digest = ?');
  const revoke = db.prepare('DELETE FROM agent_oauth_artifacts WHERE grant_digest = ?');

  function unwrap(model: string, row: ArtifactRow | undefined): OAuthPayload | undefined {
    if (!row) return undefined;
    const envelope = decryptJson<{ model: string; idDigest: string; payload: OAuthPayload }>(row.payload_encrypted);
    if (envelope.model !== model || envelope.idDigest !== row.id_digest) {
      throw new Error('Stored OAuth artifact identity does not match its index');
    }
    return row.consumed_at === null ? envelope.payload : { ...envelope.payload, consumed: row.consumed_at };
  }

  return (model: string) => ({
    async upsert(id: string, payload: OAuthPayload, expiresIn?: number): Promise<void> {
      const now = epochSeconds();
      if (expiresIn !== undefined && (!Number.isSafeInteger(expiresIn) || expiresIn < 0
        || !Number.isSafeInteger(now + expiresIn))) {
        throw new Error('Invalid OAuth artifact lifetime');
      }
      const idDigest = digest(model, id);
      const expiresAt = expiresIn === undefined ? null : now + expiresIn;
      const uidDigest = model === 'Session' && payload.uid ? digest('sessionUid', payload.uid) : null;
      const userCodeDigest = payload.userCode ? digest('userCode', payload.userCode) : null;
      const grantDigest = grantMembers.has(model) && payload.grantId ? digest('grant', payload.grantId) : null;
      const encrypted = encryptJson({ model, idDigest, payload });
      db.transaction(() => {
        prune.run(now);
        upsert.run(model, idDigest, encrypted, expiresAt, uidDigest, userCodeDigest, grantDigest);
      })();
    },

    async find(id: string): Promise<OAuthPayload | undefined> {
      return unwrap(model, byId.get(model, digest(model, id), epochSeconds()) as ArtifactRow | undefined);
    },

    async findByUid(uid: string): Promise<OAuthPayload | undefined> {
      return unwrap(model, byUid.get(model, digest('sessionUid', uid), epochSeconds()) as ArtifactRow | undefined);
    },

    async findByUserCode(userCode: string): Promise<OAuthPayload | undefined> {
      return unwrap(model, byCode.get(model, digest('userCode', userCode), epochSeconds()) as ArtifactRow | undefined);
    },

    async consume(id: string): Promise<void> {
      const now = epochSeconds();
      const result = consume.run(now, model, digest(model, id), now);
      if (result.changes !== 1) throw new Error('OAuth artifact is no longer available for consumption');
    },

    async destroy(id: string): Promise<void> {
      destroy.run(model, digest(model, id));
    },

    async revokeByGrantId(grantId: string): Promise<void> {
      revoke.run(digest('grant', grantId));
    },
  });
}
