import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { assertEffectiveAgentGrant, type VerifiedAgentIdentity } from '../agent-grant-acl.js';
import { AgentRegistryError } from '../agent-registry-error.js';
import { normalizeRelativePath } from '../cloud-media-reference.js';
import { downloadCloudMedia, type DownloadedCloudMedia } from '../cloud-media.js';
import { ContentConflictError } from '../content-versioning.js';
import { db, id, nowIso } from '../db.js';
import { resolveGoogleDriveMedia } from '../google-drive-media.js';
import { saveImageVersioned, saveVideoVersioned } from '../media.js';
import { resolveYandexDiskMedia } from '../yandex-disk-media.js';

type AttachmentInput = {
  postId: string;
  connectorId: string;
  relativePath: string;
  expectedContentVersion: number;
  idempotencyKey: string;
};
type Receipt = { postId: string; contentVersion: number; status: 'DRAFT' };

const operation = 'attach_cloud_media';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function deny(code: string, message: string, status: number): never {
  throw new AgentRegistryError(code, message, status);
}

export async function attachManagedAgentMedia(identity: VerifiedAgentIdentity, input: AttachmentInput): Promise<Receipt> {
  let relativePath: string;
  try {
    relativePath = normalizeRelativePath(input.relativePath);
    if (relativePath.includes('%')) throw new Error('encoded path');
  } catch {
    return deny('VALIDATION_ERROR', 'Укажите относительный путь к файлу внутри папки источника.', 400);
  }
  const { postId, connectorId, expectedContentVersion, idempotencyKey } = input;
  const key = hash([identity.agentId, operation, idempotencyKey]);
  const payloadHash = hash([postId, connectorId, relativePath, expectedContentVersion]);

  function authorize() {
    const post = db.prepare(`SELECT p.project_id AS projectId,p.content_version AS version FROM posts p
      JOIN agent_draft_ownership o ON o.post_id=p.id
      WHERE p.id=? AND o.agent_id=? AND p.status='DRAFT' AND p.schedule_mode='MANUAL'
        AND p.editorial_stage IN ('IDEA','DRAFT','IN_REVIEW')`).get(postId, identity.agentId) as {
        projectId: string; version: number;
      } | undefined;
    if (!post) return deny('RESOURCE_DENIED', 'Черновик недоступен для добавления медиа.', 403);
    assertEffectiveAgentGrant({ ...identity, requiredScope: 'posts:write', postId, projectId: post.projectId });
    assertEffectiveAgentGrant({
      ...identity, requiredScope: 'media:import', sourceConnectorId: connectorId, postId, projectId: post.projectId,
    });
    const connector = db.prepare(`SELECT type,config_json,credentials_encrypted,updated_at FROM ingestion_connectors
      WHERE id=? AND enabled=1 AND type IN ('google_drive','yandex_disk')`).get(connectorId) as {
        type: 'google_drive' | 'yandex_disk'; config_json: string; credentials_encrypted: string | null; updated_at: string;
      } | undefined;
    if (!connector) return deny('RESOURCE_DENIED', 'Источник медиа недоступен.', 403);
    return { version: post.version, type: connector.type, fingerprint: hash(connector) };
  }

  function replay(): Receipt | null {
    const earlier = db.prepare(`SELECT canonical_payload_hash AS payloadHash,result_json AS result
      FROM agent_operation_receipts WHERE agent_id=? AND operation_name=? AND idempotency_key_hash=?`)
      .get(identity.agentId, operation, key) as { payloadHash: string; result: string } | undefined;
    if (!earlier) return null;
    if (earlier.payloadHash !== payloadHash) return deny('IDEMPOTENCY_CONFLICT', 'Ключ уже использован для другой операции.', 409);
    return JSON.parse(earlier.result) as Receipt;
  }

  function checkVersion(version: number) {
    if (version !== expectedContentVersion) {
      deny('CONTENT_VERSION_CONFLICT', 'Черновик изменился. Снова откройте его и получите текущую версию.', 409);
    }
  }

  const initial = db.transaction(() => {
    const connection = authorize();
    const prior = replay();
    if (!prior) checkVersion(connection.version);
    return { ...connection, prior };
  })();
  if (initial.prior) return initial.prior;

  let result: Receipt | undefined;
  function record(contentVersion: number) {
    const current = authorize();
    if (replay()) throw new ContentConflictError('Concurrent attachment already recorded');
    checkVersion(current.version);
    if (current.fingerprint !== initial.fingerprint) {
      deny('SOURCE_CHANGED', 'Подключение источника изменилось. Запустите импорт снова.', 409);
    }
    result = { postId, contentVersion, status: 'DRAFT' };
    const stamp = nowIso();
    db.prepare(`INSERT INTO agent_operation_receipts
      (receipt_id,agent_id,operation_name,idempotency_key_hash,canonical_payload_hash,post_id,phase,result_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'COMPLETED',?,?,?)`).run(
      id('receipt'), identity.agentId, operation, key, payloadHash, postId, JSON.stringify(result), stamp, stamp,
    );
    db.prepare(`INSERT INTO agent_activity_events
      (event_id,agent_id,actor_type,origin,request_id,operation_id,post_id,grant_version,stage,outcome,safe_summary,occurred_at)
      VALUES (?,?,'AGENT','MCP',?,?,?,?,'COMPLETED','SUCCEEDED',?,?)`).run(
      id('evt'), identity.agentId, 'req_' + key, operation, postId, identity.grantVersion,
      'Агент прикрепил медиа из разрешённого источника.', stamp,
    );
  }

  let downloaded: DownloadedCloudMedia | undefined;
  try {
    const resolved = initial.type === 'google_drive'
      ? await resolveGoogleDriveMedia(connectorId, relativePath)
      : await resolveYandexDiskMedia(connectorId, relativePath);
    downloaded = await downloadCloudMedia(resolved);
    const fileName = relativePath.split('/').at(-1)!;
    const guard = { actorSource: 'agent_api' as const, beforeCommit: record };
    if (downloaded.mimeType === 'video/mp4') {
      const stream = createReadStream(downloaded.tempPath);
      try {
        await saveVideoVersioned(postId, fileName, stream, expectedContentVersion, guard);
      } finally {
        stream.destroy();
      }
    } else if (downloaded.mimeType.startsWith('image/')) {
      await saveImageVersioned(postId, fileName, await readFile(downloaded.tempPath), expectedContentVersion, guard);
    } else {
      deny('UNSUPPORTED_MEDIA', 'Источник должен содержать изображение или MP4.', 400);
    }
    if (!result) throw new Error('Missing media receipt');
    return result;
  } catch (error) {
    if (error instanceof AgentRegistryError) throw error;
    if (error instanceof ContentConflictError) {
      return db.transaction(() => {
        authorize();
        return replay() ?? deny('CONTENT_VERSION_CONFLICT', 'Черновик изменился. Обновите его перед импортом.', 409);
      })();
    }
    return deny('MEDIA_IMPORT_FAILED', 'Файл не удалось импортировать. Проверьте путь, формат и доступ к источнику.', 422);
  } finally {
    await downloaded?.cleanup().catch(() => undefined);
  }
}
