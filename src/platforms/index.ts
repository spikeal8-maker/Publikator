import type { Platform } from '../db.js';
import type { SocialPublisher } from './types.js';
import { telegramPublisher } from './telegram.js';
import { vkPublisher } from './vk.js';
import { maxPublisher } from './max.js';
import { instagramPublisher } from './instagram.js';

const publishers: Record<Platform, SocialPublisher> = {
  telegram: telegramPublisher,
  vk: vkPublisher,
  max: maxPublisher,
  instagram: instagramPublisher
};

const testPublishers: Partial<Record<Platform, SocialPublisher>> = {};

export function setPublisherForTests(platform: Platform, publisher: SocialPublisher | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Подмена publisher разрешена только при NODE_ENV=test');
  if (publisher === null) {
    delete testPublishers[platform];
    return;
  }
  if (publisher.platform !== platform) throw new Error(`Mock publisher platform ${publisher.platform} не совпадает с ${platform}`);
  testPublishers[platform] = publisher;
}

export function getPublisher(platform: Platform): SocialPublisher {
  return testPublishers[platform] ?? publishers[platform];
}
