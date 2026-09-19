import { openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import { mediaAbsolutePath } from '../media.js';
import type { MediaRow } from '../media.js';
import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { PlatformError, requireString, responseJson } from './types.js';
import { compileLiteralPlainText } from '../platform-text.js';

const MAX_TEXT_LENGTH = 4000;
const MAX_ATTACHMENTS = 12;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_VIDEO_UPLOAD_HOST = 'omub.okcdn.ru';

function characterCount(value: string): number {
  return Array.from(value).length;
}

function isVideoPublication(input: PublishInput): boolean {
  return input.contentFormat === 'VIDEO';
}

function validPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validVideoUploadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === MAX_VIDEO_UPLOAD_HOST
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function preparationError(error: unknown, context: string): PlatformError {
  if (error instanceof PlatformError) {
    return new PlatformError(`${context}: ${error.message}`, {
      retryable: error.retryable || error.outcomeUnknown || error.status === 408 || (error.status !== undefined && error.status >= 500),
      outcomeUnknown: false,
      status: error.status,
      code: error.code
    });
  }
  return new PlatformError(`${context}: ${error instanceof Error ? error.message : String(error)}`, {
    retryable: true,
    outcomeUnknown: false
  });
}

function attachmentNotReadyError(message: string, status?: number): PlatformError {
  return new PlatformError(message, {
    retryable: true,
    outcomeUnknown: false,
    status,
    code: 'attachment.not.ready'
  });
}

function normalizePublicPostError(error: unknown): PlatformError {
  if (error instanceof PlatformError) {
    if (error.code === 'attachment.not.ready' || /attachment\.not\.ready/.test(error.message)) {
      return attachmentNotReadyError(error.message, error.status);
    }
    return error;
  }
  return new PlatformError(`MAX POST /messages: ${error instanceof Error ? error.message : String(error)}`, {
    retryable: false,
    outcomeUnknown: true
  });
}

function assertFeedVideo(input: PublishInput): MediaRow {
  if (input.publicationKind && input.publicationKind !== 'FEED') {
    throw new Error(`MAX: CX3-008D поддерживает только FEED/VIDEO, получен ${input.publicationKind}/${input.contentFormat}`);
  }
  if (input.media.length !== 1) throw new Error('MAX: FEED/VIDEO требует ровно один video asset');
  const media = input.media[0]!;
  if (media.mime_type !== 'video/mp4') throw new Error(`MAX: FEED/VIDEO требует video/mp4, получен ${media.mime_type}`);
  if (media.size_bytes > MAX_VIDEO_BYTES) {
    throw new Error(`MAX: видео ${media.size_bytes} байт превышает предел 250 MB`);
  }
  if (media.video_codec && media.video_codec.toLowerCase() !== 'h264') {
    throw new Error(`MAX: canonical video должен быть H.264, получен ${media.video_codec}`);
  }
  if (media.audio_codec && media.audio_codec.toLowerCase() !== 'aac') {
    throw new Error(`MAX: canonical audio должен быть AAC либо отсутствовать, получен ${media.audio_codec}`);
  }
  if (media.container && media.container.toLowerCase() !== 'mp4') {
    throw new Error(`MAX: canonical video container должен быть MP4, получен ${media.container}`);
  }
  return media;
}

function assertImagePublication(input: PublishInput): void {
  if (input.contentFormat && !['IMAGE', 'CAROUSEL'].includes(input.contentFormat)) {
    throw new Error(`MAX: текущий adapter не поддерживает ${input.publicationKind || 'FEED'}/${input.contentFormat}`);
  }
  if (input.media.length < 1) throw new Error('MAX: требуется минимум одно изображение');
  if (input.media.length > MAX_ATTACHMENTS) throw new Error(`MAX: не более ${MAX_ATTACHMENTS} вложений в одном сообщении`);
  for (const media of input.media) {
    if (media.mime_type !== 'image/jpeg') throw new Error(`MAX: image publication требует image/jpeg, получен ${media.mime_type}`);
  }
  if (input.publicMediaUrls.length !== input.media.length) {
    throw new Error('MAX: для каждого изображения должен существовать публичный media URL');
  }
  if (input.publicMediaUrls.some((url) => !validPublicHttpsUrl(url))) {
    throw new Error('MAX: каждый media URL должен быть корректным публичным HTTPS URL без credentials');
  }
}

async function localVideoBlob(media: MediaRow): Promise<Blob> {
  const absolutePath = mediaAbsolutePath(media);
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) throw new Error('путь не является обычным файлом');
    if (stat.size <= 0) throw new Error('файл пуст');
    if (stat.size > MAX_VIDEO_BYTES) throw new Error(`файл ${stat.size} байт превышает предел 250 MB`);
    return await openAsBlob(absolutePath, { type: 'video/mp4' });
  } catch (error) {
    throw new PlatformError(`MAX: локальное видео недоступно до внешнего POST: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: false,
      outcomeUnknown: false
    });
  }
}

async function reserveVideoUpload(accessToken: string): Promise<{ url: string; token: string | null }> {
  try {
    const response = await fetch('https://platform-api2.max.ru/uploads?type=video', {
      method: 'POST',
      headers: { Authorization: accessToken },
      signal: AbortSignal.timeout(MAX_REQUEST_TIMEOUT_MS)
    });
    const body = await responseJson(response, 'MAX POST /uploads?type=video');
    if (!response.ok) {
      const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`;
      throw new PlatformError(`MAX POST /uploads?type=video: HTTP ${response.status}: ${body?.message || body?.code || 'ошибка подготовки upload'}`, {
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        outcomeUnknown: false,
        status: response.status,
        code
      });
    }
    const url = typeof body?.url === 'string' ? body.url : '';
    const token = typeof body?.token === 'string' && body.token ? body.token : null;
    if (!url) {
      throw new PlatformError(`MAX: POST /uploads не вернул url: ${JSON.stringify(body)}`, {
        retryable: false,
        outcomeUnknown: false,
        status: response.status
      });
    }
    if (!validVideoUploadUrl(url)) {
      throw new PlatformError(`MAX: video upload URL не соответствует разрешённому HTTPS host ${MAX_VIDEO_UPLOAD_HOST}`, {
        retryable: false,
        outcomeUnknown: false,
        status: response.status
      });
    }
    return { url, token };
  } catch (error) {
    throw preparationError(error, 'MAX video upload reservation — подготовительная фаза');
  }
}

async function uploadVideoFile(uploadUrl: string, media: MediaRow, blob: Blob): Promise<any> {
  try {
    const form = new FormData();
    const filename = media.original_name.toLowerCase().endsWith('.mp4') ? media.original_name : `${media.original_name}.mp4`;
    form.set('data', blob, filename);
    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(MAX_REQUEST_TIMEOUT_MS)
    });
    const body = await responseJson(response, 'MAX upload video');
    if (!response.ok) {
      const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`;
      throw new PlatformError(`MAX upload video: HTTP ${response.status}: ${body?.message || body?.code || 'ошибка upload host'}`, {
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        outcomeUnknown: false,
        status: response.status,
        code
      });
    }
    return body;
  } catch (error) {
    throw preparationError(error, 'MAX upload video — подготовительная фаза');
  }
}

async function prepareVideoToken(accessToken: string, media: MediaRow): Promise<string> {
  const blob = await localVideoBlob(media);
  const reservation = await reserveVideoUpload(accessToken);
  const uploaded = await uploadVideoFile(reservation.url, media, blob);
  if (uploaded?.error) {
    throw new PlatformError(`MAX upload video: ${typeof uploaded.error === 'string' ? uploaded.error : JSON.stringify(uploaded.error)}`, {
      retryable: false,
      outcomeUnknown: false
    });
  }
  const token = reservation.token
    ?? (typeof uploaded?.token === 'string' && uploaded.token ? uploaded.token : null)
    ?? (typeof uploaded?.payload?.token === 'string' && uploaded.payload.token ? uploaded.payload.token : null);
  if (!token) {
    throw new PlatformError(`MAX: после загрузки видео отсутствует attachment token: ${JSON.stringify(uploaded)}`, {
      retryable: false,
      outcomeUnknown: false
    });
  }
  return token;
}

function maxCompiledText(input: PublishInput): { text: string; format: 'html' } {
  const context = input.publicationKind === 'STORY' ? 'story_caption' : input.media.length ? 'media_caption' : 'text';
  const compilation = input.textCompilation ?? compileLiteralPlainText('max', input.text, context);
  if (compilation.platform !== 'max' || compilation.transport.kind !== 'max_html') {
    throw new Error('MAX: unsupported text compilation transport');
  }
  return { text: compilation.transport.text, format: compilation.transport.format };
}

async function postMessage(
  accessToken: string,
  chatId: string,
  text: string,
  format: 'html',
  attachments: Array<{ type: string; payload: Record<string, string> }>
): Promise<any> {
  try {
    const response = await fetch(`https://platform-api2.max.ru/messages?chat_id=${encodeURIComponent(chatId)}`, {
      method: 'POST',
      headers: {
        Authorization: accessToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text, format, attachments }),
      signal: AbortSignal.timeout(MAX_REQUEST_TIMEOUT_MS)
    });
    const body = await responseJson(response, 'MAX POST /messages');
    const code = typeof body?.code === 'string' ? body.code : null;
    const message = `MAX POST /messages: HTTP ${response.status}${code ? ` ${code}` : ''}: ${body?.message || body?.code || 'неизвестная ошибка'}`;

    if (code === 'attachment.not.ready') throw attachmentNotReadyError(message, response.status);
    if (response.status === 429 || code === 'rate.limit') {
      throw new PlatformError(message, {
        retryable: true,
        outcomeUnknown: false,
        status: response.status,
        code: code || 'rate.limit'
      });
    }
    if (response.status >= 500) {
      throw new PlatformError(message, {
        retryable: false,
        outcomeUnknown: true,
        status: response.status,
        code: code || undefined
      });
    }
    if (!response.ok || code) {
      throw new PlatformError(message, {
        retryable: false,
        outcomeUnknown: false,
        status: response.status,
        code: code || undefined
      });
    }
    return body;
  } catch (error) {
    throw normalizePublicPostError(error);
  }
}

export const maxPublisher: SocialPublisher = {
  platform: 'max',
  validate(input) {
    requireString(input.credentials, 'accessToken');
    requireString(input.credentials, 'chatId');
    if (isVideoPublication(input)) assertFeedVideo(input);
    else assertImagePublication(input);
    const textLength = characterCount(input.text);
    if (textLength > MAX_TEXT_LENGTH) {
      throw new Error(`MAX: текст ${textLength} символов превышает предел ${MAX_TEXT_LENGTH}. Сократите текст или задайте отдельный override для MAX.`);
    }
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    this.validate(input);
    const accessToken = requireString(input.credentials, 'accessToken');
    const chatId = requireString(input.credentials, 'chatId');
    const attachments = isVideoPublication(input)
      ? [{ type: 'video', payload: { token: await prepareVideoToken(accessToken, assertFeedVideo(input)) } }]
      : input.publicMediaUrls.map((url) => ({ type: 'image', payload: { url } }));
    const compiled = maxCompiledText(input);
    const body = await postMessage(accessToken, chatId, compiled.text, compiled.format, attachments);

    const message = body.message ?? body;
    const externalId = message?.body?.mid ?? message?.mid ?? message?.id ?? message?.message_id;
    if (!externalId) {
      throw new PlatformError(`MAX: API не вернул идентификатор сообщения: ${JSON.stringify(body)}`, {
        retryable: false,
        outcomeUnknown: true
      });
    }
    return { externalId: String(externalId), externalUrl: message?.link ?? message?.url ?? null, raw: body };
  }
};
