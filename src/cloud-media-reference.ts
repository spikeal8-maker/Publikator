export type CloudMediaReference = {
  source: string;
  path: string;
};

export type ParsedCloudMediaReferences = {
  managed: boolean;
  references: CloudMediaReference[];
};

const MAX_REFERENCES = 20;
const MAX_PATH_LENGTH = 512;
const MAX_SOURCE_LENGTH = 120;

function normalizeRelativePath(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > MAX_PATH_LENGTH) throw new Error(`media path must be 1-${MAX_PATH_LENGTH} characters`);
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) throw new Error(`media path must be relative: ${raw}`);
  if (raw.includes('\\')) throw new Error(`media path must use '/' separators: ${raw}`);
  if(/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('media path contains control characters');
  const segments = raw.split('/');
  if (segments.length > 20 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`media path is invalid: ${raw}`);
  }
  return segments.join('/');
}

function normalizeSource(value: unknown): string {
  const source = String(value ?? '').trim();
  if (!source || source.length > MAX_SOURCE_LENGTH || /[\u0000-\u001f\u007f]/.test(source)) {
    throw new Error(`media source must be 1-${MAX_SOURCE_LENGTH} printable characters`);
  }
  return source;
}

export function parseCloudMediaReferences(cell: unknown): ParsedCloudMediaReferences {
  const text = String(cell ?? '').trim();
  if (!text) return { managed: false, references: [] };
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('media must be a JSON array like [{"source":"ASA Media","path":"lesson.jpg"}]'); }
  if (!Array.isArray(value)) throw new Error('media must be a JSON array');
  if (value.length > MAX_REFERENCES) throw new Error(`media supports at most ${MAX_REFERENCES} references per row`);
  const seen = new Set<string>();
  const references: CloudMediaReference[] = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`media[${index}] must be an object`);
    const row = item as Record<string, unknown>;
    const source = normalizeSource(row.source);
    const relativePath = normalizeRelativePath(row.path);
    const key = `${source}\u0000${relativePath}`;
    if (seen.has(key)) throw new Error(`media contains duplicate reference: ${source}/${relativePath}`);
    seen.add(key);
    return { source, path: relativePath };
  });
  return { managed: true, references };
}
