import crypto from 'node:crypto';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REQUEST_TIMEOUT_MS = 15_000;

export type GoogleServiceAccountCredentials = {
  type: 'service_account';
  client_email: string;
  private_key: string;
  token_uri?: string;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function normalizeGoogleServiceAccount(value: unknown): GoogleServiceAccountCredentials {
  const row = asRecord(value, 'Google service account JSON');
  if (row.type !== 'service_account') throw new Error('Google credential type must be service_account');
  const clientEmail = String(row.client_email ?? '').trim();
  const privateKey = String(row.private_key ?? '').trim();
  const tokenUri = String(row.token_uri ?? GOOGLE_TOKEN_URL).trim();
  if (!/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/i.test(clientEmail)) throw new Error('Google service account client_email is invalid');
  if (!privateKey.includes('BEGIN PRIVATE KEY') || privateKey.length > 32 * 1024) throw new Error('Google service account private_key is invalid');
  if (tokenUri !== GOOGLE_TOKEN_URL) throw new Error('Only the standard Google OAuth token endpoint is allowed');
  return { type: 'service_account', client_email: clientEmail, private_key: privateKey, token_uri: GOOGLE_TOKEN_URL };
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

export async function googleFetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Google API request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function googleServiceAccountAccessToken(credentialsRaw: unknown, scope: string): Promise<string> {
  const credentials = normalizeGoogleServiceAccount(credentialsRaw);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope,
    aud: GOOGLE_TOKEN_URL,
    iat: now - 30,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  let signature: string;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
  } catch {
    throw new Error('Google service account private_key could not sign an OAuth assertion');
  }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${signature}`
  });
  const response = await googleFetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== 'string') throw new Error(`Google OAuth failed (HTTP ${response.status})`);
  return payload.access_token;
}

export function googleBearerHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, accept: 'application/json' };
}
