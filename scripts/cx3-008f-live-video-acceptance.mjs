import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PLATFORMS = new Set(['telegram', 'vk', 'max', 'instagram']);

function usage() {
  return `CX3-008F live FEED/VIDEO acceptance

Safe plan only:
  node scripts/cx3-008f-live-video-acceptance.mjs --platform telegram --video ./acceptance.mp4

Real external publication:
  PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM=I_UNDERSTAND_THIS_WILL_PUBLISH_EXTERNALLY \\
  node scripts/cx3-008f-live-video-acceptance.mjs --publish --platform telegram --video ./acceptance.mp4 --credentials ./telegram.credentials.json

Instagram additionally requires:
  --public-url https://public.example/video.mp4

Options:
  --platform <telegram|vk|max|instagram>
  --video <local canonical MP4>
  --credentials <local JSON file; required only with --publish>
  --public-url <public HTTPS URL; required for Instagram publish>
  --text <caption/text for the control publication>
  --evidence <output JSON path; default DATA_DIR/live-acceptance-evidence/...>
  --publish <perform the real external publication; otherwise plan-only>
  --help

The runner bypasses the production capability flag only for this explicit acceptance command.
It never changes supportsVideo and never writes credentials into evidence.`;
}

function parseArgs(argv) {
  const result = { publish: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--publish') {
      result.publish = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Неизвестный аргумент ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Для --${key} требуется значение`);
    result[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return result;
}

function parseRate(value) {
  const [left, right] = String(value || '0/1').split('/').map(Number);
  if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) return 0;
  return left / right;
}

function normalizeContainer(formatName) {
  const values = String(formatName || '').toLowerCase().split(',').map((value) => value.trim());
  return values.includes('mp4') ? 'mp4' : (values[0] || '');
}

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function inspectVideo(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Видео должно быть непустым обычным файлом');
  const ffprobe = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate',
    '-of', 'json',
    filePath
  ], { maxBuffer: 4 * 1024 * 1024 });
  const body = JSON.parse(stdout);
  const streams = Array.isArray(body?.streams) ? body.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  const audio = streams.find((stream) => stream?.codec_type === 'audio');
  const durationSeconds = Number(body?.format?.duration || 0);
  if (!video?.codec_name || !video?.width || !video?.height || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('ffprobe не подтвердил корректный video stream, dimensions и duration');
  }
  const fps = parseRate(video.r_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('ffprobe не подтвердил положительный FPS');
  const container = normalizeContainer(body?.format?.format_name);
  if (!container) throw new Error('ffprobe не подтвердил container');

  return {
    originalName: path.basename(filePath),
    sizeBytes: stat.size,
    sha256: await sha256File(filePath),
    width: Number(video.width),
    height: Number(video.height),
    durationMs: Math.round(durationSeconds * 1000),
    fps: Math.round(fps * 1000) / 1000,
    videoCodec: String(video.codec_name).toLowerCase(),
    audioCodec: audio?.codec_name ? String(audio.codec_name).toLowerCase() : null,
    container
  };
}

function publicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function readCredentials(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Credentials file должен содержать JSON object');
  }
  return parsed;
}

function safeRunId(platform) {
  return `${platform}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
}

async function writeEvidence(evidence, explicitPath, dataDir) {
  const outputPath = explicitPath
    ? path.resolve(explicitPath)
    : path.join(dataDir, 'live-acceptance-evidence', `${evidence.runId}.json`);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return outputPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const platform = String(args.platform || '').trim().toLowerCase();
  if (!PLATFORMS.has(platform)) throw new Error('--platform должен быть telegram, vk, max или instagram');
  if (!args.video) throw new Error('--video обязателен');
  const sourceVideoPath = path.resolve(args.video);
  if (path.extname(sourceVideoPath).toLowerCase() !== '.mp4') throw new Error('CX3-008F принимает только canonical .mp4');

  const mediaFingerprint = await inspectVideo(sourceVideoPath);
  const core = await import('../dist/platforms/live-video-acceptance.js');

  if (!args.publish) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'PLAN_ONLY',
      checkpoint: 'CX3-008F',
      platform,
      publicationKind: 'FEED',
      contentFormat: 'VIDEO',
      media: mediaFingerprint,
      requiredCredentialFields: core.LIVE_VIDEO_CREDENTIAL_FIELDS[platform],
      publicVideoUrlRequired: platform === 'instagram',
      externalPublicationPerformed: false,
      next: `Добавьте --publish и PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM=${core.LIVE_VIDEO_CONFIRMATION} только когда готовы создать реальную публикацию.`
    }, null, 2));
    return;
  }

  core.assertLivePublishGuard({
    publish: true,
    confirmation: process.env.PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM
  });
  if (!args.credentials) throw new Error('--credentials обязателен при --publish');
  const credentialsPath = path.resolve(args.credentials);
  const credentials = await readCredentials(credentialsPath);
  core.assertLiveCredentialShape(platform, credentials);

  const publicVideoUrl = platform === 'instagram' ? String(args.publicUrl || '').trim() : null;
  if (platform === 'instagram' && !publicHttpsUrl(publicVideoUrl)) {
    throw new Error('Instagram live acceptance требует --public-url с публичным HTTPS URL без credentials');
  }

  const runId = safeRunId(platform);
  const postId = `live-acceptance-${runId}`;
  const dataDir = path.resolve(process.env.DATA_DIR?.trim() || 'data');
  const mediaDir = path.join(dataDir, 'media');
  const runMediaDir = path.join(mediaDir, postId);
  const stagedName = 'acceptance.mp4';
  const stagedPath = path.join(runMediaDir, stagedName);
  const relativePath = path.posix.join(postId, stagedName);
  await fsp.mkdir(runMediaDir, { recursive: true });
  await fsp.copyFile(sourceVideoPath, stagedPath);

  const startedAt = new Date().toISOString();
  try {
    const [{ getPublisher }, { testConnection }] = await Promise.all([
      import('../dist/platforms/index.js'),
      import('../dist/platforms/connection-test.js')
    ]);
    const publisher = getPublisher(platform);
    const media = {
      id: `live-media-${runId}`,
      post_id: postId,
      original_name: mediaFingerprint.originalName,
      relative_path: relativePath,
      mime_type: 'video/mp4',
      size_bytes: mediaFingerprint.sizeBytes,
      width: mediaFingerprint.width,
      height: mediaFingerprint.height,
      sha256: mediaFingerprint.sha256,
      created_at: startedAt,
      sort_order: 0,
      duration_ms: mediaFingerprint.durationMs,
      fps: mediaFingerprint.fps,
      video_codec: mediaFingerprint.videoCodec,
      audio_codec: mediaFingerprint.audioCodec,
      container: mediaFingerprint.container,
      poster_asset_id: null
    };
    const input = {
      postId,
      title: `Publikator CX3-008F ${runId}`,
      text: String(args.text || `Publikator CX3-008F live FEED/VIDEO acceptance ${runId}`),
      media: [media],
      credentials,
      publicMediaUrls: publicVideoUrl ? [publicVideoUrl] : [],
      publicationKind: 'FEED',
      contentFormat: 'VIDEO'
    };

    // Validate the exact adapter input before any platform connection or public side effect.
    publisher.validate(input);

    const connection = await testConnection(platform, credentials);
    console.log(JSON.stringify({
      checkpoint: 'CX3-008F',
      phase: 'CONNECTION_VERIFIED',
      platform,
      identity: connection.identity,
      destination: connection.destination,
      runId
    }, null, 2));

    const result = await publisher.publish(input);
    const completedAt = new Date().toISOString();
    const evidence = core.buildLiveVideoAcceptanceEvidence({
      runId,
      platform,
      startedAt,
      completedAt,
      buildSha: process.env.IMAGE_BUILD_SHA?.trim() || process.env.APP_BUILD_SHA?.trim() || null,
      connection: {
        identity: connection.identity,
        destination: connection.destination
      },
      media: mediaFingerprint,
      publicVideoUrl,
      externalId: result.externalId,
      externalUrl: result.externalUrl || null
    });
    core.validateLiveVideoAcceptanceEvidence(evidence);
    const evidencePath = await writeEvidence(evidence, args.evidence, dataDir);

    console.log(JSON.stringify({
      ok: true,
      checkpoint: 'CX3-008F',
      status: 'PASSED',
      platform,
      runId,
      externalId: result.externalId,
      externalUrl: result.externalUrl || null,
      evidencePath,
      credentialsRecorded: false,
      capabilityChanged: false,
      next: 'Проверьте публикацию визуально на целевой платформе. Только после ручного подтверждения evidence можно отдельным review изменить supportsVideo.'
    }, null, 2));
  } finally {
    await fsp.rm(runMediaDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`CX3-008F live acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
