import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { requireString, responseJson } from './types.js';

export const maxPublisher: SocialPublisher = {
  platform: 'max',
  validate(input) {
    requireString(input.credentials, 'accessToken');
    requireString(input.credentials, 'chatId');
    if (input.media.length < 1) throw new Error('MAX: требуется минимум одно изображение');
    if (input.media.length > 12) throw new Error('MAX: не более 12 вложений в одном сообщении');
    if (input.text.length > 4000) throw new Error('MAX: текст превышает 4000 символов');
    if (input.publicMediaUrls.some((url) => !url.startsWith('https://'))) throw new Error('MAX: PUBLIC_BASE_URL должен быть доступен по HTTPS');
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    this.validate(input);
    const accessToken = requireString(input.credentials, 'accessToken');
    const chatId = requireString(input.credentials, 'chatId');
    const response = await fetch(`https://platform-api2.max.ru/messages?chat_id=${encodeURIComponent(chatId)}`, {
      method: 'POST',
      headers: {
        Authorization: accessToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        text: input.text,
        attachments: input.publicMediaUrls.map((url) => ({ type: 'image', payload: { url } }))
      })
    });
    const body = await responseJson(response, 'MAX POST /messages');
    const message = body.message ?? body;
    const externalId = message?.body?.mid ?? message?.mid ?? message?.id ?? message?.message_id;
    if (!externalId) throw new Error(`MAX: API не вернул идентификатор сообщения: ${JSON.stringify(body)}`);
    return { externalId: String(externalId), externalUrl: message?.link ?? message?.url ?? null, raw: body };
  }
};
