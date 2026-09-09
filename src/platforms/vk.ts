import fs from 'node:fs/promises';
import { mediaAbsolutePath } from '../media.js';
import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { requireString, responseJson } from './types.js';

async function vkCall(method: string, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams(params);
  const response = await fetch(`https://api.vk.com/method/${method}`, { method: 'POST', body });
  const payload = await responseJson(response, `VK ${method}`);
  if (payload.error) throw new Error(`VK ${method}: ${payload.error.error_code} ${payload.error.error_msg}`);
  return payload.response;
}

export const vkPublisher: SocialPublisher = {
  platform: 'vk',
  validate(input) {
    requireString(input.credentials, 'accessToken');
    requireString(input.credentials, 'groupId');
    if (input.media.length < 1) throw new Error('VK: требуется минимум одно изображение');
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    this.validate(input);
    const accessToken = requireString(input.credentials, 'accessToken');
    const groupId = requireString(input.credentials, 'groupId').replace(/^-/, '');
    const apiVersion = typeof input.credentials.apiVersion === 'string' && input.credentials.apiVersion ? input.credentials.apiVersion : '5.199';
    const common = { access_token: accessToken, v: apiVersion };
    const attachments: string[] = [];

    for (const media of input.media) {
      const server = await vkCall('photos.getWallUploadServer', { ...common, group_id: groupId });
      if (!server?.upload_url) throw new Error('VK: photos.getWallUploadServer не вернул upload_url');
      const form = new FormData();
      form.set('photo', new Blob([await fs.readFile(mediaAbsolutePath(media))], { type: 'image/jpeg' }), 'image.jpg');
      const uploadResponse = await fetch(server.upload_url, { method: 'POST', body: form });
      const uploaded = await responseJson(uploadResponse, 'VK upload image');
      const saved = await vkCall('photos.saveWallPhoto', {
        ...common,
        group_id: groupId,
        server: String(uploaded.server),
        photo: String(uploaded.photo),
        hash: String(uploaded.hash)
      });
      const photo = saved?.[0];
      if (!photo?.id || photo.owner_id === undefined) throw new Error(`VK: photos.saveWallPhoto вернул неожиданный ответ: ${JSON.stringify(saved)}`);
      attachments.push(`photo${photo.owner_id}_${photo.id}`);
    }

    const ownerId = `-${groupId}`;
    const posted = await vkCall('wall.post', {
      ...common,
      owner_id: ownerId,
      from_group: '1',
      message: input.text,
      attachments: attachments.join(','),
      guid: input.postId
    });
    const postId = posted?.post_id;
    if (!postId) throw new Error(`VK: wall.post не вернул post_id: ${JSON.stringify(posted)}`);
    return {
      externalId: String(postId),
      externalUrl: `https://vk.com/wall${ownerId}_${postId}`,
      raw: posted
    };
  }
};
