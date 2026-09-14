import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { config } from './config.js';

const TOOL_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
let reservedTempBytes = 0;

export type PreparedVideoUpload = {
  tempVideoPath: string;
  posterData: Buffer;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number | null;
  videoCodec: 'h264';
  audioCodec: 'aac' | null;
  container: 'mp4';
  cleanup: () => Promise<void>;
};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
};

type ProbeResult = {
  streams?: ProbeStream[];
  format?: {
    format_name?: string;
    duration?: string;
  };
};

function reserveTempBudget(): () => void {
  const reservation = config.maxVideoBytes + config.maxImageBytes;
  if (reservation > config.mediaTempBudgetBytes || reservedTempBytes + reservation > config.mediaTempBudgetBytes) {
    throw new Error('Недостаточно временного дискового бюджета для обработки видео');
  }
  reservedTempBytes += reservation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedTempBytes = Math.max(0, reservedTempBytes - reservation);
  };
}

function chunkBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new Error('Видео upload содержит неподдерживаемый тип chunk');
}

function runTool(command: string, args: string[], context: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: config.mediaProcessingTimeoutMs,
      maxBuffer: TOOL_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '').trim();
        reject(new Error(`${context}: ${detail || 'процесс завершился с ошибкой'}`));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value || value === '0/0') return null;
  const match = value.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (match) {
    const denominator = Number(match[2]);
    const numerator = Number(match[1]);
    if (denominator > 0 && Number.isFinite(numerator)) {
      const result = numerator / denominator;
      return result > 0 && Number.isFinite(result) ? result : null;
    }
  }
  const numeric = Number(value);
  return numeric > 0 && Number.isFinite(numeric) ? numeric : null;
}

function parsePositiveSeconds(value: string | undefined): number | null {
  const parsed = Number(value);
  return parsed > 0 && Number.isFinite(parsed) ? parsed : null;
}

async function probeCanonicalVideo(videoPath: string, originalName: string): Promise<Omit<PreparedVideoUpload, 'tempVideoPath' | 'posterData' | 'sizeBytes' | 'sha256' | 'cleanup'>> {
  if (path.extname(originalName).toLowerCase() !== '.mp4') {
    throw new Error('Video v1 принимает только файлы с расширением .mp4');
  }
  const output = await runTool(config.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    videoPath
  ], 'ffprobe не смог прочитать видео');

  let probe: ProbeResult;
  try {
    probe = JSON.parse(output) as ProbeResult;
  } catch {
    throw new Error('ffprobe вернул некорректный JSON');
  }

  const formatNames = String(probe.format?.format_name || '').split(',').map((value) => value.trim().toLowerCase());
  if (!formatNames.includes('mp4')) throw new Error('Video v1 принимает только MP4 container');

  const videoStreams = (probe.streams || []).filter((stream) => stream.codec_type === 'video');
  if (videoStreams.length !== 1) throw new Error('Video v1 требует ровно один video stream');
  const video = videoStreams[0]!;
  if (String(video.codec_name || '').toLowerCase() !== 'h264') {
    throw new Error(`Video v1 поддерживает только H.264, получен ${video.codec_name || 'unknown'}`);
  }
  if (!Number.isInteger(video.width) || !Number.isInteger(video.height) || Number(video.width) <= 0 || Number(video.height) <= 0) {
    throw new Error('ffprobe не вернул корректные размеры video stream');
  }

  const audioStreams = (probe.streams || []).filter((stream) => stream.codec_type === 'audio');
  const unsupportedAudio = audioStreams.find((stream) => String(stream.codec_name || '').toLowerCase() !== 'aac');
  if (unsupportedAudio) {
    throw new Error(`Video v1 поддерживает AAC либо отсутствие аудио, получен ${unsupportedAudio.codec_name || 'unknown'}`);
  }

  const durationSeconds = parsePositiveSeconds(probe.format?.duration) ?? parsePositiveSeconds(video.duration);
  if (durationSeconds == null) throw new Error('ffprobe не вернул положительную длительность видео');
  const durationMs = Math.max(1, Math.round(durationSeconds * 1000));
  const fps = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate);

  return {
    width: Number(video.width),
    height: Number(video.height),
    durationMs,
    fps,
    videoCodec: 'h264',
    audioCodec: audioStreams.length ? 'aac' : null,
    container: 'mp4'
  };
}

async function generatePoster(videoPath: string, durationMs: number, posterPath: string): Promise<void> {
  const durationSeconds = durationMs / 1000;
  const seekSeconds = durationSeconds < 2 ? Math.max(0, durationSeconds / 2) : 1;
  const run = (seek: number) => runTool(config.ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', seek.toFixed(3),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '2',
    posterPath
  ], 'ffmpeg не смог создать poster');

  try {
    await run(seekSeconds);
  } catch (error) {
    if (seekSeconds === 0) throw error;
    await run(0);
  }
}

export async function prepareVideoUpload(originalName: string, input: AsyncIterable<unknown>): Promise<PreparedVideoUpload> {
  const releaseReservation = reserveTempBudget();
  await fs.mkdir(config.mediaTempDir, { recursive: true });
  const token = crypto.randomUUID();
  const tempVideoPath = path.join(config.mediaTempDir, `${token}.mp4`);
  const tempPosterPath = path.join(config.mediaTempDir, `${token}.poster.jpg`);
  let keepVideo = false;

  try {
    const hash = crypto.createHash('sha256');
    const file = await fs.open(tempVideoPath, 'wx');
    let sizeBytes = 0;
    try {
      for await (const rawChunk of input) {
        const chunk = chunkBuffer(rawChunk);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > config.maxVideoBytes) {
          throw new Error(`Видео больше допустимого лимита ${config.maxVideoBytes} байт`);
        }
        hash.update(chunk);
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
    if ((input as { truncated?: boolean }).truncated) throw new Error('Видео превышает multipart file-size limit');
    if (sizeBytes === 0) throw new Error('Видео файл пуст');

    const metadata = await probeCanonicalVideo(tempVideoPath, originalName);
    await generatePoster(tempVideoPath, metadata.durationMs, tempPosterPath);
    const posterData = await fs.readFile(tempPosterPath);
    if (!posterData.length) throw new Error('ffmpeg создал пустой poster');
    await fs.unlink(tempPosterPath).catch(() => undefined);
    keepVideo = true;

    let cleaned = false;
    return {
      tempVideoPath,
      posterData,
      sizeBytes,
      sha256: hash.digest('hex'),
      ...metadata,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await fs.unlink(tempVideoPath).catch(() => undefined);
        await fs.unlink(tempPosterPath).catch(() => undefined);
        releaseReservation();
      }
    };
  } catch (error) {
    await fs.unlink(tempPosterPath).catch(() => undefined);
    await fs.unlink(tempVideoPath).catch(() => undefined);
    releaseReservation();
    throw error;
  } finally {
    if (!keepVideo) await fs.unlink(tempPosterPath).catch(() => undefined);
  }
}

export async function cleanupVideoTemp(): Promise<void> {
  await fs.rm(config.mediaTempDir, { recursive: true, force: true });
  await fs.mkdir(config.mediaTempDir, { recursive: true });
  reservedTempBytes = 0;
}
