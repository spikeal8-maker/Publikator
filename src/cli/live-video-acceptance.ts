import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { decryptJson } from '../crypto.js';
import { db, type Platform } from '../db.js';
import { mediaAbsolutePath, mediaPublicUrl, type MediaRow } from '../media.js';
import { testConnection } from '../platforms/connection-test.js';
import { getPublisher } from '../platforms/index.js';
import {
  LIVE_VIDEO_CONFIRMATION,
  LIVE_VIDEO_VISIBILITY_CONFIRMATION,
  assertLiveCredentialShape,
  assertLivePublishGuard,
  assertLiveVisibilityGuard,
  buildLiveVideoAcceptanceEvidence,
  buildLiveVideoRecoveryEvidence,
  confirmLiveVideoAcceptanceEvidence,
  validateLiveVideoAcceptanceEvidence,
  type LiveVideoAcceptanceEvidence,
  type LiveVideoMediaFingerprint
} from '../platforms/live-video-acceptance.js';
import { PlatformError, type PublishInput } from '../platforms/types.js';

const execFileAsync = promisify(execFile);

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
  platform: Platform;
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
  return `CX3-008F live FEED/VIDEO acceptance

Plan-only, no external request and no credential decryption:
  node dist/cli/live-video-acceptance.js --account acc_... --media med_...

Real external publication using the encrypted account already stored in Publikator:
  PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM=${LIVE_VIDEO_CONFIRMATION} \\
  node dist/cli/live-video-acceptance.js --publish --account acc_... --media med_...

After visually checking that the control video is really visible on the target platform:
  PUBLIKATOR_LIVE_VISIBILITY_CONFIRM=${LIVE_VIDEO_VISIBILITY_CONFIRMATION} \\
  node dist/cli/live-video-acceptance.js --confirm-visible --evidence /app/data/live-acceptance-evidence/<run>.json --note "Visible in target feed"

Options:
  --account <social_accounts.id>   Existing enabled Publikator social account
  --media <media.id>               Canonical video from a target-free MANUAL DRAFT post
  --text <caption>                 Optional control publication text
  --evidence <path>                Required only by --confirm-visible; live publish always uses protected DATA_DIR evidence storage
  --note <text>                    Optional note for --confirm-visible
  --publish                        Perform exactly one real external FEED/VIDEO publication
  --confirm-visible                Convert API_CONFIRMED evidence to PASSED after manual visual verification
  --help

Safety invariants:
- normal capability preflight remains unchanged and supportsVideo is not modified;
- source media must belong to a target-free MANUAL post in DRAFT/DRAFT state so scheduler cannot publish it independently;
- credentials are decrypted only after the explicit publish guard succeeds;
- same build/account/media cannot be published again while prior live evidence exists;
- concurrent live runs for the same build/account/media are serialized by a crash-safe lock file;
- an interrupted public attempt leaves the lock in place and blocks blind retry;
- a RECOVERY_NEEDED result is persisted if the public POST outcome is uncertain;
- credentials, encrypted payloads and signed URL query strings are never written to evidence.`;
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
  if (!row) throw new Error(`CX3-008F: social account ${accountId} не найден`);
  if (!row.enabled) throw new Error(`CX3-008F: social account ${accountId} отключён`);
  return row;
}

function accountWithCredentials(accountId: string): AccountRow {
  const row = db.prepare('SELECT id,platform,name,enabled,credentials_encrypted FROM social_accounts WHERE id=?').get(accountId) as AccountRow | undefined;
  if (!row) throw new Error(`CX3-008F: social account ${accountId} не найден`);
  if (!row.enabled) throw new Error(`CX3-008F: social account ${accountId} отключён`);
  if (!row.credentials_encrypted) throw new Error(`CX3-008F: у social account ${accountId} отсутствуют зашифрованные credentials`);
  return row;
}

function assertSourcePostQuarantined(row: Pick<VideoMediaRow, 'post_status' | 'post_editorial_stage' | 'post_schedule_mode' | 'post_target_count'>): void {
  if (
    row.post_status !== 'DRAFT' ||
    row.post_editorial_stage !== 'DRAFT' ||
    row.post_schedule_mode !== 'MANUAL' ||
    Number(row.post_target_count) !== 0
  ) {
    throw new Error(`CX3-008F: source post должен быть target-free MANUAL DRAFT/DRAFT; получено status=${row.post_status}, editorial=${row.post_editorial_stage}, schedule=${row.post_schedule_mode}, targets=${row.post_target_count}`);
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
  if (!row) throw new Error(`CX3-008F: media ${mediaId} не найден`);
  if (row.mime_type !== 'video/mp4') throw new Error(`CX3-008F: media ${mediaId} имеет ${row.mime_type}, нужен video/mp4`);
  if (row.post_content_format !== 'VIDEO') {
    throw new Error(`CX3-008F: media ${mediaId} принадлежит посту content_format=${row.post_content_format}, нужен VIDEO`);
  }
  if (row.media_role && row.media_role !== 'video') {
    throw new Error(`CX3-008F: media ${mediaId} имеет role=${row.media_role}, нужен video`);
  }
  assertSourcePostQuarantined(row);
  return row;
}

function recheckSourcePostQuarantine(postId: string): void {
  const row = db.prepare(`SELECT status AS post_status,
      editorial_stage AS post_editorial_stage,
      schedule_mode AS post_schedule_mode,
      (SELECT COUNT(*) FROM post_targets pt WHERE pt.post_id=posts.id) AS post_target_count
    FROM posts WHERE id=?`).get(postId) as Pick<VideoMediaRow, 'post_status' | 'post_editorial_stage' | 'post_schedule_mode' | 'post_target_count'> | undefined;
  if (!row) throw new Error(`CX3-008F: source post ${postId} исчез до live publish`);
  assertSourcePostQuarantined(row);
}

async function inspectCanonicalMedia(media: VideoMediaRow): Promise<LiveVideoMediaFingerprint> {
  const filePath = mediaAbsolutePath(media);
  const stat = await fsp.stat(filePath).catch((error: unknown) => {
    throw new Error(`CX3-008F: локальный video asset недоступен: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!stat.isFile() || stat.size <= 0) throw new Error('CX3-008F: video asset должен быть непустым обычным файлом');
  if (stat.size !== media.size_bytes) {
    throw new Error(`CX3-008F: размер файла ${stat.size} не совпадает с БД ${media.size_bytes}`);
  }
  const actualSha = await sha256File(filePath);
  if (actualSha.toLowerCase() !== media.sha256.toLowerCase()) {
    throw new Error('CX3-008F: SHA-256 файла не совпадает с canonical media record');
  }

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
    throw new Error('CX3-008F: ffprobe не подтвердил codec/dimensions/duration/fps/container');
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

  if (media.video_codec && fingerprint.videoCodec !== media.video_codec.toLowerCase()) {
    throw new Error(`CX3-008F: ffprobe video codec ${fingerprint.videoCodec} не совпадает с БД ${media.video_codec}`);
  }
  if ((media.audio_codec || null) !== (fingerprint.audioCodec || null)) {
    throw new Error(`CX3-008F: ffprobe audio codec ${fingerprint.audioCodec || 'none'} не совпадает с БД ${media.audio_codec || 'none'}`);
  }
  if (media.container && fingerprint.container !== media.container.toLowerCase()) {
    throw new Error(`CX3-008F: ffprobe container ${fingerprint.container} не совпадает с БД ${media.container}`);
  }
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

async function writeEvidence(filePath: string, evidence: LiveVideoAcceptanceEvidence): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(filePath, 0o600);
}

async function readEvidence(filePath: string): Promise<LiveVideoAcceptanceEvidence> {
  const raw = await fsp.readFile(filePath, 'utf8');
  return validateLiveVideoAcceptanceEvidence(JSON.parse(raw));
}

async function findBlockingEvidence(params: {
  buildSha: string;
  platform: Platform;
  accountId: string;
  mediaId: string;
}): Promise<{ filePath: string; evidence: LiveVideoAcceptanceEvidence } | null> {
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
      if (
        evidence.buildSha === params.buildSha &&
        evidence.platform === params.platform &&
        evidence.account.id === params.accountId &&
        evidence.media.mediaId === params.mediaId
      ) {
        return { filePath, evidence };
      }
    } catch {
      // Ignore unrelated/corrupt files here; an interrupted publish is additionally protected by the live lock file.
    }
  }
  return null;
}

function liveLockPath(params: { buildSha: string; platform: Platform; accountId: string; mediaId: string }): string {
  const key = crypto.createHash('sha256')
    .update([params.buildSha, params.platform, params.accountId, params.mediaId].join('\u0000'))
    .digest('hex');
  return path.join(evidenceDirectory(), `.cx3-008f-${key}.lock`);
}

async function acquireLiveLock(params: {
  buildSha: string;
  platform: Platform;
  accountId: string;
  mediaId: string;
}): Promise<LiveLock> {
  await fsp.mkdir(evidenceDirectory(), { recursive: true });
  const filePath = liveLockPath(params);
  let handle;
  try {
    handle = await fsp.open(filePath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      let detail = '';
      try { detail = (await fsp.readFile(filePath, 'utf8')).slice(0, 2000); } catch { detail = ''; }
      throw new Error(`CX3-008F: live lock уже существует. Предыдущий/параллельный запуск должен быть вручную разрешён до новой публикации: ${filePath}${detail ? `; lock=${detail}` : ''}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      checkpoint: 'CX3-008F',
      phase: 'LOCKED_PRE_PUBLISH',
      createdAt: new Date().toISOString(),
      pid: process.pid,
      buildSha: params.buildSha,
      platform: params.platform,
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
        checkpoint: 'CX3-008F',
        updatedAt: new Date().toISOString(),
        buildSha: params.buildSha,
        platform: params.platform,
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

function redactFailureMessage(message: string, credentials: Record<string, unknown>, publicVideoUrl: string | null): string {
  let redacted = message;
  for (const value of Object.values(credentials)) {
    if (typeof value === 'string' && value.length >= 4) redacted = redacted.split(value).join('[REDACTED]');
  }
  if (publicVideoUrl) {
    try {
      const url = new URL(publicVideoUrl);
      const safe = new URL(publicVideoUrl);
      safe.search = '';
      safe.hash = '';
      redacted = redacted.split(url.toString()).join(safe.toString());
    } catch {
      redacted = redacted.split(publicVideoUrl).join('[REDACTED_URL]');
    }
  }
  return redacted.slice(0, 2000) || 'Unknown external publication error';
}

function assertPublishBuildIdentity(): string {
  const sha = config.appBuildSha.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('CX3-008F: live publish разрешён только на build с доказуемым IMAGE_BUILD_SHA/APP_BUILD_SHA');
  }
  return sha;
}

function safeRunId(platform: Platform): string {
  return `${platform}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
}

async function confirmVisible(args: Args): Promise<void> {
  assertLiveVisibilityGuard({
    confirmVisible: true,
    confirmation: process.env.PUBLIKATOR_LIVE_VISIBILITY_CONFIRM
  });
  if (!args.evidence) throw new Error('CX3-008F: --confirm-visible требует --evidence');
  const filePath = path.resolve(args.evidence);
  const current = await readEvidence(filePath);
  const confirmed = confirmLiveVideoAcceptanceEvidence(current, {
    confirmedAt: new Date().toISOString(),
    note: args.note || null
  });
  await writeEvidence(filePath, confirmed);
  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'CX3-008F',
    status: confirmed.status,
    platform: confirmed.platform,
    runId: confirmed.runId,
    buildSha: confirmed.buildSha,
    accountId: confirmed.account.id,
    mediaId: confirmed.media.mediaId,
    externalId: confirmed.result.externalId,
    evidencePath: filePath,
    capabilityChanged: false,
    next: 'Evidence имеет PASSED после ручной проверки видимости. supportsVideo всё ещё закрыт и может быть изменён только отдельным code review.'
  }, null, 2));
}

async function planOrPublish(args: Args): Promise<void> {
  if (!args.account) throw new Error('CX3-008F: нужен --account <social_accounts.id>');
  if (!args.media) throw new Error('CX3-008F: нужен --media <media.id>');
  const account = accountSummary(args.account);
  const media = videoMedia(args.media);
  const fingerprint = await inspectCanonicalMedia(media);
  const publicVideoUrl = account.platform === 'instagram' ? mediaPublicUrl(media) : null;

  if (!args.publish) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'PLAN_ONLY',
      checkpoint: 'CX3-008F',
      platform: account.platform,
      account: { id: account.id, name: account.name },
      publicationKind: 'FEED',
      contentFormat: 'VIDEO',
      sourcePost: {
        id: media.post_id,
        status: media.post_status,
        editorialStage: media.post_editorial_stage,
        scheduleMode: media.post_schedule_mode,
        targetCount: media.post_target_count
      },
      media: fingerprint,
      buildSha: config.appBuildSha || null,
      publicVideoUrlRequired: account.platform === 'instagram',
      publicVideoUrl: publicVideoUrl || null,
      credentialsDecrypted: false,
      externalRequestPerformed: false,
      capabilityChanged: false,
      next: `Для реальной контрольной публикации добавьте --publish и PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM=${LIVE_VIDEO_CONFIRMATION}.`
    }, null, 2));
    return;
  }

  if (args.evidence) throw new Error('CX3-008F: --evidence используется только с --confirm-visible; publish всегда пишет evidence в защищённый DATA_DIR');
  assertLivePublishGuard({
    publish: true,
    confirmation: process.env.PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM
  });
  const buildSha = assertPublishBuildIdentity();
  const lock = await acquireLiveLock({
    buildSha,
    platform: account.platform,
    accountId: account.id,
    mediaId: media.id
  });
  let releaseLock = false;
  let publicAttemptStarted = false;

  try {
    const blocking = await findBlockingEvidence({
      buildSha,
      platform: account.platform,
      accountId: account.id,
      mediaId: media.id
    });
    if (blocking) {
      releaseLock = true;
      throw new Error(`CX3-008F: повторная live публикация для этого build/account/media заблокирована: ${blocking.evidence.status}; evidence=${blocking.filePath}`);
    }

    const accountSecretRow = accountWithCredentials(account.id);
    const credentials = decryptJson<Record<string, unknown>>(accountSecretRow.credentials_encrypted!);
    assertLiveCredentialShape(account.platform, credentials);

    const runId = safeRunId(account.platform);
    const startedAt = new Date().toISOString();
    const connection = await testConnection(account.platform, credentials);
    recheckSourcePostQuarantine(media.post_id);

    const input: PublishInput = {
      postId: media.post_id,
      title: `Publikator CX3-008F ${runId}`,
      text: args.text?.trim() || `Publikator CX3-008F live FEED/VIDEO acceptance ${runId}`,
      media: [publishMediaRow(media, fingerprint)],
      credentials,
      publicMediaUrls: publicVideoUrl ? [publicVideoUrl] : [],
      publicationKind: 'FEED',
      contentFormat: 'VIDEO'
    };
    const publisher = getPublisher(account.platform);
    publisher.validate(input);

    console.log(JSON.stringify({
      checkpoint: 'CX3-008F',
      phase: 'CONNECTION_VERIFIED',
      platform: account.platform,
      account: { id: account.id, name: account.name },
      identity: connection.identity,
      destination: connection.destination,
      mediaId: media.id,
      runId,
      lockPath: lock.filePath,
      next: 'Следующий вызов — ровно один реальный publisher.publish для контрольного FEED/VIDEO.'
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
      const recovery = buildLiveVideoRecoveryEvidence({
        runId,
        platform: account.platform,
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
          // Keep the original lock file even if updating its diagnostic payload also fails.
        }
        throw new Error(`CX3-008F RECOVERY_NEEDED: внешний результат неопределён, а recovery evidence не удалось сохранить. Lock оставлен намеренно: ${lock.filePath}`);
      }
      throw new Error(`CX3-008F RECOVERY_NEEDED: внешний результат неопределён. НЕ повторяйте публикацию автоматически. Evidence: ${filePath}`);
    }

    try {
      await lock.update({
        phase: 'API_RETURNED',
        runId,
        externalId: result.externalId
      });
    } catch {
      throw new Error(`CX3-008F: API вернул externalId=${result.externalId}, но lock-state не удалось обновить. Lock оставлен намеренно: ${lock.filePath}`);
    }

    const evidence = buildLiveVideoAcceptanceEvidence({
      runId,
      platform: account.platform,
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
        // Keep the existing lock file; it already records that a public attempt started.
      }
      throw new Error(`CX3-008F: API подтвердил externalId=${result.externalId}, но evidence не удалось сохранить. НЕ повторяйте публикацию; lock оставлен: ${lock.filePath}`);
    }

    console.log(JSON.stringify({
      ok: true,
      checkpoint: 'CX3-008F',
      status: evidence.status,
      platform: account.platform,
      runId,
      externalId: evidence.result.externalId,
      externalUrl: evidence.result.externalUrl,
      evidencePath: filePath,
      credentialsRecorded: false,
      capabilityChanged: false,
      next: `API подтвердил публикацию, но это ещё не PASS. Проверьте ролик визуально, затем выполните --confirm-visible с PUBLIKATOR_LIVE_VISIBILITY_CONFIRM=${LIVE_VIDEO_VISIBILITY_CONFIRMATION}.`
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
