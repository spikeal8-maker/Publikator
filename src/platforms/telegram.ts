import fs from 'node:fs/promises';
import { mediaAbsolutePath } from '../media.js';
import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { PlatformError, requireString, responseJson } from './types.js';

const CAPTION_LIMIT = 1024;

function telegramError(body: any): PlatformError {
  const code = Number(body?.error_code || 0);
  return new PlatformError(`Telegram: ${body?.description || 'неизвестная ошибка'}`, {
    retryable: code === 429,
    outcomeUnknown: code >= 500,
    code
  });
}

async function sendMessage(token: string, chatId: string, text: string): Promise<any> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false })
  });
  const body = await responseJson(response, 'Telegram sendMessage');
  if (!body.ok) throw telegramError(body);
  return body.result;
}

export const telegramPublisher: SocialPublisher = {
  platform: 'telegram',
  validate(input) {
    requireString(input.credentials, 'botToken');
    requireString(input.credentials, 'chatId');
    if (input.media.length < 1) throw new Error('Telegram: требуется минимум одно изображение');
    if (input.media.length > 10) throw new Error('Telegram: в одной медиагруппе допускается не более 10 файлов');
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    this.validate(input);
    const token = requireString(input.credentials, 'botToken');
    const chatId = requireString(input.credentials, 'chatId');
    const caption = input.text.length <= CAPTION_LIMIT ? input.text : '';
    let result: any;

    if (input.media.length === 1) {
      const media = input.media[0]!;
      const data = new FormData();
      data.set('chat_id', chatId);
      data.set('caption', caption);
      data.set('photo', new Blob([await fs.readFile(mediaAbsolutePath(media))], { type: 'image/jpeg' }), media.original_name.replace(/\.[^.]+$/, '') + '.jpg');
      const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: data });
      const body = await responseJson(response, 'Telegram sendPhoto');
      if (!body.ok) throw telegramError(body);
      result = body.result;
    } else {
      const data = new FormData();
      data.set('chat_id', chatId);
      const descriptors = [];
      for (let index = 0; index < input.media.length; index += 1) {
        const media = input.media[index]!;
        const name = `media${index}`;
        data.set(name, new Blob([await fs.readFile(mediaAbsolutePath(media))], { type: 'image/jpeg' }), `${name}.jpg`);
        descriptors.push({ type: 'photo', media: `attach://${name}`, ...(index === 0 && caption ? { caption } : {}) });
      }
      data.set('media', JSON.stringify(descriptors));
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: data });
      const body = await responseJson(response, 'Telegram sendMediaGroup');
      if (!body.ok) throw telegramError(body);
      result = body.result?.[0];
    }

    if (input.text.length > CAPTION_LIMIT) {
      try {
        await sendMessage(token, chatId, input.text);
      } catch (error) {
        throw new PlatformError(`Telegram: изображение уже опубликовано, но дополнительный текст не отправлен: ${error instanceof Error ? error.message : String(error)}`, {
          outcomeUnknown: true
        });
      }
    }
    return { externalId: String(result?.message_id ?? 'unknown'), raw: result };
  }
};
