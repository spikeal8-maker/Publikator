import fs from 'node:fs/promises';
import { mediaAbsolutePath } from '../media.js';
import type { MediaRow } from '../media.js';
import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { PlatformError, requireString, responseJson } from './types.js';

const VK_RETRYABLE_CODES = new Set([1, 6, 9, 10, 29]);
const VK_REQUEST_TIMEOUT_MS = 30_000;

type VkCallOptions = {
  publicPost?: boolean;
};

function isVideoPublication(input: PublishInput): boolean {
  return input.contentFormat === 'VIDEO';
}

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

async function readPublicationMedia(mediaPath: string, label = 'изображение'): Promise<Buffer> {
  try {
    return await fs.readFile(mediaPath);
  } catch (error) {
    throw new PlatformError(`VK: локальное ${label} недоступно до внешнего POST: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: false,
      outcomeUnknown: false
    });
  }
}

async function uploadWallImage(uploadUrl: string, bytes: Buffer): Promise<any> {
  try {
    const blobBytes = new Uint8Array(bytes.byteLength);
    blobBytes.set(bytes);
    const form = new FormData();
    form.set('photo', new Blob([blobBytes], { type: 'image/jpeg' }), 'image.jpg');
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

async function uploadVideoFile(uploadUrl: string, bytes: Buffer, originalName: string): Promise<any> {
  try {
    const blobBytes = new Uint8Array(bytes.byteLength);
    blobBytes.set(bytes);
    const form = new FormData();
    const filename = originalName.toLowerCase().endsWith('.mp4') ? originalName : `${originalName}.mp4`;
    form.set('video_file', new Blob([blobBytes], { type: 'video/mp4' }), filename);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(VK_REQUEST_TIMEOUT_MS)
    });
    const uploaded = await responseJson(uploadResponse, 'VK upload video');
    if (uploaded?.error) {
      throw new PlatformError(`VK upload video: ${typeof uploaded.error === 'string' ? uploaded.error : JSON.stringify(uploaded.error)}`, {
        retryable: false,
        outcomeUnknown: false
      });
    }
    return uploaded;
  } catch (error) {
    throw preparationError(error, 'VK upload video — подготовительная фаза');
  }
}

function assertFeedVideo(input: PublishInput): MediaRow {
  if (input.publicationKind && input.publicationKind !== 'FEED') {
    throw new Error(`VK: CX3-008C поддерживает только FEED/VIDEO, получен ${input.publicationKind}/${input.contentFormat}`);
  }
  if (input.media.length !== 1) throw new Error('VK: FEED/VIDEO требует ровно один video asset');
  const media = input.media[0]!;
  if (media.mime_type !== 'video/mp4') throw new Error(`VK: FEED/VIDEO требует video/mp4, получен ${media.mime_type}`);
  if (media.video_codec && media.video_codec.toLowerCase() !== 'h264') {
    throw new Error(`VK: canonical video должен быть H.264, получен ${media.video_codec}`);
  }
  if (media.audio_codec && media.audio_codec.toLowerCase() !== 'aac') {
    throw new Error(`VK: canonical audio должен быть AAC либо отсутствовать, получен ${media.audio_codec}`);
  }
  if (media.container && media.container.toLowerCase() !== 'mp4') {
    throw new Error(`VK: canonical video container должен быть MP4, получен ${media.container}`);
  }
  return media;
}

function assertImagePublication(input: PublishInput): void {
  if (input.contentFormat && !['IMAGE', 'CAROUSEL'].includes(input.contentFormat)) {
    throw new Error(`VK: текущий adapter не поддерживает ${input.publicationKind || 'FEED'}/${input.contentFormat}`);
  }
  if (input.media.length < 1) throw new Error('VK: требуется минимум одно изображение');
  for (const media of input.media) {
    if (media.mime_type !== 'image/jpeg') throw new Error(`VK: image publication требует image/jpeg, получен ${media.mime_type}`);
  }
}

async function prepareImageAttachments(
  input: PublishInput,
  common: Record<string, string>,
  groupId: string
): Promise<string[]> {
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
  return attachments;
}

async function prepareVideoAttachment(
  input: PublishInput,
  common: Record<string, string>,
  groupId: string
): Promise<string> {
  const media = assertFeedVideo(input);
  const bytes = await readPublicationMedia(mediaAbsolutePath(media), 'видео');
  const saved = await vkCall('video.save', {
    ...common,
    group_id: groupId,
    name: input.title,
    wallpost: '0'
  });
  if (!saved?.upload_url || saved.video_id === undefined || saved.owner_id === undefined) {
    throw new PlatformError(`VK: video.save вернул неполный ответ: ${JSON.stringify(saved)}`, {
      retryable: false,
      outcomeUnknown: false
    });
  }

  const videoId = Number(saved.video_id);
  const ownerId = Number(saved.owner_id);
  if (!Number.isInteger(videoId) || videoId < 1 || !Number.isInteger(ownerId) || ownerId === 0) {
    throw new PlatformError(`VK: video.save вернул некорректные owner_id/video_id: ${JSON.stringify(saved)}`, {
      retryable: false,
      outcomeUnknown: false
    });
  }

  const uploaded = await uploadVideoFile(String(saved.upload_url), bytes, media.original_name);
  if (uploaded?.video_id !== undefined && Number(uploaded.video_id) !== videoId) {
    throw new PlatformError(`VK upload video: video_id ${uploaded.video_id} не совпадает с video.save ${videoId}`, {
      retryable: false,
      outcomeUnknown: false
    });
  }
  if (uploaded?.size !== undefined && (!Number.isFinite(Number(uploaded.size)) || Number(uploaded.size) <= 0)) {
    throw new PlatformError(`VK upload video: сервер вернул некорректный size ${uploaded.size}`, {
      retryable: false,
      outcomeUnknown: false
    });
  }
  return `video${ownerId}_${videoId}`;
}

export const vkPublisher: SocialPublisher = {
  platform: 'vk',
  validate(input) {
    requireString(input.credentials, 'accessToken');
    requireString(input.credentials, 'groupId');
    if (isVideoPublication(input)) assertFeedVideo(input);
    else assertImagePublication(input);
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    this.validate(input);
    const accessToken = requireString(input.credentials, 'accessToken');
    const groupId = requireString(input.credentials, 'groupId').replace(/^-/, '');
    const apiVersion = typeof input.credentials.apiVersion === 'string' && input.credentials.apiVersion ? input.credentials.apiVersion : '5.199';
    const common = { access_token: accessToken, v: apiVersion };
    const attachments = isVideoPublication(input)
      ? [await prepareVideoAttachment(input, common, groupId)]
      : await prepareImageAttachments(input, common, groupId);

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
