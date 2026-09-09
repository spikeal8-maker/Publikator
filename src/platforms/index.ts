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

export function getPublisher(platform: Platform): SocialPublisher {
  return publishers[platform];
}
