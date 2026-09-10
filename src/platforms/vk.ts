import fs from 'node:fs/promises';
import { mediaAbsolutePath } from '../media.js';
import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { PlatformError, requireString, responseJson } from './types.js';

const VK_RETRYABLE_CODES = new Set([1, 6, 9, 10, 29]);
const VK_REQUEST_TIMEOUT_MS = 30_000;

type VkCallOptions = {
  publicPost?: boolean;
};

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

function publicPostError(error: unknown, context: string): PlatformError {
  if (error instanceof PlatformError) return error;
  return new PlatformError(`${context}: ${error instanceof Error ? error.message : String(error)}`, {
    retryable: false,
    outcomeUnknown: true
  });
}

export async function vkCall(method: string, params: Record<string, string>, options: VkCallOptions = {}): Promise<any> {
  try {
    const body = new URLSearchParams(params);
    const response = await fetch(`https://api.vk.com/method/${method}`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(VK_REQUEST_TIMEOUT_MS)
    });
    const payload = await responseJson(response, `VK ${method}`);
    if (payload.error) {
      const code = Number(payload.error.error_code || 0);
      throw new PlatformError(`VK ${method}: ${code} ${payload.error.error_msg}`, {
        retryable: VK_RETRYABLE_CODES.has(code),
        outcomeUnknown: false,
        code
      });
    }
    return payload.response;
  } catch (error) {
    if (options.publicPost) throw publicPostError(error, `VK ${method}`);
    throw preparationError(error, `VK ${method} — подготовительная фаза`);
  }
}

async function readPublicationMedia(mediaPath: string): Promise<Buffer> {
  try {
    return await fs.readFile(mediaPath);
  } catch (error) {
    throw new PlatformError(`VK: локальное изображение недоступно до внешнего POST: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: false,
      outcomeUnknown: false
    });
  }
}

async function uploadWallImage(uploadUrl: string, bytes: Buffer): Promise<any> {
  try {
    const form = new FormData();
    form.set('photo', new Blob([bytes], { type: 'image/jpeg' }), 'image.jpg');
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(VK_REQUEST_TIMEOUT_MS)
    });
    return await responseJson(uploadResponse, 'VK upload image');
  } catch (error) {
    throw preparationError(error, 'VK upload image — подготовительная фаза');
  }
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
      if (!server?.upload_url) {
        throw new PlatformError('VK: photos.getWallUploadServer не вернул upload_url', {
          retryable: false,
          outcomeUnknown: false
        });
      }

      const bytes = await readPublicationMedia(mediaAbsolutePath(media));
      const uploaded = await uploadWallImage(String(server.upload_url), bytes);
      if (uploaded?.server === undefined || uploaded?.photo === undefined || uploaded?.hash === undefined) {
        throw new PlatformError(`VK upload image: неожиданный ответ ${JSON.stringify(uploaded)}`, {
          retryable: false,
          outcomeUnknown: false
        });
      }

      const saved = await vkCall('photos.saveWallPhoto', {
        ...common,
        group_id: groupId,
        server: String(uploaded.server),
        photo: String(uploaded.photo),
        hash: String(uploaded.hash)
      });
      const photo = saved?.[0];
      if (!photo?.id || photo.owner_id === undefined) {
        throw new PlatformError(`VK: photos.saveWallPhoto вернул неожиданный ответ: ${JSON.stringify(saved)}`, {
          retryable: false,
          outcomeUnknown: false
        });
      }
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
    }, { publicPost: true });
    const postId = posted?.post_id;
    if (!postId) {
      throw new PlatformError(`VK: wall.post не вернул post_id: ${JSON.stringify(posted)}`, {
        retryable: false,
        outcomeUnknown: true
      });
    }
    return {
      externalId: String(postId),
      externalUrl: `https://vk.com/wall${ownerId}_${postId}`,
      raw: posted
    };
  }
};
