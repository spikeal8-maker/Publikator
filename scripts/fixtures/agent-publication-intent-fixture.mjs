import { createAdminSetupGrant, createOrRecoverAdmin } from '../../dist/admin-auth.js';
import { encryptJson } from '../../dist/crypto.js';
import { createScopedAgentDraft } from '../../dist/http/agent-text-drafts.js';

export function seedAgentPublicationDraft(db) {
  const password = 'acceptance-publication-fixture-password';
  createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'), 'owner', password, password);
  const now = new Date().toISOString();
  const projectId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  const agentId = 'agent_publication_fixture';
  const accountId = 'account_publication_fixture';
  const scopes = ['posts:write','approval:request','publish:request'];
  db.prepare("INSERT INTO agent_principals(id,name,client_kind,created_at,updated_at) VALUES(?,?,'chatgpt',?,?)")
    .run(agentId, 'Pending publication test', now, now);
  db.prepare(`INSERT INTO agent_grants
    (agent_id,publish_mode,scope_ids_json,project_ids_json,account_ids_json,created_at,updated_at)
    VALUES (?,'OWNER_APPROVAL',?,?,?,?,?)`).run(
    agentId, JSON.stringify(scopes), JSON.stringify([projectId]), JSON.stringify([accountId]), now, now);
  db.prepare(`INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,'telegram','Synthetic delivery account',?,1,?,?)`).run(
    accountId, encryptJson({ botToken: 'test-provider-token', chatId: '@fixture' }), now, now);
  const identity = { agentId, tokenVersion: 1, grantVersion: 1, tokenScopes: scopes };
  const draft = createScopedAgentDraft(() => identity, {
    projectId, internalTitle: 'Pending intent', bodyPlain: 'An approved revision must match this text.',
    targetAccountIds: [accountId], contentFormat: 'TEXT_ONLY', publicationKind: 'FEED', mediaAssetIds: [],
  }, 'intent-test-draft', 'MCP').data;
  return {
    identity, accountId, input: {
      postId: draft.postId, expectedContentVersion: draft.contentVersion,
      targetAccountIds: [accountId], idempotencyKey: 'intent-test-request',
      when: { mode: 'AT', scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), timezone: 'Europe/Moscow' },
    },
  };
}
