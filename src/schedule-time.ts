export type AmbiguousTimeChoice = 'earlier' | 'later' | string;

export type ResolvedSchedule = {
  scheduledAtUtc: string;
  scheduleTimezone: string;
  offset: string;
};

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const OFFSET_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/i;

export function normalizeIanaTimezone(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('scheduleTimezone is required');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid IANA timezone: ${value}`);
  }
}
function parseLocalDateTime(value: string): LocalParts {
  const match = LOCAL_DATE_TIME.exec(value.trim());
  if (!match) throw new Error('Local time must be YYYY-MM-DDTHH:mm[:ss] without offset');
  const parts: LocalParts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? '0')
  };
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  if (probe.getUTCFullYear() !== parts.year || probe.getUTCMonth() + 1 !== parts.month ||
      probe.getUTCDate() !== parts.day || probe.getUTCHours() !== parts.hour ||
      probe.getUTCMinutes() !== parts.minute || probe.getUTCSeconds() !== parts.second) {
    throw new Error('Local date/time is invalid');
  }
  return parts;
}

function partsAt(epochMs: number, timezone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const values = Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour) % 24, minute: Number(values.minute), second: Number(values.second) };
}
function sameParts(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function offsetMinutesAt(epochMs: number, timezone: string): number {
  const parts = partsAt(epochMs, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60000);
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function candidateInstants(local: LocalParts, timezone: string): Array<{ epochMs: number; offset: string }> {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const offsets = new Set<number>();
  for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) {
    offsets.add(offsetMinutesAt(naive + deltaHours * 3_600_000, timezone));
  }
  return [...offsets].map((offsetMinutes) => ({
    epochMs: naive - offsetMinutes * 60_000,
    offset: formatOffset(offsetMinutes)
  })).filter((candidate) => sameParts(partsAt(candidate.epochMs, timezone), local))
    .sort((a, b) => a.epochMs - b.epochMs);
}
export function resolveLocalSchedule(
  localDateTime: string,
  timezoneRaw: string,
  ambiguousChoice?: AmbiguousTimeChoice
): ResolvedSchedule {
  const scheduleTimezone = normalizeIanaTimezone(timezoneRaw);
  const local = parseLocalDateTime(localDateTime);
  const candidates = candidateInstants(local, scheduleTimezone);
  if (candidates.length === 0) throw new Error('Local time does not exist in this timezone because of DST');
  if (candidates.length > 1) {
    let selected;
    if (ambiguousChoice === 'earlier') selected = candidates[0];
    else if (ambiguousChoice === 'later') selected = candidates.at(-1);
    else if (typeof ambiguousChoice === 'string') selected = candidates.find((item) => item.offset === ambiguousChoice);
    if (!selected) {
      throw new Error(`Local time is ambiguous; choose one offset: ${candidates.map((item) => item.offset).join(', ')}`);
    }
    return { scheduledAtUtc: new Date(selected.epochMs).toISOString(), scheduleTimezone, offset: selected.offset };
  }
  const selected = candidates[0]!;
  return { scheduledAtUtc: new Date(selected.epochMs).toISOString(), scheduleTimezone, offset: selected.offset };
}

export function resolveExactSchedule(instantRaw: string, timezoneRaw = 'UTC'): ResolvedSchedule {
  const value = instantRaw.trim();
  if (!OFFSET_SUFFIX.test(value)) throw new Error('Exact scheduledAt must include Z or an explicit UTC offset');
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) throw new Error('scheduledAt is invalid');
  const scheduleTimezone = normalizeIanaTimezone(timezoneRaw);
  return { scheduledAtUtc: new Date(epochMs).toISOString(), scheduleTimezone, offset: formatOffset(offsetMinutesAt(epochMs, scheduleTimezone)) };
}
export function resolveScheduleInput(params: {
  scheduledAt?: unknown;
  scheduledAtLocal?: unknown;
  scheduleTimezone?: unknown;
  ambiguousOffset?: unknown;
}): ResolvedSchedule {
  const timezone = typeof params.scheduleTimezone === 'string' && params.scheduleTimezone.trim()
    ? params.scheduleTimezone : 'UTC';
  const exact = typeof params.scheduledAt === 'string' ? params.scheduledAt.trim() : '';
  const local = typeof params.scheduledAtLocal === 'string' ? params.scheduledAtLocal.trim() : '';
  if (exact && local) throw new Error('Use either scheduledAt or scheduledAtLocal, not both');
  if (local) return resolveLocalSchedule(local, timezone,
    typeof params.ambiguousOffset === 'string' ? params.ambiguousOffset : undefined);
  if (!exact) throw new Error('AT schedule requires scheduledAt or scheduledAtLocal');
  return resolveExactSchedule(exact, timezone);
}
