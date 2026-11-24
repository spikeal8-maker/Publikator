import { maxFetch } from './max-transport.js';
import { openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import { mediaAbsolutePath } from '../media.js';
import type { MediaRow } from '../media.js';
import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { PlatformError, requireString } from './types.js';
import { compileLiteralPlainText } from '../platform-text.js';

const MAX_TEXT_LENGTH = 4000;
const MAX_ATTACHMENTS = 12;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_TIMEOUT_MS = 120_000;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_VIDEO_UPLOAD_TIMEOUT_MS = 120_000;
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
      && !url.port
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

// Provider messages, response bodies, URLs and exception strings may contain
// bot or attachment tokens. Persist only locally constructed diagnostics.
function preparationError(error: unknown, context: string): PlatformError {
  if (error instanceof PlatformError) {
    return new PlatformError(`${context}: ${error.message}`, {
      retryable: error.retryable || error.outcomeUnknown || error.status === 408 || (error.status !== undefined && error.status >= 500),
      outcomeUnknown: false,
      status: error.status,
      code: error.code
    });
  }
  return new PlatformError(`${context}: ошибка сети или чтения ответа MAX`, {
    retryable: true,
    outcomeUnknown: false
  });
}

function preparationHttpError(context: string, status: number): PlatformError {
  return new PlatformError(`${context}: HTTP ${status}`, {
    retryable: status === 408 || status === 425 || status === 429 || status >= 500,
    outcomeUnknown: false,
    status,
    code: `HTTP_${status}`
  });
}

async function readMaxObject(response: Response): Promise<Record<string, any> | null> {
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any> : null;
  } catch {
    return null;
  }
}

async function readPreparationObject(response: Response, context: string): Promise<Record<string, any>> {
  if (!response.ok) throw preparationHttpError(context, response.status);
  const body = await readMaxObject(response);
  if (!body) throw new PlatformError(`${context}: некорректный JSON-ответ MAX`, {
    retryable: true, outcomeUnknown: false, status: response.status
  });
  return body;
}

function attachmentNotReadyError(status: number): PlatformError {
  return new PlatformError(`MAX POST /messages: HTTP ${status} attachment.not.ready — вложение ещё обрабатывается`, {
    retryable: true,
    outcomeUnknown: false,
    status,
    code: 'attachment.not.ready'
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

function assertTextPublication(input: PublishInput): void {
  if (input.publicationKind && input.publicationKind !== 'FEED') throw new Error('MAX: текст без медиа поддерживается только в ленте');
  if (input.media.length !== 0) throw new Error('MAX: TEXT_ONLY не должен содержать медиа');
  if (!input.text.trim()) throw new Error('MAX: текст публикации пуст');
}

function assertImagePublication(input: PublishInput): void {
  if (input.publicationKind && input.publicationKind !== 'FEED') throw new Error('MAX: изображения поддерживаются только в ленте');
  if (input.contentFormat && !['IMAGE', 'CAROUSEL'].includes(input.contentFormat)) {
    throw new Error(`MAX: текущий adapter не поддерживает ${input.publicationKind || 'FEED'}/${input.contentFormat}`);
  }
  if (input.media.length < 1) throw new Error('MAX: требуется минимум одно изображение');
  if (input.media.length > MAX_ATTACHMENTS) throw new Error(`MAX: не более ${MAX_ATTACHMENTS} вложений в одном сообщении`);
  for (const media of input.media) {
    if (media.mime_type === 'video/mp4' && input.contentFormat === 'CAROUSEL') {
      assertFeedVideo({ ...input, contentFormat: 'VIDEO', media: [media] });
    } else if (media.mime_type !== 'image/jpeg') throw new Error('Допустимы JPEG и MP4 в обычной публикации');
  }
  // Explicit legacy URL inputs remain supported. Ordinary publishing uploads local files.
  if (input.publicMediaUrls.length > 0 && input.publicMediaUrls.length !== input.media.length) {
    throw new Error('MAX: для каждого изображения должен существовать публичный media URL');
  }
  if (input.publicMediaUrls.some((url) => !validPublicHttpsUrl(url))) {
    throw new Error('MAX: каждый media URL должен быть корректным публичным HTTPS URL без credentials');
  }
}

async function prepareImagePayloads(accessToken: string, mediaRows: MediaRow[]): Promise<Array<{ type: string; payload: Record<string, string> }>> {
  // Validate every local file before creating any remote upload.
  const blobs: Blob[] = [];
  for (const media of mediaRows) {
    try {
      const absolutePath = mediaAbsolutePath(media);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) throw new Error('изображение отсутствует, пусто или превышает 50 MB');
      blobs.push(await openAsBlob(absolutePath, { type: 'image/jpeg' }));
    } catch (error) {
      throw new PlatformError(`MAX: локальное изображение недоступно до внешнего POST: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: false, outcomeUnknown: false
      });
    }
  }
  const attachments: Array<{ type: string; payload: Record<string, string> }> = [];
  for (let index = 0; index < mediaRows.length; index += 1) {
    try {
      const reservationResponse = await maxFetch('https://platform-api2.max.ru/uploads?type=image', {
        method: 'POST', headers: { Authorization: accessToken }, signal: AbortSignal.timeout(MAX_REQUEST_TIMEOUT_MS), redirect: 'error'
      });
      const reservation = await readPreparationObject(reservationResponse, 'MAX image upload reservation');
      const uploadUrl = typeof reservation?.url === 'string' ? reservation.url : '';
      let allowed = false;
      try {
        const url = new URL(uploadUrl);
        allowed = url.protocol === 'https:' && url.hostname === 'iu.oneme.ru' && !url.port
          && url.pathname === '/uploadImage' && !url.username && !url.password;
      } catch { /* No request to an unverified upload destination. */ }
      if (!allowed) throw new PlatformError('MAX: image upload URL не соответствует разрешённому HTTPS host iu.oneme.ru', { retryable: false, outcomeUnknown: false });
      const form = new FormData();
      form.set('data', blobs[index]!, mediaRows[index]!.original_name.replace(/\.[^.]+$/, '') + '.jpg');
      const uploadedResponse = await maxFetch(uploadUrl, {
        method: 'POST', body: form, signal: AbortSignal.timeout(MAX_IMAGE_UPLOAD_TIMEOUT_MS), redirect: 'error'
      });
      const uploaded = await readPreparationObject(uploadedResponse, 'MAX image upload');
      if (uploaded?.error) throw new PlatformError('MAX: сервер отклонил загрузку изображения', { retryable: false, outcomeUnknown: false });
      const photoTokens = uploaded?.photos && typeof uploaded.photos === 'object'
        ? Object.values(uploaded.photos).map((photo: any) => photo?.token).filter((token: unknown): token is string => typeof token === 'string' && token.length > 0)
        : [];
      const token = photoTokens.length === 1 ? photoTokens[0]
        : photoTokens.length === 0 && typeof uploaded?.token === 'string' ? uploaded.token : null;
      if (!token) throw new PlatformError('MAX: загрузка изображения не вернула единственный attachment token', { retryable: false, outcomeUnknown: false });
      attachments.push({ type: 'image', payload: { token } });
    } catch (error) {
      throw preparationError(error, 'MAX image upload — подготовительная фаза');
    }
  }
  return attachments;
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
    const response = await maxFetch('https://platform-api2.max.ru/uploads?type=video', {
      method: 'POST',
      headers: { Authorization: accessToken },
      signal: AbortSignal.timeout(MAX_REQUEST_TIMEOUT_MS)
    });
    const body = await readPreparationObject(response, 'MAX POST /uploads?type=video');
    const url = typeof body?.url === 'string' ? body.url : '';
    const token = typeof body?.token === 'string' && body.token ? body.token : null;
    if (!url) {
      throw new PlatformError('MAX: POST /uploads не вернул url', {
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
    const response = await maxFetch(uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(MAX_VIDEO_UPLOAD_TIMEOUT_MS)
    });
    if (!response.ok) throw preparationHttpError('MAX upload video', response.status);
    const raw = await response.text();
    let body: any;
    if (response.ok && /^\s*<retval>\s*1\s*<\/retval>\s*$/i.test(raw)) body = {};
    else {
      try { body = JSON.parse(raw); }
      catch { throw new PlatformError('MAX upload video: неподтверждённый ответ сервера загрузки', { retryable: true, outcomeUnknown: false, status: response.status }); }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new PlatformError('MAX upload video: некорректный ответ сервера загрузки', {
        retryable: true, outcomeUnknown: false, status: response.status
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
    throw new PlatformError('MAX upload video: сервер отклонил загрузку видео', {
      retryable: false,
      outcomeUnknown: false
    });
  }
  const token = reservation.token
    ?? (typeof uploaded?.token === 'string' && uploaded.token ? uploaded.token : null)
    ?? (typeof uploaded?.payload?.token === 'string' && uploaded.payload.token ? uploaded.payload.token : null);
  if (!token) {
    throw new PlatformError('MAX: после загрузки видео отсутствует attachment token', {
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
): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await maxFetch(`https://platform-api2.max.ru/messages?chat_id=${encodeURIComponent(chatId)}`, {
      method: 'POST',
      headers: {
        Authorization: accessToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text, format, attachments }),
      signal: AbortSignal.timeout(MAX_REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new PlatformError('MAX POST /messages: ошибка сети или тайм-аут, результат неизвестен', {
      retryable: false, outcomeUnknown: true
    });
  }
  const status = response.status;
  const message = `MAX POST /messages: HTTP ${status}`;
  // An ambiguous HTTP outcome always takes precedence over a provider body.
  // Never interpret an arbitrary error string as an explicit rejection.
  if (status === 408 || status >= 500) {
    throw new PlatformError(message, {
      retryable: false, outcomeUnknown: true, status, code: `HTTP_${status}`
    });
  }
  if (status === 425 || status === 429) {
    throw new PlatformError(message, {
      retryable: true, outcomeUnknown: false, status, code: status === 429 ? 'rate.limit' : 'HTTP_425'
    });
  }
  if (!response.ok) {
    if (status === 400) {
      const body = await readMaxObject(response);
      if (body?.code === 'attachment.not.ready') throw attachmentNotReadyError(status);
    }
    throw new PlatformError(message, {
      retryable: false, outcomeUnknown: status < 400, status, code: `HTTP_${status}`
    });
  }
  const body = await readMaxObject(response);
  if (!body || body.code || body.error) {
    throw new PlatformError(`${message}: неподтверждённый ответ MAX`, {
      retryable: false, outcomeUnknown: true, status
    });
  }
  return body;
}

async function prepareMixedPayloads(accessToken: string, mediaRows: MediaRow[]) {
  const attachments: Array<{ type: string; payload: Record<string, string> }> = [];
  for (const media of mediaRows) {
    if (media.mime_type === 'video/mp4') attachments.push({ type: 'video', payload: { token: await prepareVideoToken(accessToken, media) } });
    else attachments.push(...await prepareImagePayloads(accessToken, [media]));
  }
  return attachments;
}

export const maxPublisher: SocialPublisher = {
  platform: 'max',
  validate(input) {
    requireString(input.credentials, 'accessToken');
    requireString(input.credentials, 'chatId');
    if (input.contentFormat === 'TEXT_ONLY') assertTextPublication(input);
    else if (isVideoPublication(input)) assertFeedVideo(input);
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
    const attachments = input.contentFormat === 'TEXT_ONLY' ? []
      : isVideoPublication(input)
      ? [{ type: 'video', payload: { token: await prepareVideoToken(accessToken, assertFeedVideo(input)) } }]
      : input.media.some(media => media.mime_type === 'video/mp4')
        ? await prepareMixedPayloads(accessToken, input.media)
      : input.publicMediaUrls.length
        ? input.publicMediaUrls.map((url) => ({ type: 'image', payload: { url } }))
        : await prepareImagePayloads(accessToken, input.media);
    const compiled = maxCompiledText(input);
    let body: any;
    for (let attempt = 0; ; attempt++) {
      try { body = await postMessage(accessToken, chatId, compiled.text, compiled.format, attachments); break; }
      catch (error) {
        // MAX explicitly refused creation while processing this attachment.
        // Keep the same prepared token; never retry an unknown public outcome.
        if (!input.media.some(media => media.mime_type === 'video/mp4') || !(error instanceof PlatformError)
          || error.code !== 'attachment.not.ready' || error.outcomeUnknown || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000 * (2 ** attempt)));
      }
    }

    const message = body.message ?? body;
    const externalId = message?.body?.mid ?? message?.mid ?? message?.id ?? message?.message_id;
    if (!(typeof externalId === 'string' && externalId.trim()) && !(typeof externalId === 'number' && Number.isSafeInteger(externalId) && externalId > 0)) {
      throw new PlatformError('MAX: API не вернул идентификатор сообщения', {
        retryable: false,
        outcomeUnknown: true
      });
    }
    return { externalId: String(externalId), externalUrl: message?.link ?? message?.url ?? null, raw: body };
  }
};
