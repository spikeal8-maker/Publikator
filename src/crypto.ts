import crypto from 'node:crypto';
import { config } from './config.js';

const key = crypto.createHash('sha256').update(config.masterKey).digest();

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptJson<T>(payload: string): T {
  const [version, ivRaw, tagRaw, cipherRaw] = payload.split(':');
  if (version !== 'v1' || !ivRaw || !tagRaw || !cipherRaw) throw new Error('Unsupported encrypted payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(cipherRaw, 'base64url')),
    decipher.final()
  ]);
  return JSON.parse(plain.toString('utf8')) as T;
}

export function createSessionToken(): string {
  const expiresAt = Date.now() + config.sessionTtlMs;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const payload = `${expiresAt}.${nonce}`;
  const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expiresRaw, nonce, signature] = parts;
  if (!expiresRaw || !nonce || !signature) return false;
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  const payload = `${expiresRaw}.${nonce}`;
  const expected = crypto.createHmac('sha256', key).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function securePasswordEqual(input: string): boolean {
  const left = crypto.createHash('sha256').update(input).digest();
  const right = crypto.createHash('sha256').update(config.adminPassword).digest();
  return crypto.timingSafeEqual(left, right);
}
