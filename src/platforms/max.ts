import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { PlatformError, requireString, responseJson } from './types.js';

const MAX_TEXT_LENGTH = 4000;
const MAX_ATTACHMENTS = 12;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

function characterCount(value: string): number {
  return Array.from(value).length;
}

function validPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const maxPublisher: SocialPublisher = {
  platform: 'max',
  validate(input) {
    requireString(input.credentials, 'accessToken');
    requireString(input.credentials, 'chatId');
    if (input.media.length < 1) throw new Error('MAX: требуется минимум одно изображение');
    if (input.media.length > MAX_ATTACHMENTS) throw new Error(`MAX: не более ${MAX_ATTACHMENTS} вложений в одном сообщении`);
    const textLength = characterCount(input.text);
    if (textLength > MAX_TEXT_LENGTH) {
      throw new Error(`MAX: текст ${textLength} символов превышает предел ${MAX_TEXT_LENGTH}. Сократите текст или задайте отдельный override для MAX.`);
    }
    if (input.publicMediaUrls.length !== input.media.length) {
      throw new Error('MAX: для каждого изображения должен существовать публичный media URL');
    }
    if (input.publicMediaUrls.some((url) => !validPublicHttpsUrl(url))) {
      throw new Error('MAX: каждый media URL должен быть корректным публичным HTTPS URL без credentials');
    }
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    this.validate(input);
    const accessToken = requireString(input.credentials, 'accessToken');
    const chatId = requireString(input.credentials, 'chatId');

    let body: any;
    try {
      const response = await fetch(`https://platform-api2.max.ru/messages?chat_id=${encodeURIComponent(chatId)}`, {
        method: 'POST',
        headers: {
          Authorization: accessToken,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          text: input.text,
          attachments: input.publicMediaUrls.map((url) => ({ type: 'image', payload: { url } }))
        }),
        signal: AbortSignal.timeout(MAX_REQUEST_TIMEOUT_MS)
      });
      body = await responseJson(response, 'MAX POST /messages');
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError(`MAX POST /messages: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: false,
        outcomeUnknown: true
      });
    }

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
