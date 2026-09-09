import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { requireString, responseJson } from './types.js';

async function createContainer(base: string, igUserId: string, params: Record<string, string>): Promise<string> {
  const response = await fetch(`${base}/${encodeURIComponent(igUserId)}/media`, {
    method: 'POST',
    body: new URLSearchParams(params)
  });
  const body = await responseJson(response, 'Instagram create media container');
  if (!body.id) throw new Error(`Instagram: container id отсутствует: ${JSON.stringify(body)}`);
  return String(body.id);
}

async function publishContainer(base: string, igUserId: string, accessToken: string, creationId: string): Promise<any> {
  const response = await fetch(`${base}/${encodeURIComponent(igUserId)}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: creationId, access_token: accessToken })
  });
  return responseJson(response, 'Instagram media_publish');
}

export const instagramPublisher: SocialPublisher = {
  platform: 'instagram',
  validate(input) {
    requireString(input.credentials, 'accessToken');
    requireString(input.credentials, 'igUserId');
    requireString(input.credentials, 'graphVersion');
    if (input.media.length < 1) throw new Error('Instagram: требуется минимум одно изображение');
    if (input.media.length > 10) throw new Error('Instagram: карусель поддерживает не более 10 изображений');
    if (input.publicMediaUrls.length !== input.media.length || input.publicMediaUrls.some((url) => !url.startsWith('https://'))) {
      throw new Error('Instagram: PUBLIC_BASE_URL должен быть публичным HTTPS URL для каждого изображения');
    }
    for (const media of input.media) {
      if (media.mime_type !== 'image/jpeg') throw new Error('Instagram: публикационные изображения должны быть JPEG');
    }
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    this.validate(input);
    const accessToken = requireString(input.credentials, 'accessToken');
    const igUserId = requireString(input.credentials, 'igUserId');
    const graphVersion = requireString(input.credentials, 'graphVersion');
    const base = `https://graph.facebook.com/${encodeURIComponent(graphVersion)}`;

    let creationId: string;
    let children: string[] = [];

    if (input.media.length === 1) {
      creationId = await createContainer(base, igUserId, {
        image_url: input.publicMediaUrls[0]!,
        caption: input.text,
        access_token: accessToken
      });
    } else {
      for (const imageUrl of input.publicMediaUrls) {
        const childId = await createContainer(base, igUserId, {
          image_url: imageUrl,
          is_carousel_item: 'true',
          access_token: accessToken
        });
        children.push(childId);
      }

      creationId = await createContainer(base, igUserId, {
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption: input.text,
        access_token: accessToken
      });
    }

    const published = await publishContainer(base, igUserId, accessToken, creationId);
    if (!published.id) throw new Error(`Instagram: media id отсутствует: ${JSON.stringify(published)}`);
    return {
      externalId: String(published.id),
      raw: { creationId, children, published }
    };
  }
};
