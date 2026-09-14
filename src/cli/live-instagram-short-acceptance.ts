import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { decryptJson } from '../crypto.js';
import { db } from '../db.js';
import { mediaAbsolutePath, mediaPublicUrl, type MediaRow } from '../media.js';
import { testConnection } from '../platforms/connection-test.js';
import { getPublisher } from '../platforms/index.js';
import {
  LIVE_VIDEO_CONFIRMATION,
  LIVE_VIDEO_VISIBILITY_CONFIRMATION,
  type LiveVideoMediaFingerprint
} from '../platforms/live-video-acceptance.js';
import {
  buildLiveInstagramShortAcceptanceEvidence,
  buildLiveInstagramShortRecoveryEvidence,
  confirmLiveInstagramShortAcceptanceEvidence,
  validateLiveInstagramShortAcceptanceEvidence,
  type LiveInstagramShortAcceptanceEvidence
} from '../platforms/live-instagram-short-acceptance.js';
import { PlatformError, type PublishInput } from '../platforms/types.js';

const execFileAsync = promisify(execFile);
const REQUIRED_CREDENTIAL_FIELDS = ['accessToken', 'igUserId', 'graphVersion'] as const;

type Args = {
  publish: boolean;
  confirmVisible: boolean;
  help: boolean;
  account?: string;
  media?: string;
  text?: string;
  evidence?: string;
  note?: string;
};

type AccountRow = {
  id: string;
  platform: string;
  name: string;
  enabled: number;
  credentials_encrypted?: string;
};

type VideoMediaRow = MediaRow & {
  post_content_format: string;
  post_status: string;
  post_editorial_stage: string;
  post_schedule_mode: string;
  post_target_count: number;
  media_role: string | null;
};

type LiveLock = {
  filePath: string;
  update: (payload: Record<string, unknown>) => Promise<void>;
  release: () => Promise<void>;
};

function usage(): string {
  return `CX3-011B live Instagram SHORT/VERTICAL_VIDEO acceptance

Plan-only, without external request or credential decryption:
  node dist/cli/live-instagram-short-acceptance.js --account acc_... --media med_...

One real Instagram Short publication:
  PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM=${LIVE_VIDEO_CONFIRMATION} \\
  node dist/cli/live-instagram-short-acceptance.js --publish --account acc_... --media med_...

After visually checking that the Short is visible in Instagram:
  PUBLIKATOR_LIVE_VISIBILITY_CONFIRM=${LIVE_VIDEO_VISIBILITY_CONFIRMATION} \\
  node dist/cli/live-instagram-short-acceptance.js --confirm-visible --evidence /app/data/live-acceptance-evidence/<run>.json --note "Visible as Instagram Reel/Short"

Options:
  --account <social_accounts.id>   Existing enabled Instagram account
  --media <media.id>               Canonical vertical MP4 from a target-free MANUAL DRAFT post
  --text <caption>                 Optional control caption
  --evidence <path>                Required only with --confirm-visible
  --note <text>                    Optional visibility note
  --publish                        Perform exactly one real SHORT/VERTICAL_VIDEO publication
  --confirm-visible                Convert API_CONFIRMED evidence to PASSED
  --help

Safety invariants:
- production supportsShortVideo/supportsVideo flags are not changed;
- source post must remain target-free MANUAL DRAFT/DRAFT;
- credentials are decrypted only after the explicit publish guard;
- prior CX3-011B evidence for the same build/account/media blocks duplicate live publication;
- a crash-safe CX3-011B lock blocks concurrent or interrupted blind retries;
- unknown external outcome is persisted as RECOVERY_NEEDED;
- credentials and signed URL query/hash data are never stored in evidence.`;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { publish: false, confirmVisible: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--publish') {
      result.publish = true;
      continue;
    }
    if (arg === '--confirm-visible') {
      result.confirmVisible = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    const map: Record<string, keyof Args> = {
      '--account': 'account',
      '--media': 'media',
      '--text': 'text',
      '--evidence': 'evidence',
      '--note': 'note'
    };
    const key = map[arg];
    if (!key) throw new Error(`Неизвестный аргумент ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Для ${arg} требуется значение`);
    (result as Record<string, unknown>)[key] = value;
    index += 1;
  }
  if (result.publish && result.confirmVisible) throw new Error('--publish и --confirm-visible взаимоисключающие');
  return result;
}

function assertPublishGuard(publish: boolean): void {
  if (!publish) throw new Error('CX3-011B: реальная публикация разрешена только с флагом --publish');
  if (process.env.PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM !== LIVE_VIDEO_CONFIRMATION) {
    throw new Error(`CX3-011B: перед реальной публикацией задайте PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM=${LIVE_VIDEO_CONFIRMATION}`);
  }
}

function assertVisibilityGuard(confirmVisible: boolean): void {
  if (!confirmVisible) throw new Error('CX3-011B: ручное подтверждение видимости разрешено только с флагом --confirm-visible');
  if (process.env.PUBLIKATOR_LIVE_VISIBILITY_CONFIRM !== LIVE_VIDEO_VISIBILITY_CONFIRMATION) {
    throw new Error(`CX3-011B: перед PASS задайте PUBLIKATOR_LIVE_VISIBILITY_CONFIRM=${LIVE_VIDEO_VISIBILITY_CONFIRMATION}`);
  }
}

function parseRate(value: unknown): number {
  const [leftRaw, rightRaw] = String(value || '0/1').split('/');
  const left = Number(leftRaw);
  const right = Number(rightRaw);
  if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) return 0;
  return left / right;
}

function normalizeContainer(formatName: unknown): string {
  const values = String(formatName || '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean);
  return values.includes('mp4') ? 'mp4' : (values[0] || '');
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function accountSummary(accountId: string): AccountRow {
  const row = db.prepare('SELECT id,platform,name,enabled FROM social_accounts WHERE id=?').get(accountId) as AccountRow | undefined;
  if (!row) throw new Error(`CX3-011B: social account ${accountId} не найден`);
  if (!row.enabled) throw new Error(`CX3-011B: social account ${accountId} отключён`);
  if (row.platform !== 'instagram') throw new Error(`CX3-011B: требуется Instagram account, получен ${row.platform}`);
  return row;
}

function accountWithCredentials(accountId: string): AccountRow {
  const row = db.prepare('SELECT id,platform,name,enabled,credentials_encrypted FROM social_accounts WHERE id=?').get(accountId) as AccountRow | undefined;
  if (!row) throw new Error(`CX3-011B: social account ${accountId} не найден`);
  if (!row.enabled) throw new Error(`CX3-011B: social account ${accountId} отключён`);
  if (row.platform !== 'instagram') throw new Error(`CX3-011B: требуется Instagram account, получен ${row.platform}`);
  if (!row.credentials_encrypted) throw new Error(`CX3-011B: у social account ${accountId} отсутствуют зашифрованные credentials`);
  return row;
}

function assertCredentialShape(credentials: Record<string, unknown>): void {
  for (const field of REQUIRED_CREDENTIAL_FIELDS) {
    const value = credentials[field];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`CX3-011B: Instagram credentials не содержат ${field}`);
  }
}

function assertSourcePostQuarantined(row: Pick<VideoMediaRow, 'post_status' | 'post_editorial_stage' | 'post_schedule_mode' | 'post_target_count'>): void {
  if (
    row.post_status !== 'DRAFT' ||
    row.post_editorial_stage !== 'DRAFT' ||
    row.post_schedule_mode !== 'MANUAL' ||
    Number(row.post_target_count) !== 0
  ) {
    throw new Error(`CX3-011B: source post должен быть target-free MANUAL DRAFT/DRAFT; получено status=${row.post_status}, editorial=${row.post_editorial_stage}, schedule=${row.post_schedule_mode}, targets=${row.post_target_count}`);
  }
}

function videoMedia(mediaId: string): VideoMediaRow {
  const row = db.prepare(`SELECT m.*,
      p.content_format AS post_content_format,
      p.status AS post_status,
      p.editorial_stage AS post_editorial_stage,
      p.schedule_mode AS post_schedule_mode,
      (SELECT COUNT(*) FROM post_targets pt WHERE pt.post_id=p.id) AS post_target_count,
      cm.role AS media_role
    FROM media m
    JOIN posts p ON p.id=m.post_id
    LEFT JOIN content_media cm ON cm.post_id=m.post_id AND cm.media_id=m.id
    WHERE m.id=?`).get(mediaId) as VideoMediaRow | undefined;
  if (!row) throw new Error(`CX3-011B: media ${mediaId} не найден`);
  if (row.mime_type !== 'video/mp4') throw new Error(`CX3-011B: media ${mediaId} имеет ${row.mime_type}, нужен video/mp4`);
  if (!['VIDEO', 'VERTICAL_VIDEO'].includes(row.post_content_format)) {
    throw new Error(`CX3-011B: media ${mediaId} принадлежит посту content_format=${row.post_content_format}, нужен VIDEO/VERTICAL_VIDEO`);
  }
  if (row.media_role && row.media_role !== 'video') throw new Error(`CX3-011B: media ${mediaId} имеет role=${row.media_role}, нужен video`);
  assertSourcePostQuarantined(row);
  return row;
}

function recheckSourcePostQuarantine(postId: string): void {
  const row = db.prepare(`SELECT status AS post_status,
      editorial_stage AS post_editorial_stage,
      schedule_mode AS post_schedule_mode,
      (SELECT COUNT(*) FROM post_targets pt WHERE pt.post_id=posts.id) AS post_target_count
    FROM posts WHERE id=?`).get(postId) as Pick<VideoMediaRow, 'post_status' | 'post_editorial_stage' | 'post_schedule_mode' | 'post_target_count'> | undefined;
  if (!row) throw new Error(`CX3-011B: source post ${postId} исчез до live publish`);
  assertSourcePostQuarantined(row);
}

async function inspectCanonicalMedia(media: VideoMediaRow): Promise<LiveVideoMediaFingerprint> {
  const filePath = mediaAbsolutePath(media);
  const stat = await fsp.stat(filePath).catch((error: unknown) => {
    throw new Error(`CX3-011B: локальный video asset недоступен: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!stat.isFile() || stat.size <= 0) throw new Error('CX3-011B: video asset должен быть непустым обычным файлом');
  if (stat.size !== media.size_bytes) throw new Error(`CX3-011B: размер файла ${stat.size} не совпадает с БД ${media.size_bytes}`);
  const actualSha = await sha256File(filePath);
  if (actualSha.toLowerCase() !== media.sha256.toLowerCase()) throw new Error('CX3-011B: SHA-256 файла не совпадает с canonical media record');

  const { stdout } = await execFileAsync(config.ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate',
    '-of', 'json',
    filePath
  ], { maxBuffer: 4 * 1024 * 1024 });
  const body = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }>;
  };
  const streams = Array.isArray(body.streams) ? body.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(body.format?.duration || 0);
  const fps = parseRate(video?.r_frame_rate);
  const container = normalizeContainer(body.format?.format_name);
  if (!video?.codec_name || !video.width || !video.height || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(fps) || fps <= 0 || !container) {
    throw new Error('CX3-011B: ffprobe не подтвердил codec/dimensions/duration/fps/container');
  }

  const fingerprint: LiveVideoMediaFingerprint = {
    mediaId: media.id,
    originalName: media.original_name,
    sizeBytes: stat.size,
    sha256: actualSha,
    width: Number(video.width),
    height: Number(video.height),
    durationMs: Math.round(durationSeconds * 1000),
    fps: Math.round(fps * 1000) / 1000,
    videoCodec: String(video.codec_name).toLowerCase(),
    audioCodec: audio?.codec_name ? String(audio.codec_name).toLowerCase() : null,
    container
  };
  if (fingerprint.height <= fingerprint.width) throw new Error(`CX3-011B: Short asset должен быть вертикальным, получен ${fingerprint.width}x${fingerprint.height}`);
  if (media.video_codec && fingerprint.videoCodec !== media.video_codec.toLowerCase()) throw new Error(`CX3-011B: ffprobe video codec ${fingerprint.videoCodec} не совпадает с БД ${media.video_codec}`);
  if ((media.audio_codec || null) !== (fingerprint.audioCodec || null)) throw new Error(`CX3-011B: ffprobe audio codec ${fingerprint.audioCodec || 'none'} не совпадает с БД ${media.audio_codec || 'none'}`);
  if (media.container && fingerprint.container !== media.container.toLowerCase()) throw new Error(`CX3-011B: ffprobe container ${fingerprint.container} не совпадает с БД ${media.container}`);
  return fingerprint;
}

function publishMediaRow(media: VideoMediaRow, fingerprint: LiveVideoMediaFingerprint): MediaRow {
  return {
    ...media,
    size_bytes: fingerprint.sizeBytes,
    width: fingerprint.width,
    height: fingerprint.height,
    duration_ms: fingerprint.durationMs,
    fps: fingerprint.fps,
    video_codec: fingerprint.videoCodec,
    audio_codec: fingerprint.audioCodec,
    container: fingerprint.container
  };
}

function evidenceDirectory(): string {
  return path.join(config.dataDir, 'live-acceptance-evidence');
}

function evidenceOutputPath(runId: string): string {
  return path.join(evidenceDirectory(), `${runId}.json`);
}

async function writeEvidence(filePath: string, evidence: LiveInstagramShortAcceptanceEvidence): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(filePath, 0o600);
}

async function readEvidence(filePath: string): Promise<LiveInstagramShortAcceptanceEvidence> {
  const raw = await fsp.readFile(filePath, 'utf8');
  return validateLiveInstagramShortAcceptanceEvidence(JSON.parse(raw));
}

async function findBlockingEvidence(params: { buildSha: string; accountId: string; mediaId: string }): Promise<{ filePath: string; evidence: LiveInstagramShortAcceptanceEvidence } | null> {
  let names: string[];
  try {
    names = await fsp.readdir(evidenceDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const name of names.filter((value) => value.endsWith('.json')).sort()) {
    const filePath = path.join(evidenceDirectory(), name);
    try {
      const evidence = await readEvidence(filePath);
      if (evidence.buildSha === params.buildSha && evidence.account.id === params.accountId && evidence.media.mediaId === params.mediaId) {
        return { filePath, evidence };
      }
    } catch {
      // CX3-008F evidence and unrelated/corrupt files are intentionally ignored by the CX3-011B validator.
    }
  }
  return null;
}

function liveLockPath(params: { buildSha: string; accountId: string; mediaId: string }): string {
  const key = crypto.createHash('sha256')
    .update([params.buildSha, 'instagram', 'SHORT', 'VERTICAL_VIDEO', params.accountId, params.mediaId].join('\u0000'))
    .digest('hex');
  return path.join(evidenceDirectory(), `.cx3-011b-${key}.lock`);
}

async function acquireLiveLock(params: { buildSha: string; accountId: string; mediaId: string }): Promise<LiveLock> {
  await fsp.mkdir(evidenceDirectory(), { recursive: true });
  const filePath = liveLockPath(params);
  let handle;
  try {
    handle = await fsp.open(filePath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      let detail = '';
      try { detail = (await fsp.readFile(filePath, 'utf8')).slice(0, 2000); } catch { detail = ''; }
      throw new Error(`CX3-011B: live lock уже существует. Предыдущий/параллельный Short запуск должен быть вручную разрешён: ${filePath}${detail ? `; lock=${detail}` : ''}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      checkpoint: 'CX3-011B',
      phase: 'LOCKED_PRE_PUBLISH',
      createdAt: new Date().toISOString(),
      pid: process.pid,
      buildSha: params.buildSha,
      platform: 'instagram',
      publicationKind: 'SHORT',
      contentFormat: 'VERTICAL_VIDEO',
      accountId: params.accountId,
      mediaId: params.mediaId
    }, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.chmod(filePath, 0o600);
  return {
    filePath,
    update: async (payload) => {
      await fsp.writeFile(filePath, `${JSON.stringify({
        checkpoint: 'CX3-011B',
        updatedAt: new Date().toISOString(),
        buildSha: params.buildSha,
        platform: 'instagram',
        publicationKind: 'SHORT',
        contentFormat: 'VERTICAL_VIDEO',
        accountId: params.accountId,
        mediaId: params.mediaId,
        ...payload
      }, null, 2)}\n`, { mode: 0o600 });
      await fsp.chmod(filePath, 0o600);
    },
    release: async () => {
      await fsp.rm(filePath, { force: true });
    }
  };
}

function redactFailureMessage(message: string, credentials: Record<string, unknown>, publicVideoUrl: string): string {
  let redacted = message;
  for (const value of Object.values(credentials)) {
    if (typeof value === 'string' && value.length >= 4) redacted = redacted.split(value).join('[REDACTED]');
  }
  try {
    const url = new URL(publicVideoUrl);
    const safe = new URL(publicVideoUrl);
    safe.search = '';
    safe.hash = '';
    redacted = redacted.split(url.toString()).join(safe.toString());
  } catch {
    redacted = redacted.split(publicVideoUrl).join('[REDACTED_URL]');
  }
  return redacted.slice(0, 2000) || 'Unknown external publication error';
}

function assertPublishBuildIdentity(): string {
  const sha = config.appBuildSha.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('CX3-011B: live publish разрешён только на build с доказуемым IMAGE_BUILD_SHA/APP_BUILD_SHA');
  return sha;
}

function safeRunId(): string {
  return `instagram-short-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
}

async function confirmVisible(args: Args): Promise<void> {
  assertVisibilityGuard(true);
  if (!args.evidence) throw new Error('CX3-011B: --confirm-visible требует --evidence');
  const filePath = path.resolve(args.evidence);
  const current = await readEvidence(filePath);
  const confirmed = confirmLiveInstagramShortAcceptanceEvidence(current, {
    confirmedAt: new Date().toISOString(),
    note: args.note || null
  });
  await writeEvidence(filePath, confirmed);
  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'CX3-011B',
    status: confirmed.status,
    platform: confirmed.platform,
    publicationKind: confirmed.publicationKind,
    contentFormat: confirmed.contentFormat,
    runId: confirmed.runId,
    buildSha: confirmed.buildSha,
    accountId: confirmed.account.id,
    mediaId: confirmed.media.mediaId,
    externalId: confirmed.result.externalId,
    evidencePath: filePath,
    capabilityChanged: false,
    next: 'Evidence PASSED после ручной проверки видимости. supportsShortVideo/supportsVideo остаются закрыты до отдельного reviewed enablement.'
  }, null, 2));
}

async function planOrPublish(args: Args): Promise<void> {
  if (!args.account) throw new Error('CX3-011B: нужен --account <social_accounts.id>');
  if (!args.media) throw new Error('CX3-011B: нужен --media <media.id>');
  const account = accountSummary(args.account);
  const media = videoMedia(args.media);
  const fingerprint = await inspectCanonicalMedia(media);
  const publicVideoUrl = mediaPublicUrl(media);

  if (!args.publish) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'PLAN_ONLY',
      checkpoint: 'CX3-011B',
      platform: 'instagram',
      account: { id: account.id, name: account.name },
      publicationKind: 'SHORT',
      contentFormat: 'VERTICAL_VIDEO',
      sourcePost: {
        id: media.post_id,
        status: media.post_status,
        editorialStage: media.post_editorial_stage,
        scheduleMode: media.post_schedule_mode,
        targetCount: media.post_target_count
      },
      media: fingerprint,
      buildSha: config.appBuildSha || null,
      publicVideoUrlRequired: true,
      publicVideoUrl,
      credentialsDecrypted: false,
      externalRequestPerformed: false,
      capabilityChanged: false,
      next: `Для одной реальной контрольной публикации добавьте --publish и PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM=${LIVE_VIDEO_CONFIRMATION}.`
    }, null, 2));
    return;
  }

  if (args.evidence) throw new Error('CX3-011B: --evidence используется только с --confirm-visible; publish пишет evidence в защищённый DATA_DIR');
  assertPublishGuard(true);
  const buildSha = assertPublishBuildIdentity();
  const lock = await acquireLiveLock({ buildSha, accountId: account.id, mediaId: media.id });
  let releaseLock = false;
  let publicAttemptStarted = false;

  try {
    const blocking = await findBlockingEvidence({ buildSha, accountId: account.id, mediaId: media.id });
    if (blocking) {
      releaseLock = true;
      throw new Error(`CX3-011B: повторная live Short публикация для этого build/account/media заблокирована: ${blocking.evidence.status}; evidence=${blocking.filePath}`);
    }

    const accountSecretRow = accountWithCredentials(account.id);
    const credentials = decryptJson<Record<string, unknown>>(accountSecretRow.credentials_encrypted!);
    assertCredentialShape(credentials);

    const runId = safeRunId();
    const startedAt = new Date().toISOString();
    const connection = await testConnection('instagram', credentials);
    recheckSourcePostQuarantine(media.post_id);

    const input: PublishInput = {
      postId: media.post_id,
      title: `Publikator CX3-011B ${runId}`,
      text: args.text?.trim() || `Publikator CX3-011B live Instagram Short acceptance ${runId}`,
      media: [publishMediaRow(media, fingerprint)],
      credentials,
      publicMediaUrls: [publicVideoUrl],
      publicationKind: 'SHORT',
      contentFormat: 'VERTICAL_VIDEO'
    };
    const publisher = getPublisher('instagram');
    publisher.validate(input);

    console.log(JSON.stringify({
      checkpoint: 'CX3-011B',
      phase: 'CONNECTION_VERIFIED',
      platform: 'instagram',
      publicationKind: 'SHORT',
      contentFormat: 'VERTICAL_VIDEO',
      account: { id: account.id, name: account.name },
      identity: connection.identity,
      destination: connection.destination,
      mediaId: media.id,
      runId,
      lockPath: lock.filePath,
      next: 'Следующий вызов — ровно один реальный publisher.publish для контрольного Instagram Short.'
    }, null, 2));

    await lock.update({ phase: 'PUBLIC_PUBLISH_STARTING', runId, startedAt });
    publicAttemptStarted = true;

    let result;
    try {
      result = await publisher.publish(input);
    } catch (error) {
      if (error instanceof PlatformError && !error.outcomeUnknown) {
        releaseLock = true;
        throw error;
      }
      const message = redactFailureMessage(error instanceof Error ? error.message : String(error), credentials, publicVideoUrl);
      const recovery = buildLiveInstagramShortRecoveryEvidence({
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        buildSha,
        account: { id: account.id, name: account.name },
        connection: { identity: connection.identity, destination: connection.destination },
        media: fingerprint,
        publicVideoUrl,
        message,
        code: error instanceof PlatformError ? error.code ?? null : null
      });
      const filePath = evidenceOutputPath(runId);
      try {
        await writeEvidence(filePath, recovery);
        await lock.update({ phase: 'RECOVERY_RECORDED', runId, evidencePath: filePath });
        releaseLock = true;
      } catch (persistError) {
        try {
          await lock.update({
            phase: 'RECOVERY_PERSIST_FAILED',
            runId,
            failure: message,
            persistenceError: persistError instanceof Error ? persistError.message.slice(0, 1000) : String(persistError).slice(0, 1000)
          });
        } catch {
          // Keep the lock if even recovery persistence diagnostics cannot be updated.
        }
        throw new Error(`CX3-011B RECOVERY_NEEDED: внешний результат неопределён, recovery evidence сохранить не удалось. Lock оставлен: ${lock.filePath}`);
      }
      throw new Error(`CX3-011B RECOVERY_NEEDED: внешний результат неопределён. НЕ повторяйте публикацию автоматически. Evidence: ${filePath}`);
    }

    try {
      await lock.update({ phase: 'API_RETURNED', runId, externalId: result.externalId });
    } catch {
      throw new Error(`CX3-011B: API вернул externalId=${result.externalId}, но lock-state не удалось обновить. Lock оставлен: ${lock.filePath}`);
    }

    const evidence = buildLiveInstagramShortAcceptanceEvidence({
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      buildSha,
      account: { id: account.id, name: account.name },
      connection: { identity: connection.identity, destination: connection.destination },
      media: fingerprint,
      publicVideoUrl,
      externalId: result.externalId,
      externalUrl: result.externalUrl || null
    });
    const filePath = evidenceOutputPath(runId);
    try {
      await writeEvidence(filePath, evidence);
      await lock.update({ phase: 'API_CONFIRMED_RECORDED', runId, evidencePath: filePath, externalId: result.externalId });
      releaseLock = true;
    } catch (persistError) {
      try {
        await lock.update({
          phase: 'EVIDENCE_PERSIST_FAILED',
          runId,
          externalId: result.externalId,
          persistenceError: persistError instanceof Error ? persistError.message.slice(0, 1000) : String(persistError).slice(0, 1000)
        });
      } catch {
        // Existing lock proves that the public attempt started.
      }
      throw new Error(`CX3-011B: API подтвердил externalId=${result.externalId}, но evidence сохранить не удалось. НЕ повторяйте публикацию; lock оставлен: ${lock.filePath}`);
    }

    console.log(JSON.stringify({
      ok: true,
      checkpoint: 'CX3-011B',
      status: evidence.status,
      platform: evidence.platform,
      publicationKind: evidence.publicationKind,
      contentFormat: evidence.contentFormat,
      runId,
      externalId: evidence.result.externalId,
      externalUrl: evidence.result.externalUrl,
      evidencePath: filePath,
      credentialsRecorded: false,
      capabilityChanged: false,
      next: `API подтвердил Short, но это ещё не PASS. Проверьте публикацию визуально, затем выполните --confirm-visible с PUBLIKATOR_LIVE_VISIBILITY_CONFIRM=${LIVE_VIDEO_VISIBILITY_CONFIRMATION}.`
    }, null, 2));
  } catch (error) {
    if (!publicAttemptStarted) releaseLock = true;
    throw error;
  } finally {
    if (releaseLock) await lock.release();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.confirmVisible) {
    await confirmVisible(args);
    return;
  }
  await planOrPublish(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
