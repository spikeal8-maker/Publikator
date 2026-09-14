import fs from 'node:fs/promises';
import { mediaAbsolutePath } from '../media.js';
import type { MediaRow } from '../media.js';
import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { PlatformError, requireString, responseJson } from './types.js';

const CAPTION_LIMIT = 1024;
const MESSAGE_LIMIT = 4096;
const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;
const TELEGRAM_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

function characterCount(value: string): number {
  return Array.from(value).length;
}

function isVideoPublication(input: PublishInput): boolean {
  return input.contentFormat === 'VIDEO';
}

function telegramError(body: any): PlatformError {
  const code = Number(body?.error_code || 0);
  return new PlatformError(`Telegram: ${body?.description || 'неизвестная ошибка'}`, {
    retryable: code === 429,
    outcomeUnknown: code >= 500,
    code
  });
}

function publicPostError(error: unknown, context: string): PlatformError {
  if (error instanceof PlatformError) return error;
  return new PlatformError(`${context}: ${error instanceof Error ? error.message : String(error)}`, {
    retryable: false,
    outcomeUnknown: true
  });
}

async function readMediaBytes(mediaPath: string, maxBytes?: number): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const bytes = await fs.readFile(mediaPath);
    if (maxBytes != null && bytes.byteLength > maxBytes) {
      throw new PlatformError(`Telegram: локальный media превышает безопасный лимит ${maxBytes} байт до внешнего POST`, {
        retryable: false,
        outcomeUnknown: false
      });
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError(`Telegram: локальный media недоступен до внешнего POST: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: false,
      outcomeUnknown: false
    });
  }
}

async function telegramRequest(url: string, init: RequestInit, context: string): Promise<any> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS)
    });
    const body = await responseJson(response, context);
    if (!body.ok) throw telegramError(body);
    return body;
  } catch (error) {
    throw publicPostError(error, context);
  }
}

async function sendMessage(token: string, chatId: string, text: string): Promise<any> {
  const body = await telegramRequest(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false })
  }, 'Telegram sendMessage');
  return body.result;
}

function assertFeedVideo(input: PublishInput): MediaRow {
  if (input.publicationKind && input.publicationKind !== 'FEED') {
    throw new Error(`Telegram: CX3-008B поддерживает только FEED/VIDEO, получен ${input.publicationKind}/${input.contentFormat}`);
  }
  if (input.media.length !== 1) throw new Error('Telegram: FEED/VIDEO требует ровно один video asset');
  const media = input.media[0]!;
  if (media.mime_type !== 'video/mp4') throw new Error(`Telegram: FEED/VIDEO требует video/mp4, получен ${media.mime_type}`);
  if (media.size_bytes > TELEGRAM_VIDEO_MAX_BYTES) {
    throw new Error(`Telegram: видео ${media.size_bytes} байт превышает предел 50 MB`);
  }
  if (media.video_codec && media.video_codec.toLowerCase() !== 'h264') {
    throw new Error(`Telegram: canonical video должен быть H.264, получен ${media.video_codec}`);
  }
  if (media.audio_codec && media.audio_codec.toLowerCase() !== 'aac') {
    throw new Error(`Telegram: canonical audio должен быть AAC либо отсутствовать, получен ${media.audio_codec}`);
  }
  if (media.container && media.container.toLowerCase() !== 'mp4') {
    throw new Error(`Telegram: canonical video container должен быть MP4, получен ${media.container}`);
  }
  return media;
}

function assertImagePublication(input: PublishInput): void {
  if (input.contentFormat && !['IMAGE', 'CAROUSEL'].includes(input.contentFormat)) {
    throw new Error(`Telegram: текущий adapter не поддерживает ${input.publicationKind || 'FEED'}/${input.contentFormat}`);
  }
  if (input.media.length < 1) throw new Error('Telegram: требуется минимум одно изображение');
  if (input.media.length > TELEGRAM_MEDIA_GROUP_LIMIT) {
    throw new Error(`Telegram: в одной медиагруппе допускается не более ${TELEGRAM_MEDIA_GROUP_LIMIT} файлов`);
  }
  for (const media of input.media) {
    if (media.mime_type !== 'image/jpeg') {
      throw new Error(`Telegram: image publication требует image/jpeg, получен ${media.mime_type}`);
    }
  }
}

async function publishVideo(token: string, chatId: string, media: MediaRow, caption: string): Promise<any> {
  const bytes = await readMediaBytes(mediaAbsolutePath(media), TELEGRAM_VIDEO_MAX_BYTES);
  const data = new FormData();
  data.set('chat_id', chatId);
  data.set('caption', caption);
  data.set('supports_streaming', 'true');
  if (media.width && media.width > 0) data.set('width', String(media.width));
  if (media.height && media.height > 0) data.set('height', String(media.height));
  if (media.duration_ms && media.duration_ms > 0) {
    data.set('duration', String(Math.max(1, Math.round(media.duration_ms / 1000))));
  }
  const filename = media.original_name.toLowerCase().endsWith('.mp4') ? media.original_name : `${media.original_name}.mp4`;
  data.set('video', new Blob([bytes], { type: 'video/mp4' }), filename);
  const body = await telegramRequest(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: 'POST',
    body: data
  }, 'Telegram sendVideo');
  return body.result;
}

async function publishImages(token: string, chatId: string, mediaRows: MediaRow[], caption: string): Promise<any> {
  if (mediaRows.length === 1) {
    const media = mediaRows[0]!;
    const bytes = await readMediaBytes(mediaAbsolutePath(media));
    const data = new FormData();
    data.set('chat_id', chatId);
    data.set('caption', caption);
    data.set('photo', new Blob([bytes], { type: 'image/jpeg' }), media.original_name.replace(/\.[^.]+$/, '') + '.jpg');
    const body = await telegramRequest(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: data
    }, 'Telegram sendPhoto');
    return body.result;
  }

  const data = new FormData();
  data.set('chat_id', chatId);
  const descriptors = [];
  for (let index = 0; index < mediaRows.length; index += 1) {
    const media = mediaRows[index]!;
    const name = `media${index}`;
    const bytes = await readMediaBytes(mediaAbsolutePath(media));
    data.set(name, new Blob([bytes], { type: 'image/jpeg' }), `${name}.jpg`);
    descriptors.push({ type: 'photo', media: `attach://${name}`, ...(index === 0 && caption ? { caption } : {}) });
  }
  data.set('media', JSON.stringify(descriptors));
  const body = await telegramRequest(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
    method: 'POST',
    body: data
  }, 'Telegram sendMediaGroup');
  return body.result?.[0];
}

export const telegramPublisher: SocialPublisher = {
  platform: 'telegram',
  validate(input) {
    requireString(input.credentials, 'botToken');
    requireString(input.credentials, 'chatId');
    if (isVideoPublication(input)) assertFeedVideo(input);
    else assertImagePublication(input);
    const textLength = characterCount(input.text);
    if (textLength > MESSAGE_LIMIT) {
      throw new Error(`Telegram: текст ${textLength} символов превышает предел ${MESSAGE_LIMIT}. Сократите базовый текст или задайте отдельный текст Telegram.`);
    }
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    this.validate(input);
    const token = requireString(input.credentials, 'botToken');
    const chatId = requireString(input.credentials, 'chatId');
    const textLength = characterCount(input.text);
    const caption = textLength <= CAPTION_LIMIT ? input.text : '';
    const result = isVideoPublication(input)
      ? await publishVideo(token, chatId, assertFeedVideo(input), caption)
      : await publishImages(token, chatId, input.media, caption);

    if (!result?.message_id) {
      throw new PlatformError('Telegram: API подтвердил запрос, но не вернул message_id; автоматический повтор небезопасен', {
        retryable: false,
        outcomeUnknown: true
      });
    }

    if (textLength > CAPTION_LIMIT) {
      try {
        const textResult = await sendMessage(token, chatId, input.text);
        if (!textResult?.message_id) {
          throw new PlatformError('Telegram sendMessage: API не вернул message_id', {
            retryable: false,
            outcomeUnknown: true
          });
        }
      } catch (error) {
        throw new PlatformError(`Telegram: media уже опубликовано (message_id=${result.message_id}), но дополнительный текст не подтверждён: ${error instanceof Error ? error.message : String(error)}. Требуется ручная проверка, повтор всего target заблокирован.`, {
          retryable: false,
          outcomeUnknown: true
        });
      }
    }
    return { externalId: String(result.message_id), raw: result };
  }
};
