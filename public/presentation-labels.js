export const STATUS_LABELS = Object.freeze({
  DRAFT: 'Черновик',
  READY: 'Готово',
  PUBLISHING: 'Публикуется',
  PUBLISHED: 'Опубликовано',
  PARTIAL: 'Частично',
  FAILED: 'Ошибка',
  RETRY: 'Повтор',
  RECOVERY_NEEDED: 'Восстановление',
  IDEA: 'Идея',
  IN_REVIEW: 'На проверке',
  APPROVED: 'Одобрено',
  NEW: 'Новая',
  UPDATE: 'Изменена',
  UNCHANGED: 'Без изменений',
  CONFLICT: 'Конфликт',
  ERROR: 'Ошибка'
});

export const PUBLICATION_FORMAT_LABELS = Object.freeze({
  'FEED / IMAGE': 'Пост · Изображение',
  'FEED / VIDEO': 'Пост · Видео',
  'SHORT / VERTICAL_VIDEO': 'Короткое видео',
  'STORY / IMAGE': 'История · Изображение',
  'STORY / VIDEO': 'История · Видео',
  'STORY / STORY_SEQUENCE': 'Серия историй'
});

export const SOURCE_LABELS = Object.freeze({
  manual: 'Вручную',
  ai: 'ИИ',
  api: 'API',
  bundle: 'Пакет',
  sheets: 'Таблица',
  google_sheets: 'Google Sheets'
});

export function statusLabel(value) {
  const raw = String(value ?? '');
  return STATUS_LABELS[raw] || raw;
}

export function publicationFormatLabel(publicationKind, contentFormat) {
  const kind = String(publicationKind || 'FEED');
  const format = String(contentFormat || 'IMAGE');
  const key = `${kind} / ${format}`;
  return PUBLICATION_FORMAT_LABELS[key] || key;
}

export function sourceLabel(value) {
  const raw = String(value ?? '');
  return SOURCE_LABELS[raw] || raw;
}
