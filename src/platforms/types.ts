import type { MediaRow } from '../media.js';
import type { Platform } from '../db.js';

export type PublishInput = {
  postId: string;
  title: string;
  text: string;
  media: MediaRow[];
  credentials: Record<string, unknown>;
  publicMediaUrls: string[];
};

export type PublishResult = {
  externalId: string;
  externalUrl?: string | null;
  raw?: unknown;
};

export interface SocialPublisher {
  platform: Platform;
  validate(input: PublishInput): void;
  publish(input: PublishInput): Promise<PublishResult>;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Не заполнено поле ${key}`);
  return value.trim();
}

export async function responseJson(response: Response, context: string): Promise<any> {
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`${context}: HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
