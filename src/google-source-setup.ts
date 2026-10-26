import { db } from './db.js';
import { normalizeGoogleServiceAccount } from './google-service-account.js';
import { inspectGoogleSpreadsheet, listGoogleSheetsConnectors, prepareGoogleSheetsConnector } from './google-sheets.js';
import { inspectGoogleDriveMedia, listGoogleDriveMediaConnectors, prepareGoogleDriveMediaConnector } from './google-drive-media.js';
import { createIngestionConnector, readIngestionConnectorCredentials } from './integration-security.js';

type SetupInput = {
  existingConnectorId?: unknown;
  credentials?: unknown;
  name?: unknown;
  spreadsheetId?: unknown;
  sheetName?: unknown;
  writeBack?: unknown;
  rootFolder?: unknown;
  mediaName?: unknown;
};
type Row = { id: string; type: string; enabled: number; config_json: string; credentials_encrypted: string };
function normalizedId(raw: unknown): string {
  const value = String(raw ?? '').trim();
  const match = value.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{10,200})(?:[/?#].*)?$/);
  const result = match?.[1] ?? value;
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(result)) throw new Error('Укажите ссылку на Google Таблицу или её ID.');
  return result;
}
function identity(input: SetupInput) {
  const reference = String(input.existingConnectorId ?? '').trim();
  if (reference) {
    if (input.credentials !== undefined) throw new Error('Выберите сохранённый аккаунт или новый JSON, а не оба сразу.');
    const row = db.prepare('SELECT id,type,enabled,config_json,credentials_encrypted FROM ingestion_connectors WHERE id=?').get(reference) as Row | undefined;
    if (!row || row.type !== 'google_sheets' || !row.enabled) throw new Error('Сохранённое подключение Google Таблицы не найдено или отключено.');
    const connector = listGoogleSheetsConnectors().find(item => item.id === row.id)!;
    if (input.spreadsheetId != null && normalizedId(input.spreadsheetId) !== connector.config.spreadsheetId) throw new Error('Адрес таблицы не совпадает с выбранным сохранённым подключением.');
    return { credentials: normalizeGoogleServiceAccount(readIngestionConnectorCredentials(reference)), existing: connector, row, spreadsheetId: connector.config.spreadsheetId };
  }
  return { credentials: normalizeGoogleServiceAccount(input.credentials), existing: null, row: null, spreadsheetId: normalizedId(input.spreadsheetId) };
}
function assertUnchanged(row: Row | null) {
  if (!row) return;
  const current = db.prepare('SELECT id,type,enabled,config_json,credentials_encrypted FROM ingestion_connectors WHERE id=?').get(row.id) as Row | undefined;
  if (!current || !current.enabled || current.type !== row.type || current.config_json !== row.config_json || current.credentials_encrypted !== row.credentials_encrypted) {
    throw new Error('Подключение изменилось во время проверки. Проверьте доступ заново.');
  }
}
function safeFailure(error: unknown, resource: 'sheet' | 'folder'): string {
  const message = error instanceof Error ? error.message : '';
  const label = resource === 'sheet' ? 'таблице' : 'папке';
  const api = resource === 'sheet' ? 'Google Sheets API' : 'Google Drive API';
  if (/HTTP 403|HTTP 404/.test(message)) return 'Нет доступа к ' + label + '. Выдайте доступ показанному email и проверьте ссылку. Если доступ есть, проверьте ' + api + ' в Google Cloud.';
  if (/OAuth|private_key|HTTP 401/.test(message)) return 'Google не принял ключ сервисного аккаунта. Проверьте JSON и срок действия ключа.';
  if (/timed out|fetch failed/i.test(message)) return 'Google не ответил вовремя. Повторите проверку.';
  return 'Не удалось проверить доступ к ' + label + '. Проверьте адрес, тип ресурса и разрешения сервисного аккаунта.';
}
export async function inspectGoogleSourceSetup(input: SetupInput) {
  const resolved = identity(input);
  const root = String(input.rootFolder ?? '').trim();
  const [sheet, folder] = await Promise.all([
    inspectGoogleSpreadsheet(resolved.credentials, resolved.spreadsheetId).then(value => {
      if (resolved.existing && !value.sheets.includes(resolved.existing.config.sheetName)) throw new Error('Configured sheet missing');
      return { ok: true as const, value };
    }).catch(error => ({ ok: false as const, message: safeFailure(error, 'sheet') })),
    root ? inspectGoogleDriveMedia(resolved.credentials, root).then(value => ({ ok: true as const, value })).catch(error => ({ ok: false as const, message: safeFailure(error, 'folder') })) : Promise.resolve(null)
  ]);
  assertUnchanged(resolved.row);
  return { serviceAccountEmail: resolved.credentials.client_email, spreadsheetId: resolved.spreadsheetId, sheet, folder, canSave: sheet.ok && (!folder || folder.ok) };
}
export async function saveGoogleSourceSetup(input: SetupInput) {
  const resolved = identity(input);
  const root = String(input.rootFolder ?? '').trim();
  const sheet = resolved.existing ? null : await prepareGoogleSheetsConnector({
    name: String(input.name ?? ''), spreadsheetId: resolved.spreadsheetId, sheetName: input.sheetName,
    writeBack: input.writeBack === true, credentials: resolved.credentials
  });
  if (resolved.existing) {
    const checked = await inspectGoogleSpreadsheet(resolved.credentials, resolved.spreadsheetId);
    if (!checked.sheets.includes(resolved.existing.config.sheetName)) throw new Error('Сохранённый лист не найден. Верните лист в таблицу перед подключением папки.');
  }
  const folder = root ? await prepareGoogleDriveMediaConnector({
    name: String(input.mediaName ?? ''), rootFolder: root, credentials: resolved.credentials
  }) : null;
  return db.transaction(() => {
    assertUnchanged(resolved.row);
    let sheetConnector = resolved.existing;
    if (sheet) {
      const prior = listGoogleSheetsConnectors().find(item => item.enabled &&
        item.config.spreadsheetId === sheet.config.spreadsheetId && item.config.sheetName === sheet.config.sheetName);
      if (prior && (prior.name !== sheet.name.trim() || prior.config.serviceAccountEmail !== sheet.config.serviceAccountEmail || prior.config.writeBack !== sheet.config.writeBack)) {
        throw new Error('Этот лист уже подключён. Выберите существующее подключение Google.');
      }
      sheetConnector = prior ?? { ...createIngestionConnector({ type: 'google_sheets', ...sheet }), config: sheet.config };
    }
    let mediaConnector: ReturnType<typeof listGoogleDriveMediaConnectors>[number] | null = null;
    if (folder) {
      const sameName = db.prepare('SELECT id,type,enabled FROM ingestion_connectors WHERE name=?').all(folder.name.trim()) as Array<{ id: string; type: string; enabled: number }>;
      const prior = listGoogleDriveMediaConnectors().find(item => item.enabled && item.name === folder.name.trim() &&
        item.config.rootFolderId === folder.config.rootFolderId && item.config.serviceAccountEmail === folder.config.serviceAccountEmail);
      if (sameName.length && (sameName.length !== 1 || sameName[0]!.id !== prior?.id)) throw new Error('Название папки уже используется другим подключением. Выберите другое название для колонки media.');
      mediaConnector = prior ?? { ...createIngestionConnector({ type: 'google_drive', ...folder }), config: folder.config };
    }
    return { sheetConnector, mediaConnector };
  })();
}
