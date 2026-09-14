import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { mediaAbsolutePath, type MediaRow } from '../media.js';

export const TELEGRAM_STORY_VIDEO_MAX_BYTES = 30 * 1024 * 1024;
export const TELEGRAM_STORY_VIDEO_WIDTH = 720;
export const TELEGRAM_STORY_VIDEO_HEIGHT = 1280;
export const TELEGRAM_STORY_VIDEO_MAX_DURATION_MS = 60_000;
const STORY_RENDITION_TARGET_BYTES = 24 * 1024 * 1024;
const STORY_RENDITION_MAX_VIDEO_BITRATE = 4_000_000;
const STORY_RENDITION_AUDIO_BITRATE = 128_000;
const STORY_RENDITION_MIN_VIDEO_BITRATE = 400_000;
const TOOL_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const FASTSTART_SCAN_BYTES = 8 * 1024 * 1024;

export type TelegramStoryVideoRendition = {
  path: string;
  sizeBytes: number;
  durationSeconds: number;
  hasAudio: boolean;
  cleanup: () => Promise<void>;
};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
};

type ProbeResult = {
  streams?: ProbeStream[];
  format?: {
    format_name?: string;
    duration?: string;
  };
};

let transcodeTail = Promise.resolve();

async function serializedTranscode<T>(work: () => Promise<T>): Promise<T> {
  const previous = transcodeTail;
  let release!: () => void;
  transcodeTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
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

function canonicalStorySource(media: MediaRow): void {
  if (media.mime_type !== 'video/mp4') throw new Error(`Telegram STORY/VIDEO требует canonical video/mp4 source, получен ${media.mime_type}`);
  if (!media.duration_ms || media.duration_ms <= 0) throw new Error('Telegram STORY/VIDEO требует известную положительную duration');
  if (media.duration_ms > TELEGRAM_STORY_VIDEO_MAX_DURATION_MS) {
    throw new Error(`Telegram STORY/VIDEO duration ${media.duration_ms} ms превышает предел ${TELEGRAM_STORY_VIDEO_MAX_DURATION_MS} ms`);
  }
  if (media.video_codec?.toLowerCase() !== 'h264') {
    throw new Error(`Telegram STORY/VIDEO rendition ожидает canonical H.264 source, получен ${media.video_codec || 'unknown'}`);
  }
  if (media.audio_codec && media.audio_codec.toLowerCase() !== 'aac') {
    throw new Error(`Telegram STORY/VIDEO rendition ожидает AAC либо отсутствие audio, получен ${media.audio_codec}`);
  }
  if (media.container?.toLowerCase() !== 'mp4') {
    throw new Error(`Telegram STORY/VIDEO rendition ожидает MP4 source, получен ${media.container || 'unknown'}`);
  }
}

function videoBitrateFor(durationMs: number, hasAudio: boolean): number {
  const seconds = Math.max(1, durationMs / 1000);
  const totalBudgetBitrate = Math.floor((STORY_RENDITION_TARGET_BYTES * 8) / seconds);
  const audioBudget = hasAudio ? STORY_RENDITION_AUDIO_BITRATE : 0;
  return Math.max(
    STORY_RENDITION_MIN_VIDEO_BITRATE,
    Math.min(STORY_RENDITION_MAX_VIDEO_BITRATE, totalBudgetBitrate - audioBudget)
  );
}

async function probeRendition(filePath: string): Promise<{ durationSeconds: number; hasAudio: boolean }> {
  const output = await runTool(config.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], 'Telegram STORY/VIDEO ffprobe');
  const probe = JSON.parse(output) as ProbeResult;
  const formats = String(probe.format?.format_name || '').split(',').map((item) => item.trim().toLowerCase());
  if (!formats.includes('mp4')) throw new Error('Telegram STORY/VIDEO rendition не является MP4');

  const videoStreams = (probe.streams || []).filter((stream) => stream.codec_type === 'video');
  if (videoStreams.length !== 1) throw new Error('Telegram STORY/VIDEO rendition должна иметь ровно один video stream');
  const video = videoStreams[0]!;
  if (String(video.codec_name || '').toLowerCase() !== 'hevc') {
    throw new Error(`Telegram STORY/VIDEO rendition должна быть H.265/HEVC, получен ${video.codec_name || 'unknown'}`);
  }
  if (video.width !== TELEGRAM_STORY_VIDEO_WIDTH || video.height !== TELEGRAM_STORY_VIDEO_HEIGHT) {
    throw new Error(`Telegram STORY/VIDEO rendition должна быть ${TELEGRAM_STORY_VIDEO_WIDTH}x${TELEGRAM_STORY_VIDEO_HEIGHT}, получен ${video.width || 0}x${video.height || 0}`);
  }

  const audioStreams = (probe.streams || []).filter((stream) => stream.codec_type === 'audio');
  if (audioStreams.length > 1) throw new Error('Telegram STORY/VIDEO rendition содержит больше одного audio stream');
  if (audioStreams[0] && String(audioStreams[0].codec_name || '').toLowerCase() !== 'aac') {
    throw new Error(`Telegram STORY/VIDEO audio должно быть AAC, получен ${audioStreams[0].codec_name || 'unknown'}`);
  }

  const durationSeconds = Number(probe.format?.duration || 0);
  if (!(durationSeconds > 0 && durationSeconds <= 60.05)) {
    throw new Error(`Telegram STORY/VIDEO rendition duration ${durationSeconds} s вне диапазона 0-60 s`);
  }
  return { durationSeconds, hasAudio: audioStreams.length === 1 };
}

async function assertKeyframeCadence(filePath: string): Promise<void> {
  const output = await runTool(config.ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-skip_frame', 'nokey',
    '-show_entries', 'frame=best_effort_timestamp_time',
    '-of', 'csv=p=0',
    filePath
  ], 'Telegram STORY/VIDEO keyframe probe');
  const timestamps = output
    .split(/\r?\n/)
    .map((value) => Number(value.trim().replace(/,$/, '')))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length || timestamps[0]! > 0.1) throw new Error('Telegram STORY/VIDEO rendition не содержит начальный keyframe');
  for (let index = 1; index < timestamps.length; index += 1) {
    const interval = timestamps[index]! - timestamps[index - 1]!;
    if (interval > 1.15) throw new Error(`Telegram STORY/VIDEO keyframe interval ${interval.toFixed(3)} s превышает 1 секунду с допуском`);
  }
}

async function assertFastStart(filePath: string): Promise<void> {
  const file = await fs.open(filePath, 'r');
  try {
    const stat = await file.stat();
    const length = Math.min(stat.size, FASTSTART_SCAN_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, 0);
    const moov = buffer.indexOf(Buffer.from('moov'));
    const mdat = buffer.indexOf(Buffer.from('mdat'));
    if (moov < 0 || mdat < 0 || moov > mdat) {
      throw new Error('Telegram STORY/VIDEO rendition не подтверждает faststart/streamable MP4');
    }
  } finally {
    await file.close();
  }
}

export async function prepareTelegramStoryVideo(media: MediaRow): Promise<TelegramStoryVideoRendition> {
  canonicalStorySource(media);
  return serializedTranscode(async () => {
    await fs.mkdir(config.mediaTempDir, { recursive: true });
    const outputPath = path.join(config.mediaTempDir, `telegram-story-${crypto.randomUUID()}.mp4`);
    let keep = false;
    try {
      const sourcePath = mediaAbsolutePath(media);
      await fs.access(sourcePath);
      const hasAudio = Boolean(media.audio_codec);
      const videoBitrate = videoBitrateFor(media.duration_ms!, hasAudio);
      const args = [
        '-nostdin',
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', sourcePath,
        '-map', '0:v:0',
        ...(hasAudio ? ['-map', '0:a:0'] : []),
        '-vf', `scale=${TELEGRAM_STORY_VIDEO_WIDTH}:${TELEGRAM_STORY_VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TELEGRAM_STORY_VIDEO_WIDTH}:${TELEGRAM_STORY_VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
        '-c:v', 'libx265',
        '-preset', 'superfast',
        '-pix_fmt', 'yuv420p',
        '-b:v', String(videoBitrate),
        '-maxrate', String(videoBitrate),
        '-bufsize', String(videoBitrate * 2),
        '-force_key_frames', 'expr:gte(t,n_forced*1)',
        '-tag:v', 'hvc1',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', String(STORY_RENDITION_AUDIO_BITRATE)] : ['-an']),
        '-movflags', '+faststart',
        '-f', 'mp4',
        outputPath
      ];
      await runTool(config.ffmpegPath, args, 'Telegram STORY/VIDEO H.265 transcode');

      const stat = await fs.stat(outputPath);
      if (stat.size <= 0) throw new Error('Telegram STORY/VIDEO rendition получилась пустой');
      if (stat.size > TELEGRAM_STORY_VIDEO_MAX_BYTES) {
        throw new Error(`Telegram STORY/VIDEO rendition ${stat.size} байт превышает предел ${TELEGRAM_STORY_VIDEO_MAX_BYTES} байт`);
      }
      const probe = await probeRendition(outputPath);
      await assertKeyframeCadence(outputPath);
      await assertFastStart(outputPath);
      keep = true;
      let cleaned = false;
      return {
        path: outputPath,
        sizeBytes: stat.size,
        durationSeconds: probe.durationSeconds,
        hasAudio: probe.hasAudio,
        cleanup: async () => {
          if (cleaned) return;
          cleaned = true;
          await fs.rm(outputPath, { force: true });
        }
      };
    } catch (error) {
      if (!keep) await fs.rm(outputPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}
