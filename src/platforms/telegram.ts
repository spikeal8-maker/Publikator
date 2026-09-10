import fs from 'node:fs/promises';
import { mediaAbsolutePath } from '../media.js';
import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { PlatformError, requireString, responseJson } from './types.js';

const CAPTION_LIMIT = 1024;
const MESSAGE_LIMIT = 4096;
const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;

function characterCount(value: string): number {
  return Array.from(value).length;
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

async function readMediaBytes(mediaPath: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const bytes = await fs.readFile(mediaPath);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
  } catch (error) {
    throw new PlatformError(`Telegram: локальное изображение недоступно до внешнего POST: ${error instanceof Error ? error.message : String(error)}`, {
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

export const telegramPublisher: SocialPublisher = {
  platform: 'telegram',
  validate(input) {
    requireString(input.credentials, 'botToken');
    requireString(input.credentials, 'chatId');
    if (input.media.length < 1) throw new Error('Telegram: требуется минимум одно изображение');
    if (input.media.length > 10) throw new Error('Telegram: в одной медиагруппе допускается не более 10 файлов');
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
    let result: any;

    if (input.media.length === 1) {
      const media = input.media[0]!;
      const bytes = await readMediaBytes(mediaAbsolutePath(media));
      const data = new FormData();
      data.set('chat_id', chatId);
      data.set('caption', caption);
      data.set('photo', new Blob([bytes], { type: 'image/jpeg' }), media.original_name.replace(/\.[^.]+$/, '') + '.jpg');
      const body = await telegramRequest(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        body: data
      }, 'Telegram sendPhoto');
      result = body.result;
    } else {
      const data = new FormData();
      data.set('chat_id', chatId);
      const descriptors = [];
      for (let index = 0; index < input.media.length; index += 1) {
        const media = input.media[index]!;
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
      result = body.result?.[0];
    }

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
