import crypto from 'node:crypto';
import { config } from './config.js';
import { db, nowIso } from './db.js';
import { verifySessionToken } from './crypto.js';

type Admin = {
  id: string;
  username: string;
  username_key: string;
  password_salt: string;
  password_hash: string;
  password_version: number;
};
type SetupMode = 'INITIAL' | 'RECOVER';

export class AdminAuthError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

const ownerId = 'owner';
const sessionPrefix = 'pa2_';
const setupTtlMs = 10 * 60 * 1000;

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function admin(): Admin | undefined {
  return db.prepare('SELECT * FROM admin_users WHERE id=?').get(ownerId) as Admin | undefined;
}

function normalizedUsername(value: unknown): { display: string; key: string } {
  if (typeof value !== 'string') throw new AdminAuthError('Введите логин.');
  const display = value.trim().normalize('NFKC');
  if (!/^[\p{L}\p{N}_.-]{3,48}$/u.test(display)) {
    throw new AdminAuthError('Логин: от 3 до 48 букв, цифр, точек, дефисов или подчёркиваний.');
  }
  return { display, key: display.toLowerCase() };
}

function validPassword(password: unknown, username: string): string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new AdminAuthError('Пароль должен содержать от 12 до 256 символов.');
  }
  if (password.toLowerCase() === username.toLowerCase()) {
    throw new AdminAuthError('Пароль не должен совпадать с логином.');
  }
  return password;
}

function passwordDigest(password: string, salt: string): string {
  return crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64, {
    N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  }).toString('hex');
}

function storedPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(24).toString('hex');
  return { salt, hash: passwordDigest(password, salt) };
}

function passwordMatches(password: string, user: Admin | undefined): boolean {
  // Perform the same KDF even for an unknown username.
  const salt = user?.password_salt ?? '1'.repeat(48);
  const actual = Buffer.from(passwordDigest(password, salt), 'hex');
  const expected = Buffer.from(user?.password_hash ?? '0'.repeat(128), 'hex');
  return crypto.timingSafeEqual(actual, expected) && Boolean(user);
}

function issueSession(version: number): string {
  const token = sessionPrefix + crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare(`INSERT INTO admin_sessions
    (token_hash,admin_id,password_version,expires_at,created_at) VALUES (?,?,?,?,?)`)
    .run(digest(token), ownerId, version, Date.now() + config.sessionTtlMs, nowIso());
  return token;
}

export function adminMode(): 'setup' | 'legacy' | 'login' {
  if (admin()) return 'login';
  return config.adminPassword ? 'legacy' : 'setup';
}

export function hasAdmin(): boolean { return Boolean(admin()); }

export function sessionAdmin(token: string | undefined): { username: string } | null {
  if (!token || !/^pa2_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = db.prepare(`SELECT u.username,u.password_version,s.password_version AS session_version,s.expires_at
    FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_id WHERE s.token_hash=?`)
    .get(digest(token)) as { username: string; password_version: number; session_version: number; expires_at: number } | undefined;
  if (!row || row.expires_at <= Date.now() || row.password_version !== row.session_version) return null;
  return { username: row.username };
}

export function revokeSession(token: string | undefined): void {
  if (token?.startsWith(sessionPrefix)) {
    db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(digest(token));
  }
}

/** HMAC-signed legacy cookies must be denylisted until expiry when logging out. */
export function isLegacySessionRevoked(token: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM admin_legacy_session_revocations WHERE token_hash=?')
    .get(digest(token)));
}

export function revokeLegacySession(token: string | undefined): void {
  if (!token || !verifySessionToken(token)) return;
  const expiresAt = Number(token.split('.')[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return;
  db.prepare('DELETE FROM admin_legacy_session_revocations WHERE expires_at<=?').run(Date.now());
  db.prepare('INSERT OR IGNORE INTO admin_legacy_session_revocations(token_hash,expires_at) VALUES (?,?)')
    .run(digest(token), expiresAt);
}

export function loginAdmin(username: unknown, password: unknown): string | null {
  const supplied = typeof username === 'string' ? username.trim().normalize('NFKC').toLowerCase() : '';
  const candidate = typeof password === 'string' && password.length <= 256 ? password : '';
  const user = db.prepare('SELECT * FROM admin_users WHERE username_key=?').get(supplied) as Admin | undefined;
  if (!passwordMatches(candidate, user)) return null;
  return issueSession(user!.password_version);
}

/** Only an operator with filesystem/process access may invoke this; never expose as an HTTP endpoint. */
export function createAdminSetupGrant(mode: SetupMode): string {
  const user = admin();
  if (mode === 'INITIAL' && (user || config.adminPassword)) {
    throw new AdminAuthError('Установка уже настроена. Для существующей установки используйте вход и перенос аккаунта.', 409);
  }
  if (mode === 'RECOVER' && !user) {
    throw new AdminAuthError('Учётная запись ещё не создана.', 409);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO admin_setup_grants(id,mode,token_hash,expires_at)
    VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET
    mode=excluded.mode,token_hash=excluded.token_hash,expires_at=excluded.expires_at`)
    .run(mode, digest(token), Date.now() + setupTtlMs);
  return token;
}

export function createOrRecoverAdmin(mode: SetupMode, grantToken: unknown, username: unknown, password: unknown, confirmation: unknown): string {
  // Reject unauthorized internet traffic before the expensive scrypt password KDF.
  // Recheck atomically below because a grant might be redeemed during hashing.
  if (typeof grantToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grantToken)) {
    throw new AdminAuthError('Ссылка настройки недействительна. Откройте новую ссылку из установщика.', 403);
  }
  const tokenHash = digest(grantToken);
  const precheck = db.prepare('SELECT mode,token_hash,expires_at FROM admin_setup_grants WHERE id=1')
    .get() as { mode: SetupMode; token_hash: string; expires_at: number } | undefined;
  if (!precheck || precheck.mode !== mode || precheck.expires_at <= Date.now()
    || !crypto.timingSafeEqual(Buffer.from(precheck.token_hash, 'hex'), Buffer.from(tokenHash, 'hex'))) {
    throw new AdminAuthError('Ссылка настройки истекла или уже использована.', 403);
  }
  const name = normalizedUsername(username);
  const pass = validPassword(password, name.display);
  if (pass !== confirmation) throw new AdminAuthError('Пароли не совпадают.');
  const credential = storedPassword(pass);
  return db.transaction(() => {
    const grant = db.prepare('SELECT mode,token_hash,expires_at FROM admin_setup_grants WHERE id=1')
      .get() as { mode: SetupMode; token_hash: string; expires_at: number } | undefined;
    if (!grant || grant.mode !== mode || grant.expires_at <= Date.now()
      || !crypto.timingSafeEqual(Buffer.from(grant.token_hash, 'hex'), Buffer.from(tokenHash, 'hex'))) {
      throw new AdminAuthError('Ссылка настройки истекла или уже использована.', 403);
    }
    const existing = admin();
    if (mode === 'INITIAL') {
      if (existing || config.adminPassword) throw new AdminAuthError('Администратор уже настроен.', 409);
      db.prepare(`INSERT INTO admin_users
        (id,username,username_key,password_salt,password_hash,password_version,created_at,updated_at)
        VALUES (?,?,?,?,?,1,?,?)`)
        .run(ownerId, name.display, name.key, credential.salt, credential.hash, nowIso(), nowIso());
    } else {
      if (!existing) throw new AdminAuthError('Администратор не найден.', 409);
      db.prepare(`UPDATE admin_users SET username=?,username_key=?,password_salt=?,password_hash=?,
        password_version=password_version+1,updated_at=? WHERE id=?`)
        .run(name.display, name.key, credential.salt, credential.hash, nowIso(), ownerId);
    }
    db.prepare('DELETE FROM admin_sessions').run();
    db.prepare('DELETE FROM admin_setup_grants WHERE id=1').run();
    return issueSession(admin()!.password_version);
  }).immediate();
}

export function migrateLegacyAdmin(username: unknown, password: unknown, confirmation: unknown): string {
  if (!config.adminPassword) throw new AdminAuthError('Перенос недоступен.', 409);
  const name = normalizedUsername(username);
  const pass = validPassword(password, name.display);
  if (pass !== confirmation) throw new AdminAuthError('Пароли не совпадают.');
  const credential = storedPassword(pass);
  return db.transaction(() => {
    if (admin()) throw new AdminAuthError('Администратор уже зарегистрирован.', 409);
    db.prepare(`INSERT INTO admin_users
      (id,username,username_key,password_salt,password_hash,password_version,created_at,updated_at)
      VALUES (?,?,?,?,?,1,?,?)`)
      .run(ownerId, name.display, name.key, credential.salt, credential.hash, nowIso(), nowIso());
    db.prepare('DELETE FROM admin_setup_grants').run();
    return issueSession(1);
  }).immediate();
}

export function changeAdminPassword(current: unknown, next: unknown, confirmation: unknown): string {
  const user = admin();
  if (!user || typeof current !== 'string' || !passwordMatches(current, user)) {
    throw new AdminAuthError('Текущий пароль указан неверно.', 401);
  }
  const pass = validPassword(next, user.username);
  if (pass !== confirmation) throw new AdminAuthError('Пароли не совпадают.');
  if (passwordMatches(pass, user)) throw new AdminAuthError('Новый пароль должен отличаться от текущего.');
  const credential = storedPassword(pass);
  return db.transaction(() => {
    const latest = admin();
    if (!latest || latest.password_version !== user.password_version) {
      throw new AdminAuthError('Учётная запись изменилась. Повторите вход.', 409);
    }
    db.prepare(`UPDATE admin_users SET password_salt=?,password_hash=?,
      password_version=password_version+1,updated_at=? WHERE id=?`)
      .run(credential.salt, credential.hash, nowIso(), ownerId);
    db.prepare('DELETE FROM admin_sessions').run();
    return issueSession(user.password_version + 1);
  }).immediate();
}
