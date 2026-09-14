import type { PublishInput, PublishResult, SocialPublisher } from './types.js';
import { PlatformError, requireString, responseJson } from './types.js';

const STATUS_POLL_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 5 : 5_000;
const STATUS_WAIT_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? 250 : 90_000;
const INSTAGRAM_REEL_MIN_DURATION_MS = 3_000;
const INSTAGRAM_REEL_MAX_DURATION_MS = 15 * 60 * 1_000;
const INSTAGRAM_REEL_MAX_BYTES = 1024 * 1024 * 1024;
const INSTAGRAM_REEL_MIN_FPS = 23;
const INSTAGRAM_REEL_MAX_FPS = 60;
const INSTAGRAM_REEL_MAX_WIDTH = 1920;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isVideoPublication(input: PublishInput): boolean {
  return input.contentFormat === 'VIDEO' || input.contentFormat === 'VERTICAL_VIDEO';
}

function isShortVideoPublication(input: PublishInput): boolean {
  return input.publicationKind === 'SHORT' && input.contentFormat === 'VERTICAL_VIDEO';
}

function assertReelVideo(input: PublishInput) {
  if (input.contentFormat === 'VIDEO') {
    if (input.publicationKind && input.publicationKind !== 'FEED') {
      throw new Error(`Instagram: VIDEO поддерживается только как FEED/VIDEO, получен ${input.publicationKind}/${input.contentFormat}`);
    }
  } else if (input.contentFormat === 'VERTICAL_VIDEO') {
    if (input.publicationKind !== 'SHORT') {
      throw new Error(`Instagram: VERTICAL_VIDEO поддерживается только как SHORT/VERTICAL_VIDEO, получен ${input.publicationKind || 'FEED'}/${input.contentFormat}`);
    }
  } else {
    throw new Error(`Instagram: Reel ожидает FEED/VIDEO или SHORT/VERTICAL_VIDEO, получен ${input.publicationKind || 'FEED'}/${input.contentFormat || 'IMAGE'}`);
  }

  if (input.media.length !== 1) throw new Error('Instagram: Reel требует ровно один video asset');
  if (input.publicMediaUrls.length !== 1 || !validPublicHttpsUrl(input.publicMediaUrls[0]!)) {
    throw new Error('Instagram: Reel требует один публичный HTTPS video_url без credentials');
  }

  const media = input.media[0]!;
  if (media.mime_type !== 'video/mp4') throw new Error(`Instagram: Reel требует video/mp4, получен ${media.mime_type}`);
  if (media.size_bytes > INSTAGRAM_REEL_MAX_BYTES) {
    throw new Error(`Instagram: видео ${media.size_bytes} байт превышает предел 1 GB`);
  }
  if (media.video_codec && media.video_codec.toLowerCase() !== 'h264') {
    throw new Error(`Instagram: canonical video должен быть H.264, получен ${media.video_codec}`);
  }
  if (media.audio_codec && media.audio_codec.toLowerCase() !== 'aac') {
    throw new Error(`Instagram: canonical audio должен быть AAC либо отсутствовать, получен ${media.audio_codec}`);
  }
  if (media.container && media.container.toLowerCase() !== 'mp4') {
    throw new Error(`Instagram: canonical video container должен быть MP4, получен ${media.container}`);
  }
  if (media.duration_ms != null && media.duration_ms < INSTAGRAM_REEL_MIN_DURATION_MS) {
    throw new Error(`Instagram: Reel короче ${INSTAGRAM_REEL_MIN_DURATION_MS / 1000} секунд`);
  }
  if (media.duration_ms != null && media.duration_ms > INSTAGRAM_REEL_MAX_DURATION_MS) {
    throw new Error(`Instagram: Reel длиннее ${INSTAGRAM_REEL_MAX_DURATION_MS / 1000} секунд`);
  }
  if (media.fps != null && (media.fps < INSTAGRAM_REEL_MIN_FPS || media.fps > INSTAGRAM_REEL_MAX_FPS)) {
    throw new Error(`Instagram: Reel FPS ${media.fps} вне диапазона ${INSTAGRAM_REEL_MIN_FPS}-${INSTAGRAM_REEL_MAX_FPS}`);
  }
  if (media.width != null && media.width > INSTAGRAM_REEL_MAX_WIDTH) {
    throw new Error(`Instagram: ширина Reel ${media.width}px превышает ${INSTAGRAM_REEL_MAX_WIDTH}px`);
  }
  if (isShortVideoPublication(input) && media.width != null && media.height != null && media.height <= media.width) {
    throw new Error(`Instagram: SHORT/VERTICAL_VIDEO должен быть вертикальным, получен ${media.width}x${media.height}`);
  }
  return media;
}

function assertImagePublication(input: PublishInput): void {
  if (input.publicationKind && input.publicationKind !== 'FEED') {
    throw new Error(`Instagram: image publication поддерживается только как FEED, получен ${input.publicationKind}/${input.contentFormat || 'IMAGE'}`);
  }
  if (input.contentFormat && !['IMAGE', 'CAROUSEL'].includes(input.contentFormat)) {
    throw new Error(`Instagram: текущий adapter не поддерживает ${input.publicationKind || 'FEED'}/${input.contentFormat}`);
  }
  if (input.media.length < 1) throw new Error('Instagram: требуется минимум одно изображение');
  if (input.media.length > 10) throw new Error('Instagram: карусель поддерживает не более 10 изображений');
  if (input.publicMediaUrls.length !== input.media.length || input.publicMediaUrls.some((url) => !validPublicHttpsUrl(url))) {
    throw new Error('Instagram: PUBLIC_BASE_URL должен быть публичным HTTPS URL без credentials для каждого изображения');
  }
  for (const media of input.media) {
    if (media.mime_type !== 'image/jpeg') throw new Error('Instagram: публикационные изображения должны быть JPEG');
  }
}

function safePrePublishError(error: unknown, context: string): PlatformError {
  if (error instanceof PlatformError) {
    return new PlatformError(`${context}: ${error.message}`, {
      retryable: error.retryable || error.outcomeUnknown || (error.status !== undefined && (error.status === 408 || error.status >= 500)),
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

async function createContainer(base: string, igUserId: string, params: Record<string, string>): Promise<string> {
  try {
    const response = await fetch(`${base}/${encodeURIComponent(igUserId)}/media`, {
      method: 'POST',
      body: new URLSearchParams(params)
    });
    const body = await responseJson(response, 'Instagram create media container');
    if (!body.id) {
      throw new PlatformError(`Instagram create media container: container id отсутствует: ${JSON.stringify(body)}`, {
        retryable: false,
        outcomeUnknown: false
      });
    }
    return String(body.id);
  } catch (error) {
    throw safePrePublishError(error, 'Instagram container ещё не является публичной публикацией');
  }
}

async function containerStatus(base: string, accessToken: string, containerId: string): Promise<{ code: string; status: string }> {
  try {
    const url = new URL(`${base}/${encodeURIComponent(containerId)}`);
    url.searchParams.set('fields', 'status_code,status');
    url.searchParams.set('access_token', accessToken);
    const response = await fetch(url);
    const body = await responseJson(response, 'Instagram container status');
    return {
      code: String(body?.status_code || '').trim().toUpperCase(),
      status: String(body?.status || '').trim()
    };
  } catch (error) {
    throw safePrePublishError(error, 'Instagram status check не публикует media');
  }
}

async function waitForContainerReady(base: string, accessToken: string, containerId: string): Promise<void> {
  const deadline = Date.now() + STATUS_WAIT_TIMEOUT_MS;
  let lastCode = '';
  let lastStatus = '';

  while (true) {
    const current = await containerStatus(base, accessToken, containerId);
    lastCode = current.code;
    lastStatus = current.status;

    if (current.code === 'FINISHED') return;
    if (current.code === 'PUBLISHED') {
      throw new PlatformError(`Instagram container ${containerId} уже имеет status_code=PUBLISHED до текущего media_publish. Требуется ручная проверка.`, {
        retryable: false,
        outcomeUnknown: true
      });
    }
    if (current.code === 'ERROR' || current.code === 'EXPIRED') {
      throw new PlatformError(`Instagram container ${containerId}: ${current.code}${current.status ? ` — ${current.status}` : ''}`, {
        retryable: false,
        outcomeUnknown: false
      });
    }
    if (current.code && current.code !== 'IN_PROGRESS') {
      throw new PlatformError(`Instagram container ${containerId}: неизвестный status_code=${current.code}${current.status ? ` — ${current.status}` : ''}`, {
        retryable: false,
        outcomeUnknown: false
      });
    }
    if (Date.now() >= deadline) {
      throw new PlatformError(`Instagram container ${containerId} не стал FINISHED за ${Math.round(STATUS_WAIT_TIMEOUT_MS / 1000)} секунд${lastCode ? `; последний status_code=${lastCode}` : ''}${lastStatus ? ` — ${lastStatus}` : ''}`, {
        retryable: true,
        outcomeUnknown: false
      });
    }
    await sleep(STATUS_POLL_INTERVAL_MS);
  }
}

async function publishContainer(base: string, igUserId: string, accessToken: string, creationId: string): Promise<any> {
  try {
    const response = await fetch(`${base}/${encodeURIComponent(igUserId)}/media_publish`, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: creationId, access_token: accessToken })
    });
    return await responseJson(response, 'Instagram media_publish');
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError(`Instagram media_publish: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: false,
      outcomeUnknown: true
    });
  }
}

export const instagramPublisher: SocialPublisher = {
  platform: 'instagram',
  validate(input) {
    requireString(input.credentials, 'accessToken');
    requireString(input.credentials, 'igUserId');
    requireString(input.credentials, 'graphVersion');
    if (isVideoPublication(input)) assertReelVideo(input);
    else assertImagePublication(input);
  },
  async publish(input: PublishInput): Promise<PublishResult> {
    this.validate(input);
    const accessToken = requireString(input.credentials, 'accessToken');
    const igUserId = requireString(input.credentials, 'igUserId');
    const graphVersion = requireString(input.credentials, 'graphVersion');
    const base = `https://graph.facebook.com/${encodeURIComponent(graphVersion)}`;

    let creationId: string;
    const children: string[] = [];

    if (isVideoPublication(input)) {
      assertReelVideo(input);
      creationId = await createContainer(base, igUserId, {
        media_type: 'REELS',
        video_url: input.publicMediaUrls[0]!,
        caption: input.text,
        share_to_feed: isShortVideoPublication(input) ? 'false' : 'true',
        access_token: accessToken
      });
      await waitForContainerReady(base, accessToken, creationId);
    } else if (input.media.length === 1) {
      creationId = await createContainer(base, igUserId, {
        image_url: input.publicMediaUrls[0]!,
        caption: input.text,
        access_token: accessToken
      });
      await waitForContainerReady(base, accessToken, creationId);
    } else {
      for (const imageUrl of input.publicMediaUrls) {
        const childId = await createContainer(base, igUserId, {
          image_url: imageUrl,
          is_carousel_item: 'true',
          access_token: accessToken
        });
        children.push(childId);
        await waitForContainerReady(base, accessToken, childId);
      }

      creationId = await createContainer(base, igUserId, {
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption: input.text,
        access_token: accessToken
      });
      await waitForContainerReady(base, accessToken, creationId);
    }

    const published = await publishContainer(base, igUserId, accessToken, creationId);
    if (!published.id) {
      throw new PlatformError(`Instagram media_publish: media id отсутствует: ${JSON.stringify(published)}`, {
        retryable: false,
        outcomeUnknown: true
      });
    }
    return {
      externalId: String(published.id),
      raw: { creationId, children, published }
    };
  }
};
