import type { FastifyInstance } from 'fastify';
import { db, nowIso } from '../db.js';
import { commitContentEdit } from '../content-versioning.js';
import { contentMutationError, expectedContentVersion } from './content-version.js';
import { parseRichTextJson, richTextToPlain, serializeRichText } from '../rich-text.js';

const IMMUTABLE_POST_STATUSES = new Set(['PUBLISHING', 'PUBLISHED', 'PARTIAL']);
const MAX_OVERRIDE_LENGTH = 20_000;

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, unknown>;
}

export async function registerTargetOverrideRoutes(app: FastifyInstance): Promise<void> {
  app.patch('/api/posts/:postId/targets/:targetId/text', async (request, reply) => {
    const params = request.params as { postId: string; targetId: string };
    const row = db.prepare(`SELECT pt.id, pt.post_id, pt.account_id, pt.override_text, pt.state,
      p.status AS post_status, p.body AS base_text, a.platform, a.name AS account_name
      FROM post_targets pt
      JOIN posts p ON p.id=pt.post_id
      JOIN social_accounts a ON a.id=pt.account_id
      WHERE pt.id=? AND pt.post_id=?`).get(params.targetId, params.postId) as any;

    if (!row) return reply.code(404).send({ error: 'Цель публикации не найдена' });
    if (IMMUTABLE_POST_STATUSES.has(row.post_status)) {
      return reply.code(409).send({ error: 'Нельзя менять текст площадки после начала публикации' });
    }
    if (row.state === 'PUBLISHED') {
      return reply.code(409).send({ error: 'Эта публикация на площадке уже выполнена' });
    }

    let body: Record<string, unknown>;
    try {
      body = bodyObject(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    const hasRich = Object.prototype.hasOwnProperty.call(body, 'textRich');
    const hasPlain = Object.prototype.hasOwnProperty.call(body, 'text');
    if (!hasRich && !hasPlain) {
      return reply.code(400).send({ error: 'Нужно передать textRich или legacy text; null сбрасывает отдельный текст площадки' });
    }

    let richJson: string | null = null;
    let richPlain: string | null = null;
    let overrideText: string | null = null;
    try {
      if (hasRich) {
        if (body.textRich !== null) {
          richJson = serializeRichText(body.textRich);
          richPlain = richTextToPlain(parseRichTextJson(richJson));
          if (richPlain.length > MAX_OVERRIDE_LENGTH) throw new Error(`Отдельный текст площадки не должен превышать ${MAX_OVERRIDE_LENGTH} символов`);
        }
      } else {
        if (body.text !== null && typeof body.text !== 'string') throw new Error('text должен быть строкой или null');
        const normalized = typeof body.text === 'string' ? body.text.trim() : '';
        if (normalized.length > MAX_OVERRIDE_LENGTH) throw new Error(`Отдельный текст площадки не должен превышать ${MAX_OVERRIDE_LENGTH} символов`);
        overrideText = normalized.length > 0 ? normalized : null;
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    const now = nowIso();
    let nextVersion: number;
    try {
      const version = expectedContentVersion(request, body);
      const committed = commitContentEdit(params.postId, version, 'manual', () => {
        if (hasRich) {
          db.prepare('UPDATE post_targets SET override_text=NULL, updated_at=? WHERE id=?').run(now, params.targetId);
          if (richJson === null) {
            db.prepare('UPDATE target_renditions SET text_rich_json=NULL,text_plain=NULL,updated_at=? WHERE target_id=?')
              .run(now, params.targetId);
          } else {
            db.prepare(`INSERT INTO target_renditions
              (target_id,text_rich_json,text_plain,publication_kind,content_format,media_plan_json,options_json,updated_at)
              VALUES (?,?,?,NULL,NULL,NULL,NULL,?)
              ON CONFLICT(target_id) DO UPDATE SET
                text_rich_json=excluded.text_rich_json,text_plain=excluded.text_plain,updated_at=excluded.updated_at`)
              .run(params.targetId, richJson, richPlain, now);
          }
        } else {
          db.prepare('UPDATE post_targets SET override_text=?, updated_at=? WHERE id=?')
            .run(overrideText, now, params.targetId);
          db.prepare('UPDATE target_renditions SET text_rich_json=NULL,text_plain=NULL,updated_at=? WHERE target_id=?')
            .run(now, params.targetId);
        }
      });
      nextVersion = committed.contentVersion;
    } catch (error) {
      return contentMutationError(reply, error);
    }

    return {
      ok: true,
      contentVersion: nextVersion,
      target: {
        id: row.id,
        accountId: row.account_id,
        accountName: row.account_name,
        platform: row.platform,
        overrideText: hasRich ? null : overrideText,
        textRich: richJson ? parseRichTextJson(richJson) : null,
        textPlain: richPlain,
        source: richJson ? 'platform_override' : overrideText ? 'legacy_override' : 'base',
        resolvedText: richPlain ?? overrideText ?? row.base_text
      }
    };
  });
}
