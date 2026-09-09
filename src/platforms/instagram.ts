import { config } from '../config.js';
import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { requireString, responseJson } from './types.js';

function graphVersion(credentials: Record<string, unknown>): string {
  return typeof credentials.graphVersion === 'string' && credentials.graphVersion.trim()
    ? credentials.graphVersion.trim()
    : config.metaGraphVersion;
}

export const instagramPublisher: SocialPublisher = {
  platform: 'instagram',
  validate(input) {
    requireString(input.credentials, 'accessToken');
    requireString(input.credentials, 'igUserId');
    if (input.media.length !== 1) throw new Error('Instagram: пока поддерживается ровно одно изображение на публикацию');
    if (!input.publicMediaUrls[0]?.startsWith('https://')) throw new Error('Instagram: PUBLIC_BASE_URL должен быть публичным HTTPS URL');
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    this.validate(input);
    const accessToken = requireString(input.credentials, 'accessToken');
    const igUserId = requireString(input.credentials, 'igUserId');
    const version = graphVersion(input.credentials);
    const base = `https://graph.facebook.com/${encodeURIComponent(version)}`;

    const createParams = new URLSearchParams({
      image_url: input.publicMediaUrls[0]!,
      caption: input.text,
      access_token: accessToken
    });
    const createResponse = await fetch(`${base}/${encodeURIComponent(igUserId)}/media`, { method: 'POST', body: createParams });
    const created = await responseJson(createResponse, 'Instagram create media container');
    if (!created.id) throw new Error(`Instagram: creation_id отсутствует: ${JSON.stringify(created)}`);

    const publishParams = new URLSearchParams({ creation_id: String(created.id), access_token: accessToken });
    const publishResponse = await fetch(`${base}/${encodeURIComponent(igUserId)}/media_publish`, { method: 'POST', body: publishParams });
    const published = await responseJson(publishResponse, 'Instagram media_publish');
    if (!published.id) throw new Error(`Instagram: media id отсутствует: ${JSON.stringify(published)}`);
    return { externalId: String(published.id), raw: { created, published, graphVersion: version } };
  }
};
